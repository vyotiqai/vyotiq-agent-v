import { existsSync, readFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { basename, join } from 'path'
import { atomicWriteJsonAsync } from '../../storage/atomicWrite'
import { RunStatusSchema, type RunStatus } from '../../../shared/ipc'
import { logger } from '../../../shared/logger'

/**
 * status.json — the run's snapshot: lifecycle status, step, goal, mode,
 * invoke id, instance metadata. Every write is a read-modify-write of the whole
 * document, serialized per run directory.
 *
 * Step ticks coalesce for STATUS_DEBOUNCE_MS (a step used to cost a full
 * rewrite); terminal statuses and mode switches are written at once because
 * the run list, notifications and a restart all read them. A key set to
 * `undefined` in a patch is removed from the document.
 */
export const STATUS_FILE = 'status.json'
const STATUS_DEBOUNCE_MS = 250
const RETRY_BASE_MS = 250
const RETRY_MAX_MS = 4_000
/** Non-terminal patches give up after this many failed writes; terminal ones never do. */
const NON_TERMINAL_RETRIES = 5

export function statusPath(dir: string): string {
  return join(dir, STATUS_FILE)
}

/** The run's status, or null when the file is absent or does not validate. */
export function readStatus(dir: string): RunStatus | null {
  const path = statusPath(dir)
  if (!existsSync(path)) return null
  try {
    const parsed = RunStatusSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (parsed.success) return parsed.data
  } catch {
    // Fall through to the warning.
  }
  logger.warn('Unreadable status.json; treating as absent', {
    scope: 'store',
    correlationId: basename(dir)
  })
  return null
}

type Entry = {
  patch: Partial<RunStatus>
  timer: ReturnType<typeof setTimeout> | null
  chain: Promise<void>
  failures: number
}

const entries = new Map<string, Entry>()
/** Deleted runs: a late patch must not recreate their directory. */
const abandoned = new Set<string>()
const listeners = new Set<(workspacePath: string) => void>()

function isTerminal(patch: Partial<RunStatus>): boolean {
  return patch.status === 'done' || patch.status === 'error' || patch.status === 'cancelled'
}

/** Worth refreshing the run list for (a step tick is not). */
function isListVisible(patch: Partial<RunStatus>): boolean {
  return (
    isTerminal(patch) ||
    patch.goal !== undefined ||
    (patch.status !== undefined && patch.status !== 'running')
  )
}

function entryFor(dir: string): Entry {
  let entry = entries.get(dir)
  if (!entry) {
    entry = { patch: {}, timer: null, chain: Promise.resolve(), failures: 0 }
    entries.set(dir, entry)
  }
  return entry
}

async function readCurrent(path: string): Promise<RunStatus> {
  try {
    const parsed = RunStatusSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
    if (parsed.success) return parsed.data
  } catch {
    // A missing or corrupt document is rebuilt from the patch.
  }
  return { status: 'running', step: 0, updatedAt: new Date().toISOString() }
}

function scheduleRetry(dir: string, entry: Entry, terminal: boolean): void {
  if (abandoned.has(dir) || entry.timer) return
  entry.failures++
  // A terminal status that never lands leaves the run "running" on disk
  // forever, so it retries until it does; a step tick is not worth that.
  if (!terminal && entry.failures > NON_TERMINAL_RETRIES) return
  const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(entry.failures - 1, 8))
  entry.timer = setTimeout(() => {
    entry.timer = null
    void flushStatus(dir).catch(() => undefined)
  }, delay)
}

/**
 * Write whatever is pending for `dir` now. Rejects when the write fails; the
 * patch is kept and retried in the background either way.
 */
export function flushStatus(dir: string): Promise<void> {
  const entry = entries.get(dir)
  if (!entry) return Promise.resolve()
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
  const op = entry.chain.then(async () => {
    const patch = entry.patch
    entry.patch = {}
    if (Object.keys(patch).length === 0 || abandoned.has(dir)) return
    // Never recreate a directory that is gone: the run was deleted or its
    // storage vanished, and a status-only folder would show as a phantom run.
    if (!existsSync(dir)) return
    const path = statusPath(dir)
    try {
      const current = await readCurrent(path)
      if (abandoned.has(dir)) return
      const next: RunStatus = { ...current, ...patch, updatedAt: new Date().toISOString() }
      await atomicWriteJsonAsync(path, next)
      entry.failures = 0
      if (isListVisible(patch)) {
        const workspacePath = next.workspacePath ?? current.workspacePath
        if (workspacePath) for (const listener of listeners) listener(workspacePath)
      }
    } catch (err) {
      // Newer patches merged meanwhile win over the one that failed.
      entry.patch = { ...patch, ...entry.patch }
      scheduleRetry(dir, entry, isTerminal(entry.patch))
      throw err
    }
  })
  entry.chain = op.catch((err) => {
    logger.warn('Failed to write status.json', { scope: 'store', correlationId: basename(dir), err })
  })
  return op.finally(() => {
    if (entries.get(dir) === entry && !entry.timer && Object.keys(entry.patch).length === 0) {
      entries.delete(dir)
    }
  })
}

/**
 * Merge `patch` into the run's status. Terminal statuses, mode switches and
 * `now: true` are written immediately (the returned promise settles once that
 * write is done); other patches coalesce for a short window. Never rejects: a
 * failed write is logged and retried — call `flushStatus` to observe failure.
 */
export function patchStatus(
  dir: string,
  patch: Partial<RunStatus>,
  opts?: { now?: boolean }
): Promise<void> {
  if (abandoned.has(dir)) return Promise.resolve()
  const entry = entryFor(dir)
  entry.patch = { ...entry.patch, ...patch }
  if (opts?.now || isTerminal(patch) || patch.mode !== undefined) {
    return flushStatus(dir).catch(() => undefined)
  }
  if (!entry.timer) {
    entry.timer = setTimeout(() => {
      entry.timer = null
      void flushStatus(dir).catch(() => undefined)
    }, STATUS_DEBOUNCE_MS)
  }
  return Promise.resolve()
}

/** Drop pending writes for a deleted run and refuse later ones. */
export function abandonStatus(dir: string): void {
  abandoned.add(dir)
  const entry = entries.get(dir)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  entries.delete(dir)
}

/** A run directory created (again) on purpose is writable. */
export function reviveStatus(dir: string): void {
  abandoned.delete(dir)
}

/** Called with the run's workspace whenever a list-visible field is written. */
export function onListVisibleStatusChange(listener: (workspacePath: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Flush every run's pending status (quit). Rejects with the first failure. */
export async function flushAllStatus(): Promise<void> {
  const results = await Promise.allSettled([...entries.keys()].map((dir) => flushStatus(dir)))
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed) throw failed.reason
}

/** @internal */
export function resetStatusForTests(): void {
  for (const entry of entries.values()) if (entry.timer) clearTimeout(entry.timer)
  entries.clear()
  abandoned.clear()
  listeners.clear()
}
