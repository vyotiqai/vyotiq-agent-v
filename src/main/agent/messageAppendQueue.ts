import { readdirSync, unlinkSync } from 'fs'
import { readdir, unlink } from 'fs/promises'
import { basename, join } from 'path'
import { logger } from '../../shared/logger'
import {
  bumpFailure,
  formatAppendFailure,
  withTransientAppendRetry,
  type DirAppendFailures
} from './appendRetry'
import { markRunStorageLost } from './eventAppendQueue'
import { appendToRunLog, resetRunLogStateForTests } from './jsonlRotation'

/**
 * Rotate messages.jsonl once it grows past this size; the most recent tail is
 * kept live and the head moves to an archive.
 *
 * Archives are never evicted. They ARE the transcript: an evicted archive
 * deleted conversation history, and — because the compaction watermark and the
 * rewind checkpoint anchors are absolute indices into the stitched transcript —
 * shifted every one of them, silently folding unsummarized turns out of the
 * model's context.
 */
export const MESSAGES_FILE_MAX_BYTES = 8 * 1024 * 1024
export const MESSAGES_FILE_KEEP_BYTES = 4 * 1024 * 1024
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


/** Consume the accumulated mid-run append failures for a run dir, if any. */
export function takeMessageAppendFailureNotice(dir: string): Error | undefined {
  const f = pendingNotices.get(dir)
  if (!f) return undefined
  pendingNotices.delete(dir)
  return formatAppendFailure('messages.jsonl', [f])
}


export function enqueueMessageAppend(dir: string, line: string): Promise<void> {
  const path = join(dir, 'messages.jsonl')
  const prev = appendChains.get(dir) ?? Promise.resolve()
  const next = prev
    .then(() =>
      withTransientAppendRetry(() =>
        appendToRunLog({
          path,
          data: line,
          maxBytes: MESSAGES_FILE_MAX_BYTES,
          keepBytes: MESSAGES_FILE_KEEP_BYTES,
          nextArchivePath: () => join(dir, messageArchiveFilename()),
          onRotated: ({ archivePath, headBytes }) =>
            logger.info('Rotated messages.jsonl', {
              scope: 'state',
              code: 'MESSAGES_ROTATED',
              correlationId: basename(dir),
              filename: basename(archivePath),
              byteCount: headBytes
            }),
          onRotateFailed: (err) =>
            logger.warn('messages.jsonl rotation failed; appending unrotated', {
              scope: 'state',
              code: 'MESSAGES_ROTATE_FAILED',
              correlationId: basename(dir),
              err
            })
        })
      )
    )
    .catch((err) => {
      recordAppendError(dir, err)
      markRunStorageLost(dir, err)
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

/** See eventAppendQueue's FLUSH_DRAIN_MAX_PASSES — appends enqueued during the
 * await chain onto a new promise a single snapshot never sees. */
const FLUSH_DRAIN_MAX_PASSES = 20

export async function flushMessageAppends(dir?: string): Promise<void> {
  if (dir) {
    for (let pass = 0; pass < FLUSH_DRAIN_MAX_PASSES; pass += 1) {
      const chain = appendChains.get(dir)
      if (!chain) break
      await chain
    }
    const f = failuresForFlush.get(dir)
    if (f) {
      failuresForFlush.delete(dir)
      throw formatAppendFailure('messages.jsonl', [f])
    }
    return
  }
  for (let pass = 0; pass < FLUSH_DRAIN_MAX_PASSES && appendChains.size > 0; pass += 1) {
    await Promise.all([...appendChains.values()])
  }
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

/**
 * Sorted oldest-first archive heads for messages.jsonl (stitched readers).
 * `strict` rethrows everything but a missing directory, so a transient readdir
 * failure cannot pass for "no archives" in front of a rewrite.
 */
export async function listMessageArchives(dir: string, strict = false): Promise<string[]> {
  try {
    const names = await readdir(dir)
    return names
      .filter((name) => name.startsWith(MESSAGE_ARCHIVE_PREFIX) && name.endsWith('.jsonl'))
      .sort()
  } catch (err) {
    if (strict && (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
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

export function resetMessageAppendQueueForTests(): void {
  appendChains.clear()
  failuresForFlush.clear()
  pendingNotices.clear()
  resetRunLogStateForTests()
}
