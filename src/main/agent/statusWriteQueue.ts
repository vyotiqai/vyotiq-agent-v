import { readFile } from 'fs/promises'
import { join, basename } from 'path'
import { RunStatusSchema, type RunStatus } from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { atomicWriteJsonAsync } from '../storage/atomicWrite'
import { invalidateListRunsCache } from './runListCache'

const STATUS_FLUSH_MS = 250

type StatusWriteQueueStats = {
  enqueued: number
  coalesced: number
  flushed: number
  immediateSync: number
  pendingDirs: number
}

let statusStats: StatusWriteQueueStats = {
  enqueued: 0,
  coalesced: 0,
  flushed: 0,
  immediateSync: 0,
  pendingDirs: 0
}

export function getStatusWriteQueueStats(): StatusWriteQueueStats {
  return { ...statusStats, pendingDirs: pendingByDir.size }
}

export function resetStatusWriteQueueStats(): void {
  statusStats = {
    enqueued: 0,
    coalesced: 0,
    flushed: 0,
    immediateSync: 0,
    pendingDirs: 0
  }
}

type Pending = {
  patch: Partial<RunStatus>
  /** Invalidate list-runs cache on flush when true. */
  invalidateList: boolean
  timer: ReturnType<typeof setTimeout> | null
  chain: Promise<void>
  flushFailures: number
}

const pendingByDir = new Map<string, Pending>()

const TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled'])
const MAX_STATUS_FLUSH_RETRIES = 5
const STATUS_FLUSH_RETRY_MAX_MS = 4_000

function isTerminalPatch(patch: Partial<RunStatus>): boolean {
  return Boolean(patch.status && TERMINAL_STATUSES.has(patch.status))
}

/** Terminal statuses / mode switches are forensic checkpoints — do not debounce behind events.jsonl.
 * Step ticks deliberately DO coalesce: each step previously paid a full
 * read-modify-write of status.json; the canonical transcript lives elsewhere. */
function shouldFlushImmediately(patch: Partial<RunStatus>): boolean {
  return isTerminalPatch(patch) || patch.mode !== undefined
}

/** Meaningful enough to refresh the run list (not every step tick). */
function shouldInvalidateList(patch: Partial<RunStatus>): boolean {
  if (isTerminalPatch(patch)) return true
  if (patch.goal !== undefined) return true
  if (patch.status !== undefined && patch.status !== 'running') return true
  return false
}

function mergePendingPatch(dir: string, patch: Partial<RunStatus>, invalidateList: boolean): void {
  const entry = ensurePending(dir)
  entry.patch = { ...entry.patch, ...patch }
  if (invalidateList) entry.invalidateList = true
}

async function readStatusFile(path: string): Promise<RunStatus> {
  const fallback: RunStatus = {
    status: 'running',
    step: 0,
    updatedAt: new Date().toISOString()
  }
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
    const parsed = RunStatusSchema.safeParse(raw)
    if (parsed.success) return parsed.data
  } catch {
    // keep default
  }
  return fallback
}

async function flushDir(dir: string): Promise<void> {
  const entry = pendingByDir.get(dir)
  if (!entry) return
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }

  // Serialize concurrent flushDir callers on the per-dir chain so a second flush
  // cannot await a stale chain while the first still holds the pending patch.
  const flushOp = entry.chain.then(async () => {
    const patch = entry.patch
    const invalidateList = entry.invalidateList
    entry.patch = {}
    entry.invalidateList = false
    if (Object.keys(patch).length === 0) return

    try {
      const path = join(dir, 'status.json')
      const current = await readStatusFile(path)
      const next: RunStatus = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString()
      }
      await atomicWriteJsonAsync(path, next)
      statusStats.flushed += 1
      entry.flushFailures = 0
      if (invalidateList) {
        const workspacePath = next.workspacePath ?? current.workspacePath
        if (workspacePath) invalidateListRunsCache(workspacePath)
      }
    } catch (err) {
      // Re-merge so a later flush can retry after disk/permission failures.
      mergePendingPatch(dir, patch, invalidateList)
      scheduleStatusRetry(dir)
      throw err
    }
  })

  entry.chain = flushOp.catch((err) => {
    logger.warn('Failed to flush status.json', {
      scope: 'state',
      correlationId: basename(dir),
      err
    })
  })

  await flushOp
  if (pendingByDir.get(dir) === entry && Object.keys(entry.patch).length === 0) {
    if (entry.timer == null) {
      pendingByDir.delete(dir)
    }
  }
}

