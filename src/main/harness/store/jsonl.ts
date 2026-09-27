import { appendFile } from 'fs/promises'
import { basename, dirname } from 'path'
import { logger } from '../../../shared/logger'

/**
 * Serialized, batched append writer for the run's JSONL files.
 *
 * Every writer of a run file (engine, supervisor, IPC Keep/Undo rows, a child
 * run reporting into its parent) goes through here, so writes to one file are
 * ordered and never interleave. Lines queued while a write is in flight go out
 * together in one `appendFile` — a step's burst of events costs one syscall,
 * not one stat + append per row as before.
 *
 * Files are append-only. The previous writer rotated the head into archives
 * once a file grew past a size cap: the rotation was not idempotent (the head
 * was archived before the live file was replaced, so a failure in between
 * duplicated it), the archive cap deleted history outright, and no reader got
 * faster for it — every reader either reads a tail window or stitches the
 * whole history back together. Archives left by that writer are still read.
 *
 * Failures never throw into the appender. They are recorded per file and taken
 * by the run that owns the file (`takeFailure`), which stops with a persist
 * error; readers only wait for pending writes (`settled`) and never consume a
 * failure meant for the run.
 */

const TRANSIENT_CODES = new Set(['EAGAIN', 'EBUSY', 'EMFILE', 'ENFILE', 'EDEADLK', 'ETIMEDOUT'])
const TRANSIENT_ATTEMPTS = 3

type AppendOp = { kind: 'append'; text: string; done: () => void }
type TaskOp = { kind: 'task'; run: () => Promise<void>; done: (err?: unknown) => void }
type Op = AppendOp | TaskOp

type FileState = {
  ops: Op[]
  draining: Promise<void> | null
  failure: { lost: number; last: Error } | null
}

const files = new Map<string, FileState>()

function stateFor(path: string): FileState {
  let state = files.get(path)
  if (!state) {
    state = { ops: [], draining: null, failure: null }
    files.set(path, state)
  }
  return state
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as NodeJS.ErrnoException).code : undefined
}

async function withTransientRetry(fn: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fn()
      return
    } catch (err) {
      const code = errorCode(err)
      if (attempt >= TRANSIENT_ATTEMPTS || !code || !TRANSIENT_CODES.has(code)) throw err
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 15))
    }
  }
}

async function drain(path: string, state: FileState): Promise<void> {
  while (state.ops.length > 0) {
    const head = state.ops[0]!
    if (head.kind === 'task') {
      state.ops.shift()
      try {
        await head.run()
        head.done()
      } catch (err) {
        head.done(err)
      }
      continue
    }
    const batch: AppendOp[] = []
    while (state.ops.length > 0 && state.ops[0]!.kind === 'append') {
      batch.push(state.ops.shift() as AppendOp)
    }
    try {
      await withTransientRetry(() => appendFile(path, batch.map((op) => op.text).join(''), 'utf8'))
    } catch (err) {
      recordFailure(path, state, err, batch.length)
    }
    for (const op of batch) op.done()
  }
  state.draining = null
  if (!state.failure) files.delete(path)
}

function kick(path: string, state: FileState): void {
  if (!state.draining) state.draining = drain(path, state)
}

function recordFailure(path: string, state: FileState, err: unknown, lines: number): void {
  const error = err instanceof Error ? err : new Error(String(err))
  state.failure = { lost: (state.failure?.lost ?? 0) + lines, last: error }
  logger.warn(`Failed to append ${basename(path)}`, {
    scope: 'store',
    correlationId: basename(dirname(path)),
    err: error
  })
  // appendFile creates a missing file but never a missing directory, so ENOENT
  // means the run directory itself is gone. Nothing may recreate it; the run
  // that owns it has to stop.
  if (errorCode(err) === 'ENOENT') markStorageLost(dirname(path))
}

/** Queue one line (must end with '\n'); resolves once its batch is written or has failed. */
export function appendLine(path: string, line: string): Promise<void> {
  const state = stateFor(path)
  return new Promise<void>((resolve) => {
    state.ops.push({ kind: 'append', text: line, done: resolve })
    kick(path, state)
  })
}

/**
 * Run `task` after every append queued before it and before any queued after
 * it. Whole-file rewrites go through here so a rewrite can never drop a line
 * that was still buffered.
 */
export function runSerialized(path: string, task: () => Promise<void>): Promise<void> {
  const state = stateFor(path)
  return new Promise<void>((resolve, reject) => {
    state.ops.push({
      kind: 'task',
      run: task,
      done: (err) => (err === undefined ? resolve() : reject(err))
    })
    kick(path, state)
  })
}

/** Wait until nothing is queued for `path`. Never throws. */
export async function settled(path: string): Promise<void> {
  for (let state = files.get(path); state?.draining; state = files.get(path)) {
    await state.draining
  }
}

/** Wait until nothing is queued for any file under `dir` (all files when omitted). */
export async function settledUnder(dir?: string): Promise<void> {
  for (;;) {
    const pending = [...files.entries()]
      .filter(([path, state]) => state.draining && (dir === undefined || dirname(path) === dir))
      .map(([, state]) => state.draining!)
    if (pending.length === 0) return
    await Promise.all(pending)
  }
}

/** Take (and clear) the failure recorded for `path`, if any. */
export function takeFailure(path: string): Error | undefined {
  const state = files.get(path)
  const failure = state?.failure
  if (!state || !failure) return undefined
  state.failure = null
  if (!state.draining && state.ops.length === 0) files.delete(path)
  const noun = failure.lost === 1 ? 'record' : 'records'
  const err = new Error(
    `${failure.lost} ${noun} failed to persist to ${basename(path)}: ${failure.last.message}`
  )
  err.cause = failure.last
  return err
}

// ---------------------------------------------------------------------------
// Storage loss: the run directory vanished (external cleanup, deleted run).

const lostDirs = new Set<string>()
const lostHandlers = new Map<string, Set<() => void>>()

function markStorageLost(dir: string): void {
  if (!lostDirs.has(dir)) {
    lostDirs.add(dir)
    logger.error('Run storage directory has disappeared; nothing more can be persisted', {
      scope: 'store',
      code: 'STORAGE_LOST',
      correlationId: basename(dir)
    })
  }
  for (const handler of [...(lostHandlers.get(dir) ?? [])]) {
    try {
      handler()
    } catch {
      // A handler must never break the writer.
    }
  }
}

/** Call `handler` when `dir` disappears (immediately when it already has). Returns an unsubscribe. */
export function onStorageLost(dir: string, handler: () => void): () => void {
  if (lostDirs.has(dir)) {
    handler()
    return () => undefined
  }
  const set = lostHandlers.get(dir) ?? new Set()
  set.add(handler)
  lostHandlers.set(dir, set)
  return () => {
    set.delete(handler)
    if (set.size === 0) lostHandlers.delete(dir)
  }
}

/** A directory that was re-created (same run id reused) is writable again. */
export function forgetStorageLost(dir: string): void {
  lostDirs.delete(dir)
}

/** @internal */
export function resetJsonlForTests(): void {
  files.clear()
  lostDirs.clear()
  lostHandlers.clear()
}
