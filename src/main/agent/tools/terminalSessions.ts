import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import {
  commandOnPath,
  decodeConsoleText,
  formatTerminalSessionOutput,
  killProcessTree,
  killProcessTreeAndWait,
  normalizeChildExitCode,
  resolveTerminalShell,
  agentCommandEnv,
  stripPowerShellPatternNoise,
  TERMINAL_MAX_OUTPUT,
  terminalDocxUnzipPreflight,
  terminalNestedPowerShellPreflight,
  terminalSelfKillPreflight,
  terminalSpawnSpec,
  type ResolvedTerminalShell
} from './terminal'
import { compileUserRegex } from './safeUserRegex'
import { workspacePathIsInside, workspacePathsEqual } from '../../../shared/workspacePath'
import type { TerminalShell } from '../../../shared/ipc'
import { lowerProcessPriority } from '../processPriority'
import { logger } from '../../../shared/logger'
import { registerRunCancelHooks } from '../runRegistry'
import { wrappedSpawnOptions, type SandboxLaunch, type WrappedCommand } from '../sandbox/wrap'

export type TerminalSessionStatus = 'running' | 'done' | 'timeout' | 'pattern_matched' | 'aborted'

/** Resource-safety limit: max concurrent background terminal sessions per run invoke. */
export const MAX_BACKGROUND_TERMINALS_PER_INVOKE = 8

/**
 * App-wide ceiling on concurrent *live* background shells, across every run and
 * invoke. The per-invoke cap alone is multiplied by
 * `maxParallelInstances` (default 16 — settings.maxParallelInstances), so one
 * task could otherwise hold 128 shell process trees. 24 sits well above a
 * realistic single-task peak (8 per invoke) while still bounding the app.
 */
export const MAX_BACKGROUND_TERMINALS_GLOBAL = 24

/**
 * Finished sessions stay readable for later polls, but only for this long —
 * after the TTL (or once too many pile up) they are disposed so the map and
 * the concurrency budget cannot leak across a long-lived invoke.
 */
export const FINISHED_TERMINAL_SESSION_TTL_MS = 15 * 60_000
export const MAX_FINISHED_TERMINAL_SESSIONS_PER_INVOKE = 16

type TerminalSession = {
  id: string
  runId: string
  invokeId: number
  workspaceRoot: string
  /** Directory the child actually spawned in — reported to the model as `cwd:`. */
  cwd: string
  command: string
  shell: ResolvedTerminalShell
  /** Set when the shell runs inside the OS sandbox; every poll frame says so. */
  sandbox?: Pick<SandboxLaunch, 'label' | 'network'>
  child: ChildProcess
  stdout: string
  stderr: string
  exitCode: number | null
  running: boolean
  status: TerminalSessionStatus
  pattern?: RegExp
  patternMatched?: boolean
  createdAt: number
  /** When the child process closed (finished sessions only). Drives TTL pruning. */
  finishedAt?: number
  onOutput?: (chunk: { text: string; stream: 'stdout' | 'stderr' }) => void
  /** Resolvers waiting for close / pattern / status change (event-driven poll). */
  waiters: Set<() => void>
  /**
   * Still running when its turn ended, so it was kept for the task instead of
   * killed: a dev server, a watcher. Any later turn of the same run may poll,
   * feed or stop it; the user stops it from the app. See keepLiveTerminalSessionsForInvoke.
   */
  kept?: boolean
}

const sessions = new Map<string, TerminalSession>()

/** A background process kept running past the turn that started it. */
export type KeptTerminalSession = {
  id: string
  runId: string
  workspacePath: string
  command: string
  cwd: string
  /** ISO time the process started. */
  startedAt: string
}

const keptListeners = new Set<() => void>()

/** Called whenever the set of kept sessions changes (one kept, one exits or is stopped). */
export function onKeptTerminalSessionsChanged(listener: () => void): () => void {
  keptListeners.add(listener)
  return () => keptListeners.delete(listener)
}