function scheduleStatusRetry(dir: string): void {
  const entry = pendingByDir.get(dir)
  if (!entry || entry.timer) return
  if (Object.keys(entry.patch).length === 0) return
  // Terminal patches (done/error/cancelled) must never be parked by the retry
  // cap: once the run generator has ended nothing re-enqueues them, and a
  // parked terminal patch leaves status.json "running" — a zombie run that the
  // startup orphan-interrupt later flips to "Cancelled". Retry those until the
  // patch lands (backoff caps at STATUS_FLUSH_RETRY_MAX_MS); non-terminal step
  // ticks keep the bounded retry budget.
  if (!isTerminalPatch(entry.patch)) {
    entry.flushFailures += 1
    if (entry.flushFailures > MAX_STATUS_FLUSH_RETRIES) return
  }
  const delay = Math.min(
    STATUS_FLUSH_RETRY_MAX_MS,
    STATUS_FLUSH_MS * 2 ** (Math.min(entry.flushFailures, 8) - 1)
  )
  entry.timer = setTimeout(() => {
    entry.timer = null
    void flushDir(dir).catch(() => {
      // flushDir logs and re-merges pending patches
    })
  }, delay)
}

function ensurePending(dir: string): Pending {
  let entry = pendingByDir.get(dir)
  if (!entry) {
    entry = {
      patch: {},
      invalidateList: false,
      timer: null,
      chain: Promise.resolve(),
      flushFailures: 0
    }
    pendingByDir.set(dir, entry)
  }
  return entry
}

/**
 * Merge a status patch. Non-step fields coalesce for STATUS_FLUSH_MS; terminal
 * statuses and mode switches flush immediately. List-runs cache invalidates
 * only on meaningful changes.
 */
export function enqueueStatusPatch(dir: string, patch: Partial<RunStatus>): void {
  const entry = ensurePending(dir)
  const hadPendingKeys = Object.keys(entry.patch).length > 0
  statusStats.enqueued += 1
  if (hadPendingKeys || entry.timer) statusStats.coalesced += 1
  entry.patch = { ...entry.patch, ...patch }
  if (shouldInvalidateList(patch)) entry.invalidateList = true

  if (shouldFlushImmediately(patch)) {
    void flushDir(dir).catch(() => {
      // flushDir logs and re-merges pending patches
    })
    return
  }

  if (entry.timer) return
  entry.timer = setTimeout(() => {
    entry.timer = null
    void flushDir(dir).catch(() => {
      // flushDir logs and re-merges pending patches
    })
  }, STATUS_FLUSH_MS)
}

/** Force any coalesced status write to disk (end of run / resume). */
export async function flushStatusWrites(dir?: string): Promise<void> {
  if (dir) {
    await flushDir(dir)
    return
  }
  const errors: unknown[] = []
  await Promise.all(
    [...pendingByDir.keys()].map((d) =>
      flushDir(d).catch((err) => {
        errors.push(err)
      })
    )
  )
  if (errors.length > 0) throw errors[0]
}

/**
 * Drop any coalesced/queued status writes for a run dir (deleteRun). Without
 * this a debounced patch flushed after the rmSync re-creates the deleted run
 * directory containing only a status.json — a phantom run in the sidebar.
 */
export function clearStatusWritesForDir(dir: string): void {
  const entry = pendingByDir.get(dir)
  if (!entry) return
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
  pendingByDir.delete(dir)
}

/** Immediate write — serialized through the per-dir chain (createRun / orphan interrupt). */
export async function writeStatusImmediate(
  dir: string,
  patch: Partial<RunStatus>,
  writeSync: (path: string, next: RunStatus) => void,
  readSync: (path: string) => RunStatus
): Promise<void> {
  statusStats.immediateSync += 1
  const entry = ensurePending(dir)
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
  const mergedPatch = { ...entry.patch, ...patch }
  const invalidateList =
    entry.invalidateList || shouldInvalidateList(patch) || shouldInvalidateList(mergedPatch)
  entry.patch = {}
  entry.invalidateList = false

  const path = join(dir, 'status.json')
  const writeOp = entry.chain.then(() => {
    const current = readSync(path)
    const next: RunStatus = {
      ...current,
      ...mergedPatch,
      updatedAt: new Date().toISOString()
    }
    writeSync(path, next)
    entry.flushFailures = 0
    if (invalidateList) {
      const workspacePath = next.workspacePath ?? current.workspacePath
      if (workspacePath) invalidateListRunsCache(workspacePath)
    }
  })

  entry.chain = writeOp.catch((err) => {
    mergePendingPatch(dir, mergedPatch, invalidateList)
    scheduleStatusRetry(dir)
    logger.warn('Failed immediate status write', {
      scope: 'state',
      correlationId: basename(dir),
      err
    })
  })

  await writeOp
  if (pendingByDir.get(dir) === entry && Object.keys(entry.patch).length === 0 && entry.timer == null) {
    pendingByDir.delete(dir)
  }
}

/** @deprecated Use writeStatusImmediate — kept for tests that need the old name. */
export const writeStatusImmediateSync = writeStatusImmediate

/** @internal */
export function resetStatusWriteQueueForTests(): void {
  for (const entry of pendingByDir.values()) {
    if (entry.timer) clearTimeout(entry.timer)
  }
  pendingByDir.clear()
  resetStatusWriteQueueStats()
}

/** @internal */
export function statusWriteQueueSizeForTests(): number {
  return pendingByDir.size
}

/** @internal */
export function pendingPatchForTests(dir: string): Partial<RunStatus> {
  return { ...(pendingByDir.get(dir)?.patch ?? {}) }
}
