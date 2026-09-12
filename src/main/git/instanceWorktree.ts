import { execFile as execFileCb } from 'child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  type Dirent,
  type Stats
} from 'fs'
import { chmod, lstat, readdir, readlink, rmdir, unlink, writeFile } from 'fs/promises'
import { basename, join, resolve, sep } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { promisify } from 'util'
import { logger } from '../../shared/logger'
import { canonicalizeWorkspacePath, workspacePathIsInside } from '../../shared/workspacePath'
import { sanitizedTerminalEnv } from '../agent/tools/terminal'
import { disposeTerminalSessionsUnderPath } from '../agent/tools/terminalSessions'
import { disposeWorkspaceIndexes } from '../agent/workspaceIndex'
import { removeWorkspaceIndexStorage } from '../agent/indexStoragePaths'
import { disposePtySessionsUnderPath } from '../app/ptySessions'
import { workspaceId, workspaceMetaDir } from '../storage/paths'
import { disposeWorkspaceLsp } from '../workspace/lspService'
import { gitAvailable, isGitRepo } from './git'

const execFile = promisify(execFileCb)

const READ_TIMEOUT_MS = 5_000
const WRITE_TIMEOUT_MS = 30_000
const MAX_BUFFER = 4 * 1024 * 1024
const INSTANCE_BRANCH_PREFIX = 'vyotiq/instance/'
const GIT_REMOVE_RETRY_DELAYS_MS = [50, 200, 500] as const
const RM_RETRY_DELAYS_MS = [200, 500, 1000] as const
// Long backoff: a left-over worktree may be held by a still-living previous
// app instance (its index/PTY handles) until the user closes that window.
// Give the deferred cleanup enough time to outlast that, not just 30s.
const DEFERRED_CLEANUP_DELAYS_MS = [
  2_000,
  8_000,
  20_000,
  60_000,
  120_000,
  300_000
] as const

const pendingInstanceWorktrees = new Set<string>()
const deferredCleanupKeys = new Set<string>()
const deferredCleanupTimers = new Set<ReturnType<typeof setTimeout>>()
// Locked left-overs are re-probed on every prune pass (boot, workspace open,
// workspace switch). Each pass used to pay the full removal ladder per locked
// path (~9s of git + WMI kill + rm retries) while holding the worktree mutex,
// stalling spawns. Back off per path instead: retry no sooner than this.
const PRUNE_LOCKED_BACKOFF_MS = 15 * 60_000
const pruneSkipUntil = new Map<string, number>()

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isTransientFsLockError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

function execErrorText(err: unknown): string {
  if (!err || typeof err !== 'object') return err instanceof Error ? err.message : ''
  const rec = err as { stderr?: unknown; message?: unknown }
  const parts: string[] = []
  if (typeof rec.stderr === 'string') parts.push(rec.stderr)
  if (typeof rec.message === 'string') parts.push(rec.message)
  return parts.join('\n')
}

/** Taxonomy for `git worktree remove` failures — no paths. */
export function gitWorktreeRemoveErrorKind(
  err: unknown
): 'not_a_worktree' | 'locked' | 'other' {
  const text = execErrorText(err).toLowerCase()
  if (text.includes('not a working tree')) return 'not_a_worktree'
  if (text.includes('locked')) return 'locked'
  return 'other'
}

export function gitRefIsMissingError(err: unknown): boolean {
  const text = execErrorText(err).toLowerCase()
  return text.includes('not found') || text.includes('does not exist')
}

/**
 * The by-design lock deferral thrown by removeInstanceWorktreeUnlocked when a
 * path stays locked and deferred cleanup was scheduled. Startup prune hits
 * this for every still-locked leftover — it is a scheduled retry, not a
 * prune failure, so callers log it at info level instead of warn.
 */
export function isDeferredWorktreeLockError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const rec = err as { code?: unknown; message?: unknown }
  if (rec.code !== 'EPERM') return false
  return (
    typeof rec.message === 'string' && rec.message.startsWith('Instance worktree still locked:')
  )
}

const LOCK_PROBE_SUFFIX = '.lockprobe'

function deferredWorktreeLockError(worktreePath: string): Error {
  return Object.assign(new Error(`Instance worktree still locked: ${worktreePath}`), {
    code: 'EPERM'
  })
}

/**
 * Cheap lock probe: on Windows, renaming a directory fails with EPERM/EBUSY
 * while any handle under it is open, so a rename-and-rename-back round trip
 * detects a locked worktree in ~1 ms — instead of paying the full removal
 * ladder (git + WMI kill + rm retries) before discovering the same thing.
 * POSIX rename succeeds despite open files, so behavior off win32 is
 * unchanged. Exported for tests; renameFn injection keeps it deterministic.
 */