function notifyKeptChanged(): void {
  for (const listener of [...keptListeners]) {
    try {
      listener()
    } catch (err) {
      logger.warn('Kept terminal listener failed', { scope: 'agent', err })
    }
  }
}

/**
 * Deferred work keyed by session id, run when the session's process exits.
 * Background commands keep mutating the workspace after the tool's poll window
 * returns; the terminal tool registers a final diff here so those late
 * mutations still reach the write checkpoint and cache invalidation.
 */
const exitFinalizers = new Map<string, Array<() => Promise<void> | void>>()

/**
 * Register work to run when this session's process exits.
 * @returns false when the session is unknown or already finished — the caller
 * must then run its finalize synchronously.
 */
export function registerTerminalSessionExitFinalize(
  sessionId: string,
  finalize: () => Promise<void> | void
): boolean {
  const session = sessions.get(sessionId)
  if (!session || !session.running) return false
  const list = exitFinalizers.get(sessionId) ?? []
  list.push(finalize)
  exitFinalizers.set(sessionId, list)
  return true
}

/** Run and clear the deferred finalizers for a session (idempotent). */
async function runExitFinalizers(sessionId: string): Promise<void> {
  const list = exitFinalizers.get(sessionId)
  if (!list) return
  exitFinalizers.delete(sessionId)
  for (const fn of list) {
    try {
      await fn()
    } catch (err) {
      logger.warn('Terminal session exit finalizer failed', {
        scope: 'agent',
        err
      })
    }
  }
}

function notifySessionWaiters(session: TerminalSession): void {
  if (session.waiters.size === 0) return
  const waiters = [...session.waiters]
  session.waiters.clear()
  for (const wake of waiters) wake()
}

function patternHaystack(session: TerminalSession): string {
  const hay = `${session.stdout}\n${session.stderr}`
  return session.shell === 'powershell' ? stripPowerShellPatternNoise(hay) : hay
}

function matchesPattern(session: TerminalSession): boolean {
  if (!session.pattern) return false
  if (session.patternMatched) return true
  if (!session.running && session.status !== 'running') return false
  const matched = session.pattern.test(patternHaystack(session))
  if (matched) session.patternMatched = true
  return matched
}

function assertSessionOwnership(
  session: TerminalSession | undefined,
  sessionId: string,
  runId: string,
  invokeId: number
): asserts session is TerminalSession {
  if (!session) {
    throw new Error(
      `Unknown terminal session_id: ${sessionId}. Background shells do not survive app restart and finished sessions are pruned automatically — run the command again.`
    )
  }
  // A kept session outlived its turn on purpose; any later turn of the same
  // run owns it.
  if (session.runId !== runId || (session.invokeId !== invokeId && !session.kept)) {
    throw new Error(`Terminal session does not belong to run: ${sessionId}`)
  }
}

export function getTerminalSession(
  id: string,
  runId: string,
  invokeId: number
): TerminalSession | undefined {
  const session = sessions.get(id)
  try {
    assertSessionOwnership(session, id, runId, invokeId)
  } catch {
    return undefined
  }
  return session
}

export function disposeTerminalSession(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  if (session.running && session.child.pid) {
    killProcessTree(session.child.pid, 'dispose')
  }
  session.running = false
  session.finishedAt ??= Date.now()
  if (session.status === 'running') session.status = 'aborted'
  notifySessionWaiters(session)
  sessions.delete(id)
  void runExitFinalizers(id)
  if (session.kept) notifyKeptChanged()
}

export function resetTerminalSessionsForTests(): void {
  for (const id of [...sessions.keys()]) disposeTerminalSession(id)
}

/** @internal Test helper — count sessions owned by a run invoke. */
export function countTerminalSessionsForInvoke(runId: string, invokeId: number): number {
  let count = 0
  for (const session of sessions.values()) {
    if (session.runId === runId && session.invokeId === invokeId) count++
  }
  return count
}

