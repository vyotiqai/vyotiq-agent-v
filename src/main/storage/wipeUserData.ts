import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * "Delete all my data". The running app can't delete its own data — the
 * Chromium profile, the log file and the code index are open — so it writes
 * a marker naming its process, relaunches and quits the normal way (which
 * stops runs and closes every file). The next launch sees the marker before
 * it opens anything, waits for that process to be gone, takes the
 * single-instance lock, and empties the data folder.
 *
 * The marker is removed last. Anything that couldn't be deleted is named in it
 * and tried again on the following launch — only those names, so a retry
 * never deletes what was made after the wipe.
 */

export const WIPE_MARKER = '.pending-wipe'

/** Never deleted: the lock a starting instance holds, and the marker itself (removed last). */
const KEEP = (name: string): boolean => name === WIPE_MARKER || name === 'lockfile' || name.startsWith('Singleton')

export type WipeRequest = {
  /** The process that asked; the wipe waits for it to exit. */
  pid: number
  requestedAt: string
  /** Repositories that had task worktrees in the data folder: `git worktree prune` them after. */
  repos: string[]
  /** A retry: only these names, which the first pass couldn't delete. */
  only?: string[]
}

export type WipeReport = {
  deleted: number
  failed: string[]
  waitedMs: number
  repos: string[]
  /** Another instance holds the app lock: nothing was deleted, the request stands. */
  skipped?: 'locked'
}

export function requestDataWipe(
  userDataDir: string,
  opts: { pid?: number; repos?: string[]; now?: Date } = {}
): void {
  const request: WipeRequest = {
    pid: opts.pid ?? process.pid,
    requestedAt: (opts.now ?? new Date()).toISOString(),
    repos: [...new Set(opts.repos ?? [])]
  }
  writeFileSync(join(userDataDir, WIPE_MARKER), JSON.stringify(request), 'utf8')
}

export function wipePending(userDataDir: string): boolean {
  return existsSync(join(userDataDir, WIPE_MARKER))
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : []

/** The pending request, or null. An unreadable marker still means "wipe": it was only ever written by the confirm. */
export function readWipeRequest(userDataDir: string): WipeRequest | null {
  const marker = join(userDataDir, WIPE_MARKER)
  if (!existsSync(marker)) return null
  try {
    const raw = JSON.parse(readFileSync(marker, 'utf8')) as Record<string, unknown>
    const only = strings(raw.only)
    return {
      pid: Number(raw.pid) || 0,
      requestedAt: typeof raw.requestedAt === 'string' ? raw.requestedAt : '',
      repos: strings(raw.repos),
      ...(Array.isArray(raw.only) ? { only } : {})
    }
  } catch {
    return { pid: 0, requestedAt: '', repos: [] }
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists but isn't ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * If a wipe is pending, do it now: synchronously, before anything in this
 * process opens a file there. Waits up to `waitMs` for the process that asked
 * for it to exit, then asks `beforeDelete` (the single-instance lock) — false
 * leaves everything, request included, for a launch that holds the lock.
 * Returns null when there was nothing to do.
 */
export function performPendingWipe(
  userDataDir: string,
  opts: { waitMs?: number; beforeDelete?: () => boolean } = {}
): WipeReport | null {
  const request = readWipeRequest(userDataDir)
  if (!request) return null
  const started = Date.now()
  const deadline = started + (opts.waitMs ?? 15_000)
  while (processAlive(request.pid) && Date.now() < deadline) sleepSync(100)
  if (opts.beforeDelete && !opts.beforeDelete()) {
    return { deleted: 0, failed: [], waitedMs: Date.now() - started, repos: [], skipped: 'locked' }
  }

  const failed: string[] = []
  let deleted = 0
  let names: string[] = []
  try {
    names = readdirSync(userDataDir)
  } catch {
    names = []
  }
  const only = request.only ? new Set(request.only) : null
  for (const name of names) {
    if (KEEP(name) || (only && !only.has(name))) continue
    try {
      // Windows releases handles a beat after a process exits.
      rmSync(join(userDataDir, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
      deleted += 1
    } catch {
      failed.push(name)
    }
  }
  // The OS temp folder is left alone: the app's files there are per-operation
  // and removed by whatever made them, while a `vyotiq-*` sweep would take
  // another running instance's (or a test run's) folders with it.
  const marker = join(userDataDir, WIPE_MARKER)
  try {
    if (failed.length === 0) {
      rmSync(marker, { force: true })
    } else {
      const retry: WipeRequest = { pid: 0, requestedAt: request.requestedAt, repos: [], only: failed }
      writeFileSync(marker, JSON.stringify(retry), 'utf8')
    }
  } catch {
    failed.push(WIPE_MARKER)
  }
  return { deleted, failed, waitedMs: Date.now() - started, repos: request.repos }
}
