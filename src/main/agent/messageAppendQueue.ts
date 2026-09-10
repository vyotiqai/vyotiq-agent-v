import { readdirSync, unlinkSync } from 'fs'
import { appendFile, open, readdir, rename, stat, unlink, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { logger } from '../../shared/logger'
import {
  bumpFailure,
  formatAppendFailure,
  withTransientAppendRetry,
  type DirAppendFailures
} from './appendRetry'

/** Rotate messages.jsonl once it grows past this size; the most recent tail is kept. */
export const MESSAGES_FILE_MAX_BYTES = 8 * 1024 * 1024
export const MESSAGES_FILE_KEEP_BYTES = 4 * 1024 * 1024
const MAX_MESSAGE_ARCHIVES = 5
const MESSAGE_ARCHIVE_PREFIX = 'messages.archive.'

/** Per-run-dir serialized message append chain — ordered, non-blocking. */
const appendChains = new Map<string, Promise<void>>()
/** Accumulated append failures per run dir, consumed by flushMessageAppends (throws). */
const failuresForFlush = new Map<string, DirAppendFailures>()
/**
 * Accumulated mid-run append failures per run dir, surfaced to the run as a
 * consumable notice. Reset only when the run reads the notice, so every batch of
 * failures (not just the first) is reported.
 */
const pendingNotices = new Map<string, DirAppendFailures>()

function recordAppendError(dir: string, err: unknown): void {
  bumpFailure(failuresForFlush, dir, err)
  bumpFailure(pendingNotices, dir, err)
}

function takeAppendError(dir: string): DirAppendFailures | undefined {
  const err = failuresForFlush.get(dir)
  if (err) failuresForFlush.delete(dir)
  return err
}

/** Consume the accumulated mid-run append failures for a run dir, if any. */
export function takeMessageAppendFailureNotice(dir: string): Error | undefined {
  const f = pendingNotices.get(dir)
  if (!f) return undefined
  pendingNotices.delete(dir)
  return formatAppendFailure('messages.jsonl', [f])
}

function throwIfAppendError(dir: string): void {
  const f = takeAppendError(dir)
  if (f) throw formatAppendFailure('messages.jsonl', [f])
}

export function enqueueMessageAppend(dir: string, line: string): Promise<void> {
  const path = join(dir, 'messages.jsonl')
  const prev = appendChains.get(dir) ?? Promise.resolve()
  const next = prev
    .then(() =>
      withTransientAppendRetry(async () => {
        await rotateMessagesFileIfNeeded(path, dir)
        await appendFile(path, line, 'utf8')
      })
    )
    .catch((err) => {
      recordAppendError(dir, err)
      logger.warn('Failed to append messages.jsonl', {
        scope: 'state',
        correlationId: basename(dir),
        err
      })
    })
    .finally(() => {
      if (appendChains.get(dir) === next) appendChains.delete(dir)
    })
  appendChains.set(dir, next)
  return next
}

/**
 * Serialize a whole-file rewrite behind queued appends. A read-modify-write that
 * races the chain would silently drop lines that were still buffered — including
 * the partial assistant message flushed on the terminal error paths.
 */
export function enqueueMessageRewrite(dir: string, rewrite: () => void): Promise<void> {
  const prev = appendChains.get(dir) ?? Promise.resolve()
  const next = prev
    .then(() => {
      rewrite()
    })
    .catch((err) => {
      recordAppendError(dir, err)
      logger.warn('Failed to rewrite messages.jsonl', {
        scope: 'state',
        correlationId: basename(dir),
        err
      })
    })
    .finally(() => {
      if (appendChains.get(dir) === next) appendChains.delete(dir)
    })
  appendChains.set(dir, next)
  return next
}

export async function flushMessageAppends(dir?: string): Promise<void> {
  if (dir) {
    await appendChains.get(dir)
    const f = failuresForFlush.get(dir)
    if (f) {
      failuresForFlush.delete(dir)
      throw formatAppendFailure('messages.jsonl', [f])
    }
    return
  }
  await Promise.all([...appendChains.values()])
  if (failuresForFlush.size === 0) return
  const all = [...failuresForFlush.values()]
  failuresForFlush.clear()
  throw formatAppendFailure('messages.jsonl', all)
}

/** @internal */
export function messageAppendChainSizeForTests(): number {
  return appendChains.size
}

function messageArchiveFilename(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${MESSAGE_ARCHIVE_PREFIX}${stamp}.jsonl`
}

/** Sorted oldest-first archive heads for messages.jsonl (stitched readers). */
export async function listMessageArchives(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir)
    return names
      .filter((name) => name.startsWith(MESSAGE_ARCHIVE_PREFIX) && name.endsWith('.jsonl'))
      .sort()
  } catch {
    return []
  }
}

/** Sync variant for sync stitched loaders. */
export function listMessageArchivesSync(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(MESSAGE_ARCHIVE_PREFIX) && name.endsWith('.jsonl'))
      .sort()
  } catch {
    return []
  }
}

/** Sync archive removal after a whole-file rewrite that already stitched them in. */
export function removeMessageArchivesSync(dir: string): void {
  for (const name of listMessageArchivesSync(dir)) {
    try {
      unlinkSync(join(dir, name))
    } catch {
      // best effort — an undeletable archive must not fail the rewrite
    }
  }
}

/** Async archive removal after a whole-file rewrite that already stitched them in. */
export async function removeMessageArchives(dir: string): Promise<void> {
  for (const name of await listMessageArchives(dir)) {
    try {
      await unlink(join(dir, name))
    } catch {
      // best effort — an undeletable archive must not fail the rewrite
    }
  }
}

async function enforceMessageArchiveCap(dir: string): Promise<void> {
  const archives = await listMessageArchives(dir)
  while (archives.length >= MAX_MESSAGE_ARCHIVES) {
    const oldest = archives.shift()
    if (!oldest) break
    try {
      await unlink(join(dir, oldest))
      logger.warn('Evicted oldest messages archive (archive cap exceeded)', {
        scope: 'state',
        code: 'MESSAGES_ARCHIVE_EVICTED',
        correlationId: basename(dir),
        filename: oldest
      })
    } catch {
      // best effort — an undeletable archive must not block the append chain
    }
  }
}

async function archiveDiscardedMessageHead(dir: string, head: string): Promise<void> {
  if (!head) return
  await enforceMessageArchiveCap(dir)
  const filename = messageArchiveFilename()
  const archivePath = join(dir, filename)
  const temp = `${archivePath}.tmp`
  await writeFile(temp, head, 'utf8')
  await rename(temp, archivePath)
  logger.info('Archived rotated messages head', {
    scope: 'state',
    code: 'MESSAGES_ARCHIVED',
    correlationId: basename(dir),
    filename,
    byteCount: Buffer.byteLength(head, 'utf8')
  })
}

/**
 * Rewrite messages.jsonl keeping only the recent tail once it exceeds the cap.
 * The discarded head moves to a timestamped archive so stitched readers
 * (loadMessages*) still see the full transcript. Runs inside the serialized
 * append chain so it stays single-writer safe.
 */
async function rotateMessagesFileIfNeeded(path: string, dir: string): Promise<void> {
  let size = 0
  try {
    size = (await stat(path)).size
  } catch {
    return // file does not exist yet — the append will create it
  }
  if (size <= MESSAGES_FILE_MAX_BYTES) return
  const targetSplit = size - MESSAGES_FILE_KEEP_BYTES
  if (targetSplit <= 0) return

  const handle = await open(path, 'r')
  let head = ''
  let tail = ''
  try {
    const headLen = Math.min(size, targetSplit)
    const headBuf = Buffer.alloc(headLen)
    await handle.read(headBuf, 0, headLen, 0)
    const lastNl = headBuf.lastIndexOf(0x0a)
    if (lastNl >= 0) {
      const splitAt = lastNl + 1
      head = headBuf.subarray(0, splitAt).toString('utf8')
      const tailLen = size - splitAt
      const tailBuf = Buffer.alloc(tailLen)
      await handle.read(tailBuf, 0, tailLen, splitAt)
      tail = tailBuf.toString('utf8')
    } else {
      // No newline in the head window — split at the first newline after it.
      const restLen = size - targetSplit
      const restBuf = Buffer.alloc(restLen)
      await handle.read(restBuf, 0, restLen, targetSplit)
      const firstNl = restBuf.indexOf(0x0a)
      if (firstNl < 0) return
      head = Buffer.concat([headBuf, restBuf.subarray(0, firstNl + 1)]).toString('utf8')
      tail = restBuf.subarray(firstNl + 1).toString('utf8')
    }
  } finally {
    await handle.close()
  }
  if (!head) return

  await archiveDiscardedMessageHead(dir, head)
  const temp = `${path}.tmp`
  await writeFile(temp, tail, 'utf8')
  await rename(temp, path)
  logger.info('Rotated messages.jsonl', {
    scope: 'state',
    code: 'MESSAGES_ROTATED',
    correlationId: basename(dir)
  })
}

export function resetMessageAppendQueueForTests(): void {
  appendChains.clear()
  failuresForFlush.clear()
  pendingNotices.clear()
}