/** @internal Test helper — total live background sessions. */
export function countTerminalSessionsGlobalForTests(): number {
  return sessions.size
}

/**
 * Live shells across every run and invoke — what MAX_BACKGROUND_TERMINALS_GLOBAL
 * bounds. Finished-but-unpruned sessions are deliberately excluded: the ceiling
 * exists to cap concurrent process trees, not retained output history, and the
 * per-invoke TTL prune reclaims those on the next spawn.
 */
function countLiveTerminalSessionsGlobal(): number {
  let count = 0
  for (const session of sessions.values()) {
    if (session.running) count++
  }
  return count
}

export function disposeTerminalSessionsForInvoke(runId: string, invokeId: number): number {
  let disposed = 0
  for (const session of [...sessions.values()]) {
    if (session.runId !== runId || session.invokeId !== invokeId) continue
    disposeTerminalSession(session.id)
    disposed++
  }
  return disposed
}

/**
 * End of a turn that finished on its own: background processes still running
 * (a dev server, a test watcher) are kept for the task instead of killed, so
 * "start the server and leave it" is true when the agent says it. Finished
 * sessions are disposed as before. A cancelled turn never gets here — its
 * cancel hook disposes everything the turn started.
 * @returns the sessions kept.
 */
export function keepLiveTerminalSessionsForInvoke(runId: string, invokeId: number): KeptTerminalSession[] {
  const kept: KeptTerminalSession[] = []
  for (const session of [...sessions.values()]) {
    if (session.runId !== runId) continue
    if (!session.running) {
      if (session.invokeId === invokeId || session.kept) disposeTerminalSession(session.id)
      continue
    }
    if (session.invokeId !== invokeId && !session.kept) continue
    session.kept = true
    // Nobody reads the live stream after the turn; the buffers keep the output.
    session.onOutput = undefined
    kept.push(keptView(session))
  }
  if (kept.length > 0) notifyKeptChanged()
  return kept
}

function keptView(session: TerminalSession): KeptTerminalSession {
  return {
    id: session.id,
    runId: session.runId,
    workspacePath: session.workspaceRoot,
    command: session.command,
    cwd: session.cwd,
    startedAt: new Date(session.createdAt).toISOString()
  }
}

