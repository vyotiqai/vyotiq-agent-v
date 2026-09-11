import {
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  chmodSync
} from 'fs'
import {
  mkdir as mkdirAsync,
  rename as renameAsync,
  unlink as unlinkAsync,
  writeFile as writeFileAsync,
  chmod as chmodAsync
} from 'fs/promises'
import { dirname } from 'path'
import { randomBytes } from 'crypto'

/** Transient Windows locks (AV / indexer / concurrent handle) — not real permission denials on POSIX. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** Backoff between rename attempts for the async writer (Windows only). */
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const

/**
 * Backoff for the *synchronous* writer. `sleepSync` parks the whole main thread
 * via `Atomics.wait`, so every millisecond here is a millisecond the entire app
 * (all windows) cannot repaint or answer IPC. The async ladder above totals
 * 385 ms, which turned every per-step checkpoint write into a visible freeze
 * once Windows AV/indexer contention made the retries the common path. Keep
 * the attempt count (transient EPERM usually clears on the immediate retry) and
 * shrink the waits to a total of ~18 ms.
 */
const RENAME_RETRY_DELAYS_MS_SYNC = [0, 1, 2, 5, 10] as const

export function isTransientRenameError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as NodeJS.ErrnoException).code
  return typeof code === 'string' && TRANSIENT_RENAME_CODES.has(code)
}

function sleepSync(ms: number): void {
  if (ms <= 0) return
  const sab = new SharedArrayBuffer(4)
  const ia = new Int32Array(sab)
  Atomics.wait(ia, 0, 0, ms)
}

/** Worst-case main-thread stall contributed by one synchronous atomic write. */
export function syncRenameWorstCaseDelayMs(): number {
  let total = 0
  for (const ms of RENAME_RETRY_DELAYS_MS_SYNC) total += ms
  return total
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function tempPathFor(target: string): string {
  // Unique sibling avoids clobbering a concurrent writer's fixed `.tmp`.
  return `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
}

export type RenameRetryDeps = {
  isWindows?: boolean
  delaysMs?: readonly number[]
  renameSyncFn?: typeof renameSync
  sleepSyncFn?: (ms: number) => void
  renameFn?: (from: string, to: string) => Promise<void>
  sleepFn?: (ms: number) => Promise<void>
}

export type AtomicWriteGuard = () => void | Promise<void>

/** Sync rename with Windows backoff on EPERM/EACCES/EBUSY. */
export function renameSyncWithRetry(from: string, to: string, deps: RenameRetryDeps = {}): void {
  const isWindows = deps.isWindows ?? process.platform === 'win32'
  const delays = deps.delaysMs ?? RENAME_RETRY_DELAYS_MS_SYNC
  const doRename = deps.renameSyncFn ?? renameSync
  const sleep = deps.sleepSyncFn ?? sleepSync

  if (!isWindows) {
    doRename(from, to)
    return
  }

  for (const delayMs of delays) {
    try {
      doRename(from, to)
      return
    } catch (err) {
      if (!isTransientRenameError(err)) throw err
      sleep(delayMs)
    }
  }
  doRename(from, to)
}

/** Async rename with Windows backoff on EPERM/EACCES/EBUSY. */
export async function renameWithRetry(
  from: string,
  to: string,
  deps: RenameRetryDeps = {}
): Promise<void> {
  const isWindows = deps.isWindows ?? process.platform === 'win32'
  const delays = deps.delaysMs ?? RENAME_RETRY_DELAYS_MS
  const doRename = deps.renameFn ?? ((a, b) => renameAsync(a, b))
  const sleep = deps.sleepFn ?? defaultSleep

  if (!isWindows) {
    await doRename(from, to)
    return
  }

  for (const delayMs of delays) {
    try {
      await doRename(from, to)
      return
    } catch (err) {
      if (!isTransientRenameError(err)) throw err
      await sleep(delayMs)
    }
  }
  await doRename(from, to)
}

export function atomicWriteFile(target: string, content: string, mode = 0o644): void {
  const dir = dirname(target)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const temp = tempPathFor(target)
  try {
    writeFileSync(temp, content, { encoding: 'utf8', mode })
    renameSyncWithRetry(temp, target)
    try {
      chmodSync(target, mode)
    } catch {
      /* Windows may ignore; continue */
    }
  } catch (err) {
    try {
      unlinkSync(temp)
    } catch {
      /* ignore */
    }
    throw err
  }
}

/** Async atomic text write with the same temp+rename semantics as the sync writer. */
export async function atomicWriteFileAsync(
  target: string,
  content: string,
  mode = 0o644,
  guard?: AtomicWriteGuard
): Promise<void> {
  const dir = dirname(target)
  if (!existsSync(dir)) await mkdirAsync(dir, { recursive: true })
  const temp = tempPathFor(target)
  try {
    await guard?.()
    await writeFileAsync(temp, content, { encoding: 'utf8', mode })
    await guard?.()
    await renameWithRetry(temp, target)
    try {
      await chmodAsync(target, mode)
    } catch {
      /* Windows may ignore; continue */
    }
  } catch (err) {
    try {
      await unlinkAsync(temp)
    } catch {
      /* ignore */
    }
    throw err
  }
}

/** Async atomic binary write with the same temp+rename semantics as the sync writer. */
export async function atomicWriteBufferAsync(
  target: string,
  content: Buffer,
  mode = 0o644,
  guard?: AtomicWriteGuard
): Promise<void> {
  const dir = dirname(target)
  if (!existsSync(dir)) await mkdirAsync(dir, { recursive: true })
  const temp = tempPathFor(target)
  try {
    await guard?.()
    await writeFileAsync(temp, content, { mode })
    await guard?.()
    await renameWithRetry(temp, target)
    try {
      await chmodAsync(target, mode)
    } catch {
      /* Windows may ignore; continue */
    }
  } catch (err) {
    try {
      await unlinkAsync(temp)
    } catch {
      /* ignore */
    }
    throw err
  }
}

/** Atomic write for binary payloads (e.g. generated PNG/JPEG). */
export function atomicWriteBuffer(target: string, content: Buffer, mode = 0o644): void {
  const dir = dirname(target)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const temp = tempPathFor(target)
  try {
    writeFileSync(temp, content, { mode })
    renameSyncWithRetry(temp, target)
    try {
      chmodSync(target, mode)
    } catch {
      /* Windows may ignore; continue */
    }
  } catch (err) {
    try {
      unlinkSync(temp)
    } catch {
      /* ignore */
    }
    throw err
  }
}

export function atomicWriteJson(target: string, data: unknown, mode = 0o644): void {
  atomicWriteFile(target, JSON.stringify(data, null, 2), mode)
}

/** Async twin used by status write queue (same tmp+rename semantics). */
export async function atomicWriteJsonAsync(target: string, data: unknown): Promise<void> {
  const dir = dirname(target)
  if (!existsSync(dir)) await mkdirAsync(dir, { recursive: true })
  const temp = tempPathFor(target)
  try {
    await writeFileAsync(temp, JSON.stringify(data, null, 2), 'utf8')
    await renameWithRetry(temp, target)
  } catch (err) {
    try {
      await unlinkAsync(temp)
    } catch {
      /* ignore */
    }
    throw err
  }
}
