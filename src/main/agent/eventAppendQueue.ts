import { readdirSync } from 'fs'
import { appendFile, open, readdir, rename, stat, unlink, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { logger } from '../../shared/logger'
import {
  bumpFailure,
  formatAppendFailure,
  withTransientAppendRetry,
  type DirAppendFailures
} from './appendRetry'

/** Rotate events.jsonl once it grows past this size; the most recent tail is kept. */
export const EVENTS_FILE_MAX_BYTES = 2 * 1024 * 1024
export const EVENTS_FILE_KEEP_BYTES = 1024 * 1024
const MAX_EVENT_ARCHIVES = 5
const EVENT_ARCHIVE_PREFIX = 'events.archive.'
/**
 * Backpressure cap for the serialized append chain. In-flight output snapshots
 * repeat the whole accumulated buffer, so a stalled write (AV scan, transient
 * retry, slow rotation) would otherwise queue an O(N) chain of O(N) strings in
 * the main heap. Reconstructable snapshots are dropped past this budget;
 * durable state records always enqueue.
 */
export const EVENTS_PENDING_MAX_BYTES = 64 * 1024 * 1024
/** Effective cap — overridable by tests to avoid multi-MB fixtures. */
let pendingMaxBytes = EVENTS_PENDING_MAX_BYTES

/** @internal Test hook. */
export function setEventAppendPendingMaxBytesForTests(bytes: number | null): void {
  pendingMaxBytes = bytes ?? EVENTS_PENDING_MAX_BYTES
}

/**
 * Per-run-dir serialized append chain — ordered, non-blocking, single-writer safe.
 */
const appendChains = new Map<string, Promise<void>>()
/** Bytes of event lines enqueued but not yet written (or failed), per run dir. */
const pendingBytes = new Map<string, number>()
/** Dropped snapshot count per run dir — logged periodically, not per line. */
const droppedSnapshotCounts = new Map<string, number>()
/** Accumulated append failures per run dir, consumed by flushEventAppends (throws). */
const failuresForFlush = new Map<string, DirAppendFailures>()
/**
 * Accumulated mid-run append failures per run dir, surfaced to the run as a
 * consumable notice. Unlike failuresForFlush this is reset only when the run
 * reads the notice, so every batch of failures (not just the first) is reported.
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
export function takeEventAppendFailureNotice(dir: string): Error | undefined {
  const f = pendingNotices.get(dir)
  if (!f) return undefined
  pendingNotices.delete(dir)
  return formatAppendFailure('events.jsonl', [f])
}

function throwIfAppendError(dir: string): void {
  const f = takeAppendError(dir)
  if (f) throw formatAppendFailure('events.jsonl', [f])
}

function archiveFilename(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${EVENT_ARCHIVE_PREFIX}${stamp}.jsonl`
}

/** Sorted oldest-first archive heads for events.jsonl (rotation-tolerant readers). */
export async function listEventArchives(dir: string): Promise<string[]> {
  const names = await readdir(dir)
  return names
    .filter((name) => name.startsWith(EVENT_ARCHIVE_PREFIX) && name.endsWith('.jsonl'))
    .sort()
}

/** Sync variant for sync stitched loaders. */
export function listEventArchivesSync(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(EVENT_ARCHIVE_PREFIX) && name.endsWith('.jsonl'))
      .sort()
  } catch {
    return []
  }
}

/** Archive removal after a whole-file rewrite that already stitched them in. */
export async function removeEventArchives(dir: string): Promise<void> {
  for (const name of await listEventArchives(dir)) {
    try {
      await unlink(join(dir, name))
    } catch {
      // best effort — an undeletable archive must not fail the rewrite
    }
  }
}

async function enforceArchiveCap(dir: string): Promise<void> {
  const archives = await listEventArchives(dir)
  while (archives.length >= MAX_EVENT_ARCHIVES) {
    const oldest = archives.shift()
    if (!oldest) break
    try {
      await unlink(join(dir, oldest))
    } catch (err) {
      // best effort — an undeletable archive must not block the append chain
      logger.warn('Failed to delete oldest events archive', {
        scope: 'state',
        correlationId: basename(dir),
        filename: oldest,
        err
      })
    }
  }
}

async function archiveDiscardedHead(dir: string, head: string): Promise<void> {
  if (!head) return
  await enforceArchiveCap(dir)
  const filename = archiveFilename()
  const archivePath = join(dir, filename)
  const temp = `${archivePath}.tmp`
  await writeFile(temp, head, 'utf8')
  await rename(temp, archivePath)
  const byteCount = Buffer.byteLength(head, 'utf8')
  logger.info('Archived rotated events head', {
    scope: 'state',
    code: 'EVENTS_ARCHIVED',
    correlationId: basename(dir),
    filename,
    byteCount
  })
}

/**
 * Rewrite events.jsonl keeping only the recent tail once it exceeds the cap.
 * Runs inside the serialized append chain so it stays single-writer safe.
 */
