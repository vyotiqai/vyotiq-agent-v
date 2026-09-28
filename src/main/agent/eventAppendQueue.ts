import { readdirSync } from 'fs'
import { readdir, unlink } from 'fs/promises'
import { basename, join } from 'path'
import { logger } from '../../shared/logger'
import {
  bumpFailure,
  formatAppendFailure,
  withTransientAppendRetry,
  type DirAppendFailures
} from './appendRetry'
import { appendToRunLog, resetRunLogStateForTests } from './jsonlRotation'

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

/**
 * Run dirs whose storage vanished mid-run (ENOENT on append). Persisting can
 * never succeed again — nothing may silently recreate a run dir, so the run
 * must stop. Logged once per dir; handlers trip the run's abort controller.
 */
const storageLostDirs = new Set<string>()
const storageLostHandlers = new Map<string, Set<() => void>>()

export function isRunStorageLostError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

/** @internal Shared with messageAppendQueue — both queues write under the run dir. */
export function markRunStorageLost(dir: string, err: unknown): void {
  if (!isRunStorageLostError(err)) return
  if (!storageLostDirs.has(dir)) {
    storageLostDirs.add(dir)
    logger.error('Run storage directory has disappeared — the run can no longer persist anything', {
      scope: 'state',
      code: 'EVENTS_DIR_MISSING',
      correlationId: basename(dir)
    })
  }
  const handlers = storageLostHandlers.get(dir)
  if (handlers) {
    for (const handler of [...handlers]) {
      try {
        handler()
      } catch {
        /* handler errors never break the append chain */
      }
    }
  }
}

/** Register a callback fired (immediately, if already lost) when the run dir vanishes. */
export function onRunStorageLost(dir: string, handler: () => void): void {
  if (storageLostDirs.has(dir)) {
    handler()
    return
  }
  const set = storageLostHandlers.get(dir) ?? new Set()
  set.add(handler)
  storageLostHandlers.set(dir, set)
}

/**
 * The run dir exists again (re-created, or resumed after being restored).
 * The mark used to stay for the process lifetime, so every later invoke of
 * that run aborted at start as "storage disappeared".
 */
export function clearRunStorageLost(dir: string): void {
  storageLostDirs.delete(dir)
}

export function clearRunStorageLostHandler(dir: string, handler: () => void): void {
  const set = storageLostHandlers.get(dir)
  if (!set) return
  set.delete(handler)
  if (set.size === 0) storageLostHandlers.delete(dir)
}

/** @internal Test hook. */
export function resetRunStorageLostForTests(): void {
  storageLostDirs.clear()
  storageLostHandlers.clear()
}
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


/** Consume the accumulated mid-run append failures for a run dir, if any. */
export function takeEventAppendFailureNotice(dir: string): Error | undefined {
  const f = pendingNotices.get(dir)
  if (!f) return undefined
  pendingNotices.delete(dir)
  return formatAppendFailure('events.jsonl', [f])
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

/** Evict the oldest archives beyond the cap, after a rotation added one. Best effort. */
async function enforceArchiveCap(dir: string): Promise<void> {
  let archives: string[]
  try {
    archives = await listEventArchives(dir)
  } catch {
    return
  }
  while (archives.length > MAX_EVENT_ARCHIVES) {
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
      await withTransientAppendRetry(() =>
        appendToRunLog({
          path,
          data: line,
          maxBytes: EVENTS_FILE_MAX_BYTES,
          keepBytes: EVENTS_FILE_KEEP_BYTES,
          nextArchivePath: () => join(dir, archiveFilename()),
          onRotated: async ({ archivePath, headBytes }) => {
            logger.info('Rotated events.jsonl', {
              scope: 'state',
              code: 'EVENTS_ROTATED',
              correlationId: basename(dir),
              filename: basename(archivePath),
              byteCount: headBytes
            })
            await enforceArchiveCap(dir)
          },
          onRotateFailed: (err) =>
            logger.warn('events.jsonl rotation failed; appending unrotated', {
              scope: 'state',
              code: 'EVENTS_ROTATE_FAILED',
              correlationId: basename(dir),
              err
            })
        })
      )
    })
    .catch((err) => {
      recordAppendError(dir, err)
      markRunStorageLost(dir, err)
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

/**
 * Bound on flush drain passes.
 *
 * An append enqueued while we await chains onto a NEW promise in the map, which
 * a single snapshot never sees — so one pass can return with writes still
 * outstanding. That is reachable on quit: a run that misses the 15s quiesce is
 * only logged, then keeps appending, and its last writes are the ones worth
 * keeping. Drain until the map is empty, but never spin forever on a run that
 * is still producing.
 */
const FLUSH_DRAIN_MAX_PASSES = 20

export async function flushEventAppends(dir?: string): Promise<void> {
  if (dir) {
    for (let pass = 0; pass < FLUSH_DRAIN_MAX_PASSES; pass += 1) {
      const chain = appendChains.get(dir)
      if (!chain) break
      await chain
    }
    const f = failuresForFlush.get(dir)
    if (f) {
      failuresForFlush.delete(dir)
      throw formatAppendFailure('events.jsonl', [f])
    }
    return
  }
  for (let pass = 0; pass < FLUSH_DRAIN_MAX_PASSES && appendChains.size > 0; pass += 1) {
    await Promise.all([...appendChains.values()])
  }
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
  resetRunLogStateForTests()
}