/** Background processes kept past their turn and still running, optionally for one workspace. */
export function listKeptTerminalSessions(workspacePath?: string): KeptTerminalSession[] {
  const out: KeptTerminalSession[] = []
  for (const session of sessions.values()) {
    if (!session.kept || !session.running) continue
    if (workspacePath && !workspacePathsEqual(session.workspaceRoot, workspacePath)) continue
    out.push(keptView(session))
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

/** Stop a kept background process (the user's Stop). False when it is unknown or not kept. */
export function stopKeptTerminalSession(id: string): boolean {
  const session = sessions.get(id)
  if (!session || !session.kept) return false
  disposeTerminalSession(id)
  return true
}

/** Every session a run owns, kept or not — the task was deleted. */
export function disposeTerminalSessionsForRun(runId: string): number {
  let disposed = 0
  for (const session of [...sessions.values()]) {
    if (session.runId !== runId) continue
    disposeTerminalSession(session.id)
    disposed++
  }
  return disposed
}

/**
 * The agent's `kill: true`: stop one of this run's sessions (its whole process
 * tree) and return its last output.
 */
export function killTerminalSession(opts: { runId: string; invokeId: number; sessionId: string }): string {
  const session = sessions.get(opts.sessionId)
  assertSessionOwnership(session, opts.sessionId, opts.runId, opts.invokeId)
  // `aborted` says it was stopped; the frame must keep exit_code last for its parser.
  const frame = formatSession({ ...session, status: session.running ? 'aborted' : session.status })
  disposeTerminalSession(session.id)
  return frame
}

/**
 * The agent's `input`: write text to a running session's stdin (an answer to a
 * y/N prompt, a line for a REPL). A newline is added when missing, which is
 * what pressing Enter sends.
 */
export function writeTerminalSessionInput(opts: {
  runId: string
  invokeId: number
  sessionId: string
  input: string
}): void {
  const session = sessions.get(opts.sessionId)
  assertSessionOwnership(session, opts.sessionId, opts.runId, opts.invokeId)
  if (!session.running) {
    throw new Error(`Terminal session ${opts.sessionId} has already exited; there is nothing to send input to.`)
  }
  const stdin = session.child.stdin
  if (!stdin || stdin.destroyed || !stdin.writable) {
    throw new Error(`Terminal session ${opts.sessionId} does not accept input (its stdin is closed).`)
  }
  stdin.write(opts.input.endsWith('\n') ? opts.input : `${opts.input}\n`)
}

export function disposeTerminalSessionsForWorkspace(workspacePath: string): number {
  let disposed = 0
  for (const session of [...sessions.values()]) {
    if (!workspacePathsEqual(session.workspaceRoot, workspacePath)) continue
    disposeTerminalSession(session.id)
    disposed++
  }
  return disposed
}

/**
 * Dispose finished sessions for this invoke that are past the TTL, then — if
 * too many still linger — dispose the oldest so output history stays bounded.
 * Called before each new spawn: finished sessions must never wedge the
 * concurrency cap for the rest of an invoke (they used to leak until the run
 * ended, surfacing as "Too many concurrent background terminal sessions").
 */
export function pruneFinishedTerminalSessionsForInvoke(runId: string, invokeId: number): number {
  const now = Date.now()
  const finished: TerminalSession[] = []
  for (const session of sessions.values()) {
    if (session.runId !== runId || session.invokeId !== invokeId) continue
    if (session.running) continue
    if (session.finishedAt !== undefined && now - session.finishedAt >= FINISHED_TERMINAL_SESSION_TTL_MS) {
      disposeTerminalSession(session.id)
      continue
    }
    finished.push(session)
  }
  let pruned = 0
  while (finished.length > MAX_FINISHED_TERMINAL_SESSIONS_PER_INVOKE) {
    finished.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
    const oldest = finished.shift()
    if (!oldest) break
    disposeTerminalSession(oldest.id)
    pruned++
  }
  return pruned
}

/** Kill sessions whose cwd or workspace root sits under `root` (instance worktree teardown). */
export async function disposeTerminalSessionsUnderPath(root: string): Promise<number> {
  const trimmed = root.trim()
  if (!trimmed) return 0
  const pids: number[] = []
  let disposed = 0
  for (const session of [...sessions.values()]) {
    if (
      !workspacePathIsInside(trimmed, session.cwd) &&
      !workspacePathIsInside(trimmed, session.workspaceRoot)
    ) {
      continue
    }
    if (session.running && session.child.pid) pids.push(session.child.pid)
    disposeTerminalSession(session.id)
    disposed++
  }
  await Promise.all(pids.map((pid) => killProcessTreeAndWait(pid, 'worktree-teardown')))
  return disposed
}

export function disposeAllTerminalSessions(): void {
  for (const id of [...sessions.keys()]) disposeTerminalSession(id)
}

function formatSession(session: TerminalSession): string {
  return formatTerminalSessionOutput({
    cwd: session.cwd,
    command: session.command,
    shell: session.shell,
    stdout: session.stdout,
    stderr: session.stderr,
    exitCode: session.exitCode,
    sessionId: session.id,
    status: session.status,
    sandbox: session.sandbox
  })
}

/**
 * Wait until the session stops running, matches pattern, aborts, or deadline.
 * Wakes immediately on close/pattern via session waiters (no 100ms busy-poll).
 */
function waitForSessionEvent(
  session: TerminalSession,
  signal: AbortSignal,
  deadline: number
): Promise<void> {
  if (!session.running || session.status !== 'running' || signal.aborted) {
    return Promise.resolve()
  }
  const remaining = deadline - Date.now()
  if (remaining <= 0) return Promise.resolve()

  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      session.waiters.delete(finish)
      signal.removeEventListener('abort', finish)
      clearTimeout(timer)
      resolve()
    }
    session.waiters.add(finish)
    signal.addEventListener('abort', finish, { once: true })
    const timer = setTimeout(finish, remaining)
  })
}