async function rotateEventsFileIfNeeded(path: string, dir: string): Promise<void> {
  let size = 0
  try {
    size = (await stat(path)).size
  } catch {
    return // file does not exist yet — the append will create it
  }
  if (size <= EVENTS_FILE_MAX_BYTES) return
  const targetSplit = size - EVENTS_FILE_KEEP_BYTES
  if (targetSplit <= 0) return

  const handle = await open(path, 'r')
  let head = ''
  let tail = ''
  try {
    const headLen = Math.min(size, targetSplit)
    const headBuf = Buffer.alloc(headLen)
    await handle.read(headBuf, 0, headLen, 0)
    const lastNl = headBuf.lastIndexOf(0x0a)
    let splitAt = 0
    if (lastNl >= 0) {
      splitAt = lastNl + 1
      head = headBuf.subarray(0, splitAt).toString('utf8')
      const tailLen = size - splitAt
      const tailBuf = Buffer.alloc(tailLen)
      await handle.read(tailBuf, 0, tailLen, splitAt)
      tail = tailBuf.toString('utf8')
    } else {
      const restLen = size - targetSplit
      const restBuf = Buffer.alloc(restLen)
      await handle.read(restBuf, 0, restLen, targetSplit)
      const firstNl = restBuf.indexOf(0x0a)
      if (firstNl < 0) return
      splitAt = targetSplit + firstNl + 1
      head = Buffer.concat([headBuf, restBuf.subarray(0, firstNl + 1)]).toString('utf8')
      tail = restBuf.subarray(firstNl + 1).toString('utf8')
    }
    if (splitAt <= 0 || splitAt >= size) return
  } finally {
    await handle.close()
  }

  await archiveDiscardedHead(dir, head)
  const temp = `${path}.tmp`
  await writeFile(temp, tail, 'utf8')
  await rename(temp, path)
  logger.info('Rotated events.jsonl', {
    scope: 'state',
    code: 'EVENTS_ROTATED',
    correlationId: basename(dir)
  })
}

export function enqueueEventAppend(dir: string, event: unknown): void {
  const line = `${JSON.stringify({ at: new Date().toISOString(), event })}\n`
  const lineBytes = Buffer.byteLength(line, 'utf8')
  const pending = pendingBytes.get(dir) ?? 0
  const isStreamSnapshot =
    typeof event === 'object' &&
    event !== null &&
    (event as { type?: unknown }).type === 'stream_snapshot'
  if (isStreamSnapshot && pending + lineBytes > pendingMaxBytes) {
    const count = (droppedSnapshotCounts.get(dir) ?? 0) + 1
    droppedSnapshotCounts.set(dir, count)
    if (count === 1 || count % 50 === 0) {
      logger.warn('Dropped in-flight stream snapshots under append backpressure', {
        scope: 'state',
        code: 'EVENTS_BACKPRESSURE',
        correlationId: basename(dir),
        dropped: count,
        pendingBytes: pending
      })
    }
    return
  }
  pendingBytes.set(dir, pending + lineBytes)
  const path = join(dir, 'events.jsonl')
  const prev = appendChains.get(dir) ?? Promise.resolve()
  const next = prev
    .then(async () => {
      await withTransientAppendRetry(async () => {
        await rotateEventsFileIfNeeded(path, dir)
        await appendFile(path, line, 'utf8')
      })
    })
    .catch((err) => {
      recordAppendError(dir, err)
      logger.warn('Failed to append events.jsonl', {
        scope: 'state',
        correlationId: basename(dir),
        err
      })
    })
    .finally(() => {
      const rest = (pendingBytes.get(dir) ?? 0) - lineBytes
      if (rest > 0) pendingBytes.set(dir, rest)
      else pendingBytes.delete(dir)
      // Drop settled chains so long sessions do not retain every Promise forever.
      if (appendChains.get(dir) === next) appendChains.delete(dir)
    })
  appendChains.set(dir, next)
}

export async function flushEventAppends(dir?: string): Promise<void> {
  if (dir) {
    await appendChains.get(dir)
    const f = failuresForFlush.get(dir)
    if (f) {
      failuresForFlush.delete(dir)
      throw formatAppendFailure('events.jsonl', [f])
    }
    return
  }
  await Promise.all([...appendChains.values()])
  if (failuresForFlush.size === 0) return
  const all = [...failuresForFlush.values()]
  failuresForFlush.clear()
  throw formatAppendFailure('events.jsonl', all)
}

/** @internal Test helper — how many run dirs still have a pending chain. */
export function appendChainSizeForTests(): number {
  return appendChains.size
}

export function resetEventAppendQueueForTests(): void {
  appendChains.clear()
  failuresForFlush.clear()
  pendingNotices.clear()
  pendingBytes.clear()
  droppedSnapshotCounts.clear()
  pendingMaxBytes = EVENTS_PENDING_MAX_BYTES
}