export function probeInstanceWorktreePathLocked(
  path: string,
  renameFn: (from: string, to: string) => void = renameSync
): boolean {
  const probePath = `${path}${LOCK_PROBE_SUFFIX}`
  try {
    renameFn(path, probePath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') return true
    return false
  }
  try {
    renameFn(probePath, path)
  } catch (err) {
    // The probe rename landed but the rename-back failed — the tree now sits
    // at the probe path. Report locked so callers retry later instead of
    // treating the original path as removable; the stray probe dir is pruned
    // as its own entry on a later pass.
    logger.warn('instance worktree lock probe rename-back failed', {
      scope: 'git',
      path,
      probePath,
      err
    })
    return true
  }
  return false
}

const NODE_MODULES_DIR = 'node_modules'

/** Win32 long-path prefix so deep pnpm trees are not reported as EPERM. */
function toLongPath(p: string): string {
  if (process.platform !== 'win32') return p
  const abs = resolve(p)
  if (abs.startsWith('\\\\?\\')) return abs
  if (abs.startsWith('\\\\')) return `\\\\?\\UNC\\${abs.slice(2)}`
  return `\\\\?\\${abs}`
}

/**
 * Recursive delete that unlinks junctions/symlinks without following them
 * (must not rm into a parent node_modules junction) and continues past EPERM
 * so one mapped hard-link does not abort the remaining 100k files.
 */
export async function removeInstanceWorktreeDirBestEffort(target: string): Promise<void> {
  unlinkOpsSinceYield = 0
  const long = toLongPath(target)
  await removeTreeContinue(long)
  if (existsSync(target) || existsSync(long)) {
    // Best-effort per-file walk could not drop a locked node_modules junction,
    // read-only file, or held handle. Remove-Item -Force handles junctions,
    // read-only bits, and most transient locks that unlink chmod could not.
    await removeViaShell(long)
  }
  if (existsSync(target) || existsSync(long)) {
    throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
  }
}

/**
 * Last-resort Windows removal for paths the per-file walk could not drop.
 * `Remove-Item` leaves junctions/locked trees behind; `cmd /c rmdir /s /q`
 * drops those. Both are best-effort — a still-held handle (e.g. a prior app
 * instance's index/PTY) is what produces the EPERM the caller must retry later.
 */
async function removeViaShell(longPath: string): Promise<void> {
  if (process.platform !== 'win32') return
  const escaped = (longPath ?? '').replace(/'/g, "''")
  try {
    await execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Remove-Item -LiteralPath '${escaped}' -Recurse -Force -ErrorAction SilentlyContinue`
      ],
      {
        timeout: 30_000,
        windowsHide: true,
        env: sanitizedTerminalEnv(),
        encoding: 'utf8'
      }
    )
  } catch {
    /* best-effort */
  }
  if (!existsSync(longPath) && !existsSync(toLongPath(longPath))) return
  try {
    await execFile(
      'cmd.exe',
      ['/c', `rmdir /s /q "${longPath}"`],
      {
        timeout: 30_000,
        windowsHide: true,
        env: sanitizedTerminalEnv(),
        encoding: 'utf8'
      }
    )
  } catch {
    /* best-effort */
  }
}

async function shouldUnlinkWithoutRecurse(path: string, st: Stats): Promise<boolean> {
  if (st.isSymbolicLink()) return true
  if (!st.isDirectory() || basename(path).toLowerCase() !== NODE_MODULES_DIR) return false
  if (process.platform !== 'win32') return false
  try {
    await readlink(path)
    return true
  } catch {
    return false
  }
}

const YIELD_EVERY_UNLINKS = 64
let unlinkOpsSinceYield = 0

function yieldUnlinkBatch(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function maybeYieldUnlink(): Promise<void> {
  unlinkOpsSinceYield += 1
  if (unlinkOpsSinceYield % YIELD_EVERY_UNLINKS === 0) await yieldUnlinkBatch()
}

async function removeTreeContinue(path: string): Promise<void> {
  let st: Stats
  try {
    st = await lstat(path)
  } catch {
    return
  }
  if (await shouldUnlinkWithoutRecurse(path, st)) {
    await tryUnlink(path)
    await maybeYieldUnlink()
    return
  }
  if (st.isDirectory()) {
    await tryChmodDir(path)
    let names: string[] = []
    try {
      names = await readdir(path)
    } catch {
      return
    }
    for (const name of names) {
      await removeTreeContinue(join(path, name))
    }
    try {
      await rmdir(path)
    } catch (err) {
      if (!isTransientFsLockError(err) && !isEnotempty(err)) {
        const code = err && typeof err === 'object' ? (err as NodeJS.ErrnoException).code : undefined
        if (code !== 'ENOENT') throw err
      }
    }
    await maybeYieldUnlink()
    return
  }
  await tryUnlink(path)
  await maybeYieldUnlink()
}

function isEnotempty(err: unknown): boolean {
  const code = err && typeof err === 'object' ? (err as NodeJS.ErrnoException).code : undefined
  return code === 'ENOTEMPTY' || code === 'EEXIST'
}

/**
 * POSIX: removing entries from a directory requires write permission on the
 * directory itself, so a read-only checkout cannot be traversed or emptied
 * (readdir/rmdir/unlink of children fail EACCES). Best-effort chmod before
 * the walk — on win32 chmod is a no-op for directory removal semantics.
 */
async function tryChmodDir(path: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    await chmod(path, 0o700)
  } catch {
    /* ENOENT / no ownership — the walk's own error handling takes over */
  }
}

async function tryUnlink(path: string): Promise<void> {
  try {
    await unlink(path)
    return
  } catch (err) {
    if (!isTransientFsLockError(err)) {
      const code = err && typeof err === 'object' ? (err as NodeJS.ErrnoException).code : undefined
      if (code === 'ENOENT') return
      throw err
    }
  }
  try {
    await chmod(path, 0o666)
    await unlink(path)
  } catch {
    /* still locked — skip so siblings can be removed */
  }
}

/**
 * Kill processes that hold the worktree open: those whose executable or
 * command line references `root`. Win32_Process cannot query a process's
 * current directory, so cwd-only holders are out of scope for WQL. The
 * previous `pnpm start` Electron child can survive Ctrl+C, and child agent
 * processes (node/esbuild) keep the checkout locked via CLI references even
 * when their image is outside it.
 */
export function buildWorktreeProcessFilter(root: string, hostPid = process.pid): string {
  const prefix = resolve(root)
  if (!prefix) return ''
  const like = `${prefix.replace(/\\/g, '\\\\').replace(/'/g, "''")}%`
  return `(ExecutablePath LIKE '${like}' OR CommandLine LIKE '${like}') AND ProcessId != ${hostPid} AND ProcessId != $PID`
}

export async function killProcessesWithExecutableUnder(root: string): Promise<void> {
  if (process.platform !== 'win32') return
  const filter = buildWorktreeProcessFilter(root)
  if (!filter) return
  try {
    await execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$procs = Get-CimInstance Win32_Process -Filter "${filter}"; $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; if ($procs) { $procs.ProcessId | Wait-Process -ErrorAction SilentlyContinue -Timeout 5 }`
      ],
      {
        timeout: 15_000,
        windowsHide: true,
        env: process.env,
        encoding: 'utf8'
      }
    )
  } catch {
    /* best-effort — no matching process is a non-zero exit */
  }
}

export function executablePathIsUnder(root: string, executablePath: string): boolean {
  return workspacePathIsInside(root, executablePath)
}

async function releaseInstanceWorktreeResources(worktreePath: string): Promise<void> {
  try {
    disposeWorkspaceIndexes(worktreePath, { permanent: true })
  } catch {
    /* indexes may never have been opened for this root */
  }
  try {
    await removeWorkspaceIndexStorage(worktreePath)
  } catch {
    /* best-effort — an untracked leftover is reaped by the retention report */
  }
  try {
    disposeWorkspaceLsp(worktreePath)
  } catch {
    /* no LSP client */
  }
  try {
    await disposePtySessionsUnderPath(worktreePath)
  } catch {
    /* no PTY sessions */
  }
  try {
    await disposeTerminalSessionsUnderPath(worktreePath)
  } catch {
    /* no live sessions */
  }
}

function pendingWorktreeKey(workspacePath: string, runId: string): string {
  return `${gitWorktreeMutexKey(workspacePath)}:${runId.trim()}`
}

function markPendingInstanceWorktree(workspacePath: string, runId: string): void {
  const id = runId.trim()
  if (!id) return
  pendingInstanceWorktrees.add(pendingWorktreeKey(workspacePath, id))
}

function clearPendingInstanceWorktree(workspacePath: string, runId: string): void {
  pendingInstanceWorktrees.delete(pendingWorktreeKey(workspacePath, runId))
}

export type InstanceWorktreeRemoveRetryDeps = {
  gitRemove?: () => Promise<void>
  rmSyncFn?: (path: string) => void | Promise<void>
  existsSyncFn?: (path: string) => boolean
  renameFn?: (from: string, to: string) => void
  nowFn?: () => number
  onAsideLeft?: (asidePath: string) => void
  sleepFn?: (ms: number) => Promise<void>
  gitDelaysMs?: readonly number[]
  rmDelaysMs?: readonly number[]
  killUnderPath?: (path: string) => Promise<void>
}

/** Retry git worktree remove, then rm, then rename-aside on lock errors. Exported for unit tests. */
export async function retryRemoveInstanceWorktreePath(
  worktreePath: string,
  deps: InstanceWorktreeRemoveRetryDeps = {}
): Promise<'removed' | 'locked'> {
  const sleepFn = deps.sleepFn ?? defaultSleep
  const gitDelays = deps.gitDelaysMs ?? GIT_REMOVE_RETRY_DELAYS_MS
  const rmDelays = deps.rmDelaysMs ?? RM_RETRY_DELAYS_MS
  const exists = deps.existsSyncFn ?? existsSync
  const rename = deps.renameFn ?? renameSync
  const now = deps.nowFn ?? Date.now
  const rm =
    deps.rmSyncFn ??
    (async (path: string) => {
      await removeInstanceWorktreeDirBestEffort(path)
    })

  if (deps.gitRemove) {
    for (let i = 0; i <= gitDelays.length; i++) {
      try {
        await deps.gitRemove()
        break
      } catch (err) {
        const kind = gitWorktreeRemoveErrorKind(err)
        if (kind === 'not_a_worktree' || i >= gitDelays.length) {
          logger.warn('git worktree remove failed; force-deleting path', {
            scope: 'git',
            reason: kind,
            err
          })
          break
        }
        await sleepFn(gitDelays[i] ?? 0)
      }
    }
  }

  const tryRm = async (): Promise<'removed' | 'locked'> => {
    for (let i = 0; i <= rmDelays.length; i++) {
      if (!exists(worktreePath)) return 'removed'
      try {
        await rm(worktreePath)
        if (!exists(worktreePath)) return 'removed'
      } catch (err) {
        if (!isTransientFsLockError(err)) throw err
        if (i >= rmDelays.length) break
        await sleepFn(rmDelays[i] ?? 0)
        continue
      }
      if (i >= rmDelays.length) break
      await sleepFn(rmDelays[i] ?? 0)
    }
    return exists(worktreePath) ? 'locked' : 'removed'
  }

  if ((await tryRm()) === 'removed') return 'removed'

  if (deps.killUnderPath) {
    try {
      await deps.killUnderPath(worktreePath)
    } catch {
      /* best-effort */
    }
    if ((await tryRm()) === 'removed') return 'removed'
  }

  if (!exists(worktreePath)) return 'removed'
  if (basename(worktreePath).includes('.deleted-')) {
    return 'locked'
  }
  const aside = `${worktreePath}.deleted-${now()}`
  try {
    rename(worktreePath, aside)
    try {
      await rm(aside)
    } catch {
      /* leftover aside is retried via onAsideLeft / later prune */
    }
    if (!exists(worktreePath)) {
      if (exists(aside)) deps.onAsideLeft?.(aside)
      return 'removed'
    }
  } catch (err) {
    if (!isTransientFsLockError(err)) {
      const code = err && typeof err === 'object' ? (err as NodeJS.ErrnoException).code : undefined
      if (code !== 'ENOENT' && code !== 'EEXIST') throw err
    }
  }
  return exists(worktreePath) ? 'locked' : 'removed'
}

function scheduleDeferredInstanceWorktreeCleanup(
  workspacePath: string,
  worktreePath: string
): void {
  const key = resolve(worktreePath)
  if (deferredCleanupKeys.has(key)) return
  deferredCleanupKeys.add(key)

  const attempt = (index: number): void => {
    const delay = DEFERRED_CLEANUP_DELAYS_MS[index] ?? DEFERRED_CLEANUP_DELAYS_MS[0]
    const timer = setTimeout(() => {
      deferredCleanupTimers.delete(timer)
      void withGitWorktreeMutex(workspacePath, async () => {
        if (!existsSync(worktreePath) || !isSafeInstanceWorktreePath(workspacePath, worktreePath)) {
          deferredCleanupKeys.delete(key)
          return
        }
        try {
          await removeInstanceWorktreeUnlocked(workspacePath, worktreePath, {
            allowDeferred: false
          })
        } catch (err) {
          logger.warn('deferred instance worktree cleanup failed', {
            scope: 'git',
            worktreePath,
            err
          })
        }
        if (!existsSync(worktreePath)) {
          deferredCleanupKeys.delete(key)
          return
        }
        if (index + 1 < DEFERRED_CLEANUP_DELAYS_MS.length) {
          attempt(index + 1)
          return
        }
        deferredCleanupKeys.delete(key)
        logger.warn('deferred instance worktree cleanup gave up', {
          scope: 'git',
          worktreePath
        })
      })
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
    deferredCleanupTimers.add(timer)
  }

  attempt(0)
}

export function resetInstanceWorktreeCleanupForTests(): void {
  for (const timer of deferredCleanupTimers) clearTimeout(timer)
  deferredCleanupTimers.clear()
  deferredCleanupKeys.clear()
  pruneSkipUntil.clear()
  pendingInstanceWorktrees.clear()
}

const GIT_ENV = {
  ...sanitizedTerminalEnv(),
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GCM_INTERACTIVE: 'never'
}

async function git(args: string[], cwd: string, timeout: number): Promise<string> {
  const { stdout } = await execFile('git', args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    env: GIT_ENV
  })
  return stdout
}

const gitWorktreeQueues = new Map<string, Promise<void>>()

function gitWorktreeMutexKey(workspacePath: string): string {
  const canonical = canonicalizeWorkspacePath(workspacePath)
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

/**
 * Serialize worktree add/remove/merge per parent workspace so concurrent
 * `git worktree add` cannot race on index.lock (`GIT_OPTIONAL_LOCKS=0`).
 * Nested ops use *Unlocked helpers — this chain is not re-entrant.
 */
function withGitWorktreeMutex<T>(
  workspacePath: string,
  operation: () => T | Promise<T>
): Promise<T> {
  const key = gitWorktreeMutexKey(workspacePath)
  const previous = gitWorktreeQueues.get(key) ?? Promise.resolve()
  let release: (() => void) | undefined
  const reservation = new Promise<void>((resolve) => {
    release = resolve
  })
  gitWorktreeQueues.set(key, reservation)
  const run = previous.then(operation)
  const settled = run.then(
    () => undefined,
    () => undefined
  )
  gitWorktreeQueues.set(key, settled)
  void settled.then(() => {
    if (gitWorktreeQueues.get(key) === settled) gitWorktreeQueues.delete(key)
    release?.()
  })
  return run
}

/** Branch name for an inline instance worktree (stable from run id). */
export function instanceWorktreeBranch(runId: string): string {
  const safe = runId.trim().replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64)
  return `${INSTANCE_BRANCH_PREFIX}${safe || 'run'}`
}

/** AppData root that holds all instance worktree checkouts for a workspace. */
export function instanceWorktreesRoot(workspacePath: string): string {
  const canonical = canonicalizeWorkspacePath(workspacePath)
  const id = workspaceId(canonical)
  return join(workspaceMetaDir(id), 'instance-worktrees')
}

/** Worktree checkout under AppData (outside the project tree). */
export function instanceWorktreePath(workspacePath: string, runId: string): string {
  return join(instanceWorktreesRoot(workspacePath), runId.trim())
}

/** True when path is an Agent V instance worktree checkout (userData instance-worktrees). */
export function isInstanceWorktreeDir(workspaceRoot: string): boolean {
  const parts = canonicalizeWorkspacePath(workspaceRoot).split(/[/\\]+/)
  return parts.includes('instance-worktrees')
}

/** True when path resolves under this workspace's instance-worktrees directory. */
export function isSafeInstanceWorktreePath(
  workspacePath: string,
  worktreePath: string
): boolean {
  const trimmed = worktreePath.trim()
  if (!trimmed) return false
  const root = resolve(instanceWorktreesRoot(workspacePath))
  const target = resolve(trimmed)
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  return target === root || target.startsWith(prefix)
}

/** True when branch is a sanitized vyotiq/instance/* name. */
export function isSafeInstanceBranch(branch: string): boolean {
  const trimmed = branch.trim()
  if (!trimmed.startsWith(INSTANCE_BRANCH_PREFIX)) return false
  const rest = trimmed.slice(INSTANCE_BRANCH_PREFIX.length)
  return rest.length > 0 && /^[a-zA-Z0-9._-]+$/.test(rest)
}

export type AddInstanceWorktreeResult =
  | { ok: true; worktreePath: string; branch: string }
  | { ok: false; error: string }

/** True when porcelain worktree list shows branch checked out at another path. */
function branchCheckedOutElsewhere(
  porcelain: string,
  branch: string,
  intendedPath: string
): boolean {
  const intended = resolve(intendedPath)
  const lines = porcelain.split(/\r?\n/)
  let currentPath: string | null = null
  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length).trim()
      continue
    }
    if (line.startsWith('branch ') && currentPath) {
      const ref = line.slice('branch '.length).trim()
      const name = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
      if (name === branch && resolve(currentPath) !== intended) {
        return true
      }
    }
  }
  return false
}

/**
 * Create a detached write surface for a write-capable inline instance.
 * Falls back to caller when not a git repo / no HEAD / git missing.
 */
export async function addInstanceWorktree(
  workspacePath: string,
  runId: string,
  pathScope?: string[]
): Promise<AddInstanceWorktreeResult> {
  return withGitWorktreeMutex(workspacePath, () =>
    addInstanceWorktreeUnlocked(workspacePath, runId, pathScope)
  )
}

function pathScopeToConeDirs(pathScope: string[]): string[] {
  const dirs = new Set<string>()
  for (const raw of pathScope) {
    const p = raw.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').replace(/^\.\//, '')
    if (!p || p === '.' || p.split('/').includes('..')) continue
    const segs = p.split('/')
    const last = segs[segs.length - 1] ?? p
    const looksLikeFile = last.includes('.') && !last.startsWith('.')
    const dir = looksLikeFile ? segs.slice(0, -1).join('/') : p
    if (dir) dirs.add(dir)
  }
  return [...dirs]
}

async function applySparseConeCheckout(
  worktreePath: string,
  branch: string,
  cones: string[]
): Promise<void> {
  await git(['sparse-checkout', 'init', '--cone'], worktreePath, WRITE_TIMEOUT_MS)
  await git(['sparse-checkout', 'set', '--', ...cones], worktreePath, WRITE_TIMEOUT_MS)
  await git(['checkout', branch], worktreePath, WRITE_TIMEOUT_MS)
}

async function addInstanceWorktreeUnlocked(
  workspacePath: string,
  runId: string,
  pathScope?: string[]
): Promise<AddInstanceWorktreeResult> {
  if (!(await gitAvailable())) {
    return { ok: false, error: 'git is not available' }
  }
  if (!isGitRepo(workspacePath)) {
    return { ok: false, error: 'Not a git repository' }
  }
  let head: string
  try {
    head = (await git(['rev-parse', 'HEAD'], workspacePath, READ_TIMEOUT_MS)).trim()
  } catch {
    return { ok: false, error: 'Repository has no HEAD commit; cannot create instance worktree' }
  }
  if (!head) {
    return { ok: false, error: 'Repository has no HEAD commit; cannot create instance worktree' }
  }

  const worktreePath = instanceWorktreePath(workspacePath, runId)
  const branch = instanceWorktreeBranch(runId)
  mkdirSync(join(worktreePath, '..'), { recursive: true })
  if (existsSync(worktreePath)) {
    try {
      await removeInstanceWorktreeUnlocked(workspacePath, worktreePath)
    } catch {
      if (isSafeInstanceWorktreePath(workspacePath, worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true })
      }
    }
  }

  try {
    const cones = pathScopeToConeDirs(pathScope ?? [])
    if (cones.length > 0) {
      try {
        await git(
          ['worktree', 'add', '--no-checkout', '-b', branch, worktreePath, 'HEAD'],
          workspacePath,
          WRITE_TIMEOUT_MS
        )
        await applySparseConeCheckout(worktreePath, branch, cones)
        markPendingInstanceWorktree(workspacePath, runId)
        return { ok: true, worktreePath, branch }
      } catch (sparseErr) {
        logger.warn('sparse instance worktree failed; using full checkout', {
          scope: 'git',
          worktreePath,
          err: sparseErr
        })
        try {
          await git(
            ['worktree', 'remove', '--force', '--force', worktreePath],
            workspacePath,
            WRITE_TIMEOUT_MS
          )
        } catch {
          /* incomplete add */
        }
        try {
          await git(['branch', '-D', branch], workspacePath, WRITE_TIMEOUT_MS)
        } catch {
          /* branch may not exist */
        }
        if (isSafeInstanceWorktreePath(workspacePath, worktreePath)) {
          try {
            await removeInstanceWorktreeDirBestEffort(worktreePath)
          } catch {
            /* leftover cleaned by full add retry below */
          }
        }
      }
    }
    await git(
      ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'],
      workspacePath,
      WRITE_TIMEOUT_MS
    )
    markPendingInstanceWorktree(workspacePath, runId)
    return { ok: true, worktreePath, branch }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Branch may already exist from a prior crashed spawn — reset to HEAD then attach.
    try {
      let porcelain = ''
      try {
        porcelain = await git(['worktree', 'list', '--porcelain'], workspacePath, READ_TIMEOUT_MS)
      } catch {
        /* best-effort */
      }
      if (branchCheckedOutElsewhere(porcelain, branch, worktreePath)) {
        return {
          ok: false,
          error: `Failed to create instance worktree: branch ${branch} is checked out elsewhere`
        }
      }
      try {
        await git(['branch', '-f', branch, 'HEAD'], workspacePath, WRITE_TIMEOUT_MS)
      } catch (forceErr) {
        const forceMessage = forceErr instanceof Error ? forceErr.message : String(forceErr)
        return {
          ok: false,
          error: `Failed to create instance worktree: ${message}; reset: ${forceMessage}`
        }
      }
      await git(['worktree', 'add', worktreePath, branch], workspacePath, WRITE_TIMEOUT_MS)
      markPendingInstanceWorktree(workspacePath, runId)
      return { ok: true, worktreePath, branch }
    } catch (retryErr) {
      const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr)
      return {
        ok: false,
        error: `Failed to create instance worktree: ${message}; retry: ${retryMessage}`
      }
    }
  }
}

/**
 * Persist uncommitted worktree edits onto the instance branch before remove.
 * Uses one-shot `git -c user.name/email` — never writes git config.
 */
export async function commitDirtyInstanceWorktree(worktreePath: string): Promise<void> {
  if (!worktreePath.trim() || !existsSync(worktreePath)) return
  if (!(await gitAvailable()) || !isGitRepo(worktreePath)) return

  let dirty: string
  try {
    dirty = (await git(['status', '--porcelain'], worktreePath, READ_TIMEOUT_MS)).trim()
  } catch (err) {
    logger.warn('instance worktree status failed before commit', {
      scope: 'git',
      worktreePath,
      err
    })
    return
  }
  if (!dirty) return

  try {
    await git(['add', '-A'], worktreePath, WRITE_TIMEOUT_MS)
    // Nothing staged (e.g. only ignored files) — skip empty commit.
    try {
      await git(['diff', '--cached', '--quiet'], worktreePath, READ_TIMEOUT_MS)
      return
    } catch {
      // Non-zero exit from --quiet means there are staged changes.
    }
    await git(
      [
        '-c',
        'user.name=Vyotiq Agent',
        '-c',
        'user.email=agent@vyotiq.local',
        'commit',
        '-m',
        'vyotiq: instance worktree checkpoint'
      ],
      worktreePath,
      WRITE_TIMEOUT_MS
    )
  } catch (err) {
    logger.warn('instance worktree checkpoint commit failed', {
      scope: 'git',
      worktreePath,
      err
    })
  }
}

/** Remove the worktree checkout; leaves the branch for sequential merge-back. */
export async function removeInstanceWorktree(
  workspacePath: string,
  worktreePath: string
): Promise<void> {
  return withGitWorktreeMutex(workspacePath, () =>
    removeInstanceWorktreeUnlocked(workspacePath, worktreePath)
  )
}

async function removeInstanceWorktreeUnlocked(
  workspacePath: string,
  worktreePath: string,
  opts?: { allowDeferred?: boolean; renameFn?: (from: string, to: string) => void }
): Promise<void> {
  if (!worktreePath.trim()) return
  if (!isSafeInstanceWorktreePath(workspacePath, worktreePath)) {
    logger.warn('refusing to remove worktree outside instance-worktrees', {
      scope: 'git',
      worktreePath
    })
    return
  }
  // Release index/PTY/LSP handles BEFORE the lock probe: a leftover terminal
  // or index handle is exactly what keeps the path locked, and the old
  // probe-first order meant deferred retries could never free it (they skip
  // the release) — the cleanup ladder then gave up on a path only the app
  // itself was holding.
  await releaseInstanceWorktreeResources(worktreePath)
  if (probeInstanceWorktreePathLocked(worktreePath, opts?.renameFn)) {
    if (opts?.allowDeferred !== false) {
      scheduleDeferredInstanceWorktreeCleanup(workspacePath, worktreePath)
      throw deferredWorktreeLockError(worktreePath)
    }
    // Deferred retry: scheduler logs give-up if the path remains. Do not throw
    // EPERM on every attempt — that is the leftover-lock case, not a new failure.
    return
  }
  const runId = basename(worktreePath)
  clearPendingInstanceWorktree(workspacePath, runId)

  const alreadyAside = basename(worktreePath).includes('.deleted-')
  const hasGitDir = !alreadyAside && existsSync(join(worktreePath, '.git'))
  const canGitRemove =
    hasGitDir && (await gitAvailable()) && isGitRepo(workspacePath) && existsSync(worktreePath)
  if (canGitRemove) {
    try {
      await git(['worktree', 'unlock', worktreePath], workspacePath, WRITE_TIMEOUT_MS)
    } catch {
      /* already unlocked or not registered */
    }
  }
  const outcome = await retryRemoveInstanceWorktreePath(worktreePath, {
    ...(canGitRemove
      ? {
          gitRemove: async () => {
            // Locked crash leftovers need --force twice (git-worktree).
            await git(
              ['worktree', 'remove', '--force', '--force', worktreePath],
              workspacePath,
              WRITE_TIMEOUT_MS
            )
          }
        }
      : {}),
    onAsideLeft: (asidePath) => {
      if (opts?.allowDeferred !== false) {
        scheduleDeferredInstanceWorktreeCleanup(workspacePath, asidePath)
      }
    },
    killUnderPath: killProcessesWithExecutableUnder
  })

  if (await gitAvailable() && isGitRepo(workspacePath)) {
    try {
      await git(['worktree', 'prune'], workspacePath, WRITE_TIMEOUT_MS)
    } catch {
      /* best-effort */
    }
  }

  if (outcome === 'locked' && existsSync(worktreePath)) {
    if (opts?.allowDeferred !== false) {
      scheduleDeferredInstanceWorktreeCleanup(workspacePath, worktreePath)
      throw deferredWorktreeLockError(worktreePath)
    }
    // Deferred retry: scheduler logs give-up if the path remains. Do not throw
    // EPERM on every attempt — that is the leftover-lock case, not a new failure.
    return
  }
}

/** Commit dirty edits (if any), then remove the worktree checkout. */
export async function finalizeInstanceWorktree(
  workspacePath: string,
  worktreePath: string,
  opts?: { keepBranch?: boolean; branch?: string }
): Promise<void> {
  return withGitWorktreeMutex(workspacePath, () =>
    finalizeInstanceWorktreeUnlocked(workspacePath, worktreePath, opts)
  )
}

async function finalizeInstanceWorktreeUnlocked(
  workspacePath: string,
  worktreePath: string,
  opts?: { keepBranch?: boolean; branch?: string }
): Promise<void> {
  if (!isSafeInstanceWorktreePath(workspacePath, worktreePath)) {
    logger.warn('refusing to finalize worktree outside instance-worktrees', {
      scope: 'git',
      worktreePath
    })
    return
  }
  await commitDirtyInstanceWorktree(worktreePath)
  const branch = opts?.branch?.trim()
  await removeInstanceWorktreeUnlocked(workspacePath, worktreePath)
  if (opts?.keepBranch === true) return
  if (branch && isSafeInstanceBranch(branch)) {
    await deleteInstanceBranchBestEffort(workspacePath, branch)
  }
}

export type PruneInstanceWorktreesOpts = {
  /** Injected for tests so the lock probe is deterministic cross-platform. */
  renameFn?: (from: string, to: string) => void
  nowFn?: () => number
  backoffMs?: number
}

/** Remove instance-worktrees that are not a live child run (startup / workspace open). */
export async function pruneStaleInstanceWorktrees(
  workspacePath: string,
  liveRunIds: ReadonlySet<string>,
  opts?: PruneInstanceWorktreesOpts
): Promise<number> {
  return withGitWorktreeMutex(workspacePath, () =>
    pruneStaleInstanceWorktreesUnlocked(workspacePath, liveRunIds, opts)
  )
}

async function pruneStaleInstanceWorktreesUnlocked(
  workspacePath: string,
  liveRunIds: ReadonlySet<string>,
  opts?: PruneInstanceWorktreesOpts
): Promise<number> {
  const root = instanceWorktreesRoot(workspacePath)
  if (!existsSync(root)) return 0
  const now = opts?.nowFn ?? Date.now
  const backoffMs = opts?.backoffMs ?? PRUNE_LOCKED_BACKOFF_MS
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true, encoding: 'utf8' })
  } catch (err) {
    logger.warn('instance worktree prune list failed', { scope: 'git', root, err })
    return 0
  }
  let pruned = 0
  let backoffSkipped = 0
  const deferred: string[] = []
  const failed: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const runId = entry.name.trim()
    if (!runId) continue
    if (liveRunIds.has(runId)) continue
    if (pendingInstanceWorktrees.has(pendingWorktreeKey(workspacePath, runId))) continue
    const worktreePath = join(root, runId)
    if (!isSafeInstanceWorktreePath(workspacePath, worktreePath)) continue
    const skipKey = resolve(worktreePath)
    const skipUntil = pruneSkipUntil.get(skipKey)
    if (skipUntil !== undefined && now() < skipUntil) {
      backoffSkipped += 1
      continue
    }
    try {
      await removeInstanceWorktreeUnlocked(workspacePath, worktreePath, {
        renameFn: opts?.renameFn
      })
      if (!existsSync(worktreePath)) {
        pruned += 1
        pruneSkipUntil.delete(skipKey)
      }
    } catch (err) {
      if (isDeferredWorktreeLockError(err)) {
        deferred.push(worktreePath)
        pruneSkipUntil.set(skipKey, now() + backoffMs)
      } else {
        failed.push(worktreePath)
        logger.warn('instance worktree prune failed', {
          scope: 'git',
          worktreePath,
          err
        })
      }
    }
  }
  if (pruned > 0 || deferred.length > 0 || failed.length > 0 || backoffSkipped > 0) {
    logger.info('instance worktree prune summary', {
      scope: 'git',
      root,
      removed: pruned,
      deferredCount: deferred.length,
      deferred: deferred.slice(0, 5),
      backoffSkipped,
      failed: failed.slice(0, 3)
    })
  }
  return pruned
}

export function pruneStaleInstanceWorktreesBestEffort(
  workspacePath: string,
  liveRunIds: ReadonlySet<string>,
  opts?: PruneInstanceWorktreesOpts
): void {
  void pruneStaleInstanceWorktrees(workspacePath, liveRunIds, opts).catch((err) => {
    logger.warn('instance worktree prune failed', { scope: 'git', workspacePath, err })
  })
}

async function deleteInstanceBranchBestEffort(
  workspacePath: string,
  branch: string
): Promise<void> {
  if (!(await gitAvailable()) || !isGitRepo(workspacePath)) return
  try {
    await git(['branch', '-D', branch], workspacePath, WRITE_TIMEOUT_MS)
  } catch (err) {
    if (gitRefIsMissingError(err)) return
    logger.warn('instance branch delete failed', {
      scope: 'git',
      branch,
      err
    })
  }
}

/** True when worktree add failure means shared-workspace fallback is allowed. */
export function isInstanceWorktreeFallbackError(error: string): boolean {
  return (
    error === 'git is not available' ||
    error === 'Not a git repository' ||
    error.startsWith('Repository has no HEAD commit')
  )
}

export type MergedInstanceFileAction = 'created' | 'modified' | 'deleted'

/** One workspace-relative file change a successful instance merge applied. */
export type MergedInstanceFileChange = {
  path: string
  action: MergedInstanceFileAction
}

export type MergeInstanceBranchResult =
  | {
      ok: true
      detail: string
      /** HEAD before the merge — prior content source for checkpoint capture. */
      preMergeHead: string
      changedFiles: MergedInstanceFileChange[]
    }
  | { ok: false; error: string }

/**
 * File changes the merge applied, read as the pre-merge→post-merge diff.
 * Empty on diff failure — the merge itself already succeeded, so the caller
 * must not fail the tool; those changes are simply not checkpoint-revertable.
 */
async function mergedChangedFiles(
  workspacePath: string,
  preMergeHead: string
): Promise<MergedInstanceFileChange[]> {
  try {
    const out = await git(
      ['diff', '--name-status', '--no-renames', '-z', preMergeHead, 'HEAD'],
      workspacePath,
      WRITE_TIMEOUT_MS
    )
    const parts = out.split('\0')
    const changes: MergedInstanceFileChange[] = []
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i]!.trim()
      const path = parts[i + 1]!.trim()
      if (status === 'A') changes.push({ path, action: 'created' })
      else if (status === 'M') changes.push({ path, action: 'modified' })
      else if (status === 'D') changes.push({ path, action: 'deleted' })
    }
    return changes
  } catch (err) {
    logger.warn('post-merge change list failed; merged changes are not checkpoint-revertable', {
      scope: 'git',
      workspacePath,
      err
    })
    return []
  }
}

/**
 * Write the content `relPath` had at `ref` to a temp file so a checkpoint can
 * snapshot prior content. Returns null when the path is absent at `ref` or the
 * extraction fails — callers record those paths as non-undoable instead.
 */
export async function gitShowToFile(
  workspacePath: string,
  ref: string,
  relPath: string
): Promise<string | null> {
  try {
    const out = await execFile(
      'git',
      ['show', `${ref}:${relPath}`],
      {
        cwd: workspacePath,
        encoding: 'buffer',
        timeout: READ_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        env: GIT_ENV
      }
    )
    const tmp = join(tmpdir(), `vyotiq-merge-prior-${process.pid}-${randomUUID()}`)
    await writeFile(tmp, out.stdout as Buffer)
    return tmp
  } catch {
    return null
  }
}

/**
 * Sequential merge-back: merge one instance branch into the parent HEAD.
 * Refuses when the parent worktree is dirty so merges stay one-at-a-time and reviewable.
 */
export async function mergeInstanceBranch(
  workspacePath: string,
  branch: string
): Promise<MergeInstanceBranchResult> {
  return withGitWorktreeMutex(workspacePath, () =>
    mergeInstanceBranchUnlocked(workspacePath, branch)
  )
}

async function mergeInstanceBranchUnlocked(
  workspacePath: string,
  branch: string
): Promise<MergeInstanceBranchResult> {
  if (!(await gitAvailable())) {
    return { ok: false, error: 'git is not available' }
  }
  if (!isGitRepo(workspacePath)) {
    return { ok: false, error: 'Not a git repository' }
  }
  const trimmed = branch.trim()
  if (!trimmed) return { ok: false, error: 'branch is required' }
  if (!isSafeInstanceBranch(trimmed)) {
    return { ok: false, error: 'branch is not a valid instance worktree branch' }
  }

  let preMergeHead: string
  try {
    preMergeHead = (await git(['rev-parse', 'HEAD'], workspacePath, READ_TIMEOUT_MS)).trim()
  } catch {
    return { ok: false, error: 'Repository has no HEAD commit; cannot merge instance branch' }
  }
  if (!preMergeHead) {
    return { ok: false, error: 'Repository has no HEAD commit; cannot merge instance branch' }
  }

  try {
    const status = await git(
      ['status', '--porcelain=v1', '-uall'],
      workspacePath,
      READ_TIMEOUT_MS
    )
    const blocked: string[] = []
    for (const line of status.split(/\r?\n/)) {
      if (line.length < 4) continue
      const xy = line.slice(0, 2)
      if (xy === '??' || xy.trim() === '') continue // untracked: merge cannot overwrite it (git aborts if it would)
      blocked.push(line.trim())
    }
    if (blocked.length > 0) {
      const shown =
        blocked.slice(0, 5).join(', ') + (blocked.length > 5 ? `, +${blocked.length - 5} more` : '')
      return {
        ok: false,
        error: `Parent worktree has uncommitted tracked changes (${shown}). Commit or stash them, then merge one instance branch at a time.`
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Failed to read parent git status: ${message}` }
  }

  try {
    await git(['merge', '--no-edit', trimmed], workspacePath, WRITE_TIMEOUT_MS)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    try {
      await git(['merge', '--abort'], workspacePath, WRITE_TIMEOUT_MS)
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      error: `Merge failed (conflicts or refuse). Resolve in the parent workspace, then retry. ${message}`
    }
  }

  try {
    await git(['branch', '-d', trimmed], workspacePath, WRITE_TIMEOUT_MS)
  } catch {
    // Branch may still be checked out elsewhere — leave it.
  }

  return {
    ok: true,
    detail: `Merged ${trimmed} into HEAD`,
    preMergeHead,
    changedFiles: await mergedChangedFiles(workspacePath, preMergeHead)
  }
}