export type StartBackgroundTerminalOpts = {
  runId: string
  invokeId: number
  workspaceRoot: string
  /** Absolute cwd inside workspace; defaults to workspaceRoot. */
  cwd?: string
  command: string
  signal: AbortSignal
  shell?: TerminalShell
  pattern?: string
  /** Wait this long before returning (0 = immediate). */
  blockUntilMs: number
  /**
   * When the wait window (blockUntilMs) elapses and the process is still
   * running, hard-kill it and report a failure (exit_code 124) instead of
   * leaving it alive for later polls. Used for foreground new commands so the
   * agent waits for completion but never leaks a runaway process.
   */
  killOnTimeout?: boolean
  onOutput?: (chunk: { text: string; stream: 'stdout' | 'stderr' }) => void
  /** Forwarded to the inner poll — fired when the process outlives the wait window. */
  onStillRunning?: (sessionId: string) => void
  /** Run the shell inside this OS sandbox (main/agent/sandbox). Absent = unsandboxed. */
  sandbox?: SandboxLaunch
  /**
   * Kills the process when it aborts — the run's hard cancel. Defaults to
   * `signal`, which may also fire on a soft steer and must then only end the
   * wait, not the process.
   */
  lifetimeSignal?: AbortSignal
}

export async function startBackgroundTerminal(
  opts: StartBackgroundTerminalOpts
): Promise<string> {
  const command = opts.command.trim()
  if (!command) throw new Error('command is required to start a terminal session')

  const cwd = opts.cwd ?? opts.workspaceRoot
  const resolved = resolveTerminalShell(opts.shell ?? 'auto')
  const docxUnzip = terminalDocxUnzipPreflight(command, resolved, cwd)
  if (docxUnzip) return docxUnzip
  const nested = terminalNestedPowerShellPreflight(command, resolved, cwd)
  if (nested) return nested
  const selfKill = terminalSelfKillPreflight(command, resolved, cwd)
  if (selfKill) return selfKill
  if (resolved === 'bash' && !commandOnPath('bash')) {
    return [
      `cwd: ${cwd}`,
      'shell: bash',
      '',
      'bash was not found on PATH.',
      'exit_code: 1'
    ].join('\n')
  }
  if (resolved === 'powershell' && !commandOnPath('pwsh') && !commandOnPath('powershell')) {
    return [
      `cwd: ${cwd}`,
      'shell: powershell',
      '',
      'PowerShell was not found on PATH.',
      'exit_code: 1'
    ].join('\n')
  }

  // Reclaim finished sessions first so the cap reflects live shells only.
  pruneFinishedTerminalSessionsForInvoke(opts.runId, opts.invokeId)
  let invokeCount = 0
  for (const s of sessions.values()) {
    if (s.runId === opts.runId && s.invokeId === opts.invokeId && s.running) invokeCount++
  }
  if (invokeCount >= MAX_BACKGROUND_TERMINALS_PER_INVOKE) {
    return [
      `cwd: ${cwd}`,
      `shell: ${resolved}`,
      '',
      `Too many concurrent background terminal sessions for this invoke (limit ${MAX_BACKGROUND_TERMINALS_PER_INVOKE}). Wait for existing sessions to finish or dispose them.`,
      'exit_code: 1'
    ].join('\n')
  }
  if (countLiveTerminalSessionsGlobal() >= MAX_BACKGROUND_TERMINALS_GLOBAL) {
    return [
      `cwd: ${cwd}`,
      `shell: ${resolved}`,
      '',
      `Too many concurrent background terminal sessions app-wide (limit ${MAX_BACKGROUND_TERMINALS_GLOBAL}). Wait for existing sessions to finish or dispose them.`,
      'exit_code: 1'
    ].join('\n')
  }

  const spec = terminalSpawnSpec(command, resolved)
  const id = randomUUID()
  let pattern: RegExp | undefined
  if (opts.pattern?.trim()) {
    try {
      pattern = compileUserRegex(opts.pattern)
    } catch (err) {
      throw new Error(
        err instanceof Error ? `Invalid terminal pattern regex: ${err.message}` : `Invalid terminal pattern regex: ${opts.pattern}`
      )
    }
  }

  const launch: WrappedCommand = opts.sandbox ? opts.sandbox.wrap(spec.bin, spec.args) : spec
  const child = spawn(launch.bin, launch.args, {
    cwd,
    ...wrappedSpawnOptions(launch, agentCommandEnv()),
    windowsHide: true
  })
  if (child.pid) lowerProcessPriority(child.pid)

  const session: TerminalSession = {
    id,
    runId: opts.runId,
    invokeId: opts.invokeId,
    workspaceRoot: opts.workspaceRoot,
    cwd,
    command,
    shell: resolved,
    sandbox: opts.sandbox ? { label: opts.sandbox.label, network: opts.sandbox.network } : undefined,
    child,
    stdout: '',
    stderr: '',
    exitCode: null,
    running: true,
    status: 'running',
    pattern,
    patternMatched: false,
    createdAt: Date.now(),
    onOutput: opts.onOutput,
    waiters: new Set()
  }
  sessions.set(id, session)

  const onAbort = (): void => {
    if (session.running && child.pid) killProcessTree(child.pid, 'session-abort')
    session.running = false
    session.finishedAt ??= Date.now()
    session.status = 'aborted'
    notifySessionWaiters(session)
    void runExitFinalizers(id)
  }
  const lifetime = opts.lifetimeSignal ?? opts.signal
  if (lifetime.aborted) onAbort()
  else lifetime.addEventListener('abort', onAbort, { once: true })

  child.stdout?.on('data', (buf: Buffer) => {
    const text = decodeConsoleText(buf)
    // Same per-stream capture cap as the foreground terminal tool: bound
    // buffered output while the child keeps draining.
    if (session.stdout.length < TERMINAL_MAX_OUTPUT) {
      const room = TERMINAL_MAX_OUTPUT - session.stdout.length
      session.stdout += text.length > room ? text.slice(0, room) : text
    }
    if (text) session.onOutput?.({ text, stream: 'stdout' })
    if (session.pattern && !session.patternMatched && matchesPattern(session) && session.running) {
      session.status = 'pattern_matched'
      notifySessionWaiters(session)
    }
  })
  child.stderr?.on('data', (buf: Buffer) => {
    const text = decodeConsoleText(buf)
    if (session.stderr.length < TERMINAL_MAX_OUTPUT) {
      const room = TERMINAL_MAX_OUTPUT - session.stderr.length
      session.stderr += text.length > room ? text.slice(0, room) : text
    }
    if (text) session.onOutput?.({ text, stream: 'stderr' })
    if (session.pattern && !session.patternMatched && matchesPattern(session) && session.running) {
      session.status = 'pattern_matched'
      notifySessionWaiters(session)
    }
  })
  child.on('error', () => {
    session.running = false
    session.finishedAt ??= Date.now()
    session.status = 'done'
    session.exitCode = 1
    notifySessionWaiters(session)
    void runExitFinalizers(id)
  })
  child.on('close', (code) => {
    session.running = false
    session.finishedAt = Date.now()
    session.exitCode = normalizeChildExitCode(code)
    if (session.status === 'running' || session.status === 'pattern_matched') {
      session.status = matchesPattern(session) ? 'pattern_matched' : 'done'
    }
    lifetime.removeEventListener('abort', onAbort)
    notifySessionWaiters(session)
    void runExitFinalizers(id)
    if (session.kept) {
      logger.info('Kept background terminal exited', {
        scope: 'agent',
        correlationId: session.runId,
        exitCode: session.exitCode
      })
      notifyKeptChanged()
    }
  })

  return await pollTerminalSession({
    runId: opts.runId,
    invokeId: opts.invokeId,
    sessionId: id,
    blockUntilMs: opts.blockUntilMs,
    pattern: opts.pattern,
    signal: opts.signal,
    runSignal: opts.lifetimeSignal,
    killOnTimeout: opts.killOnTimeout,
    onStillRunning: opts.onStillRunning
  })
}

export type PollTerminalSessionOpts = {
  runId: string
  invokeId: number
  sessionId: string
  blockUntilMs: number
  pattern?: string
  signal: AbortSignal
  /** Hard run-cancel signal — distinguishes Cancelled (kill) from Interrupted (keep running). */
  runSignal?: AbortSignal
  /** Hard-kill (exit_code 124) instead of leaving the process running on timeout. */
  killOnTimeout?: boolean
  onOutput?: (chunk: { text: string; stream: 'stdout' | 'stderr' }) => void
  /**
   * The wait window elapsed with the process still running (tool returned
   * before completion). Register deferred work (checkpoint diff) for the
   * session's eventual exit here.
   */
  onStillRunning?: (sessionId: string) => void
}

export async function pollTerminalSession(opts: PollTerminalSessionOpts): Promise<string> {
  const session = sessions.get(opts.sessionId)
  assertSessionOwnership(session, opts.sessionId, opts.runId, opts.invokeId)
  if (opts.onOutput) session.onOutput = opts.onOutput
  if (opts.pattern?.trim()) {
    try {
      session.pattern = compileUserRegex(opts.pattern)
    } catch (err) {
      throw new Error(
        err instanceof Error
          ? `Invalid terminal pattern regex: ${err.message}`
          : `Invalid terminal pattern regex: ${opts.pattern}`
      )
    }
  }

  const deadline = Date.now() + Math.max(0, opts.blockUntilMs)
  let steered = false
  while (Date.now() < deadline) {
    if (opts.signal.aborted) {
      // Hard cancel kills the child so it cannot leak past the run; a soft
      // steer (follow-up) only ends this poll — the session stays alive and
      // un-poisoned so later polls keep working.
      const hardCancel = !opts.runSignal || opts.runSignal.aborted
      if (hardCancel) {
        if (session.running && session.child.pid) {
          killProcessTree(session.child.pid, 'poll-hard-cancel')
        }
        session.running = false
        session.finishedAt ??= Date.now()
        session.status = 'aborted'
        notifySessionWaiters(session)
      } else {
        steered = true
      }
      break
    }
    if (!session.running) break
    if (matchesPattern(session)) {
      session.status = 'pattern_matched'
      notifySessionWaiters(session)
      break
    }
    await waitForSessionEvent(session, opts.signal, deadline)
  }

  if (session.running && opts.blockUntilMs > 0 && session.status === 'running') {
    // A soft steer ended the wait early; that is not the wait expiring.
    if (opts.killOnTimeout && !steered) {
      // Foreground wait expired: hard-kill so the process cannot leak past the
      // run, and surface it as a failure the tool layer can flag.
      if (session.child.pid) killProcessTree(session.child.pid, 'poll-timeout-kill')
      session.running = false
      session.finishedAt ??= Date.now()
      session.exitCode = 124
      session.status = 'timeout'
      notifySessionWaiters(session)
      return formatSession(session)
    }
    // Timed out waiting; leave process running for further polls.
    opts.onStillRunning?.(session.id)
    return formatSession({ ...session, status: 'timeout' })
  }
  return formatSession(session)
}

// A cancel kills this run's background terminal sessions (runRegistry calls it).
registerRunCancelHooks({ disposeTerminals: (runId, invokeId) => void disposeTerminalSessionsForInvoke(runId, invokeId) })
