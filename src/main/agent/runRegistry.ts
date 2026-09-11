import { randomUUID } from 'crypto'
import { contentDisplayText, type AgentEvent, type AgentInteractionMode, type ChatMessage } from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { userMessageDisplayText } from '../../shared/slashCommands'
import { cancelPendingQuestions, dismissPendingQuestions } from './agentQuestion'

export type FollowUpEntry = {
  id: string
  message: ChatMessage
  /** True after the user clicks Send now — passive Enter-queue stays false until then. */
  ready?: boolean
}

type RunEntry = {
  controller: AbortController
  workspacePath: string
  invokeId: number
  /** True after a terminal event so follow-ups can start before cleanup finishes. */
  turnComplete: boolean
  forceFinishTimer: NodeJS.Timeout | null
  /** Mid-run user messages waiting to inject into the live loop. */
  followUps: FollowUpEntry[]
  /**
   * Soft-abort for the current provider stream only. Distinct from `controller`
   * so Stop still cancels the whole turn while follow-ups only interrupt the stream.
   */
  streamInterrupt: AbortController | null
}

export type RunAbortHandle = {
  controller: AbortController
  invokeId: number
}

export type EnqueueFollowUpResult =
  | { ok: true; id: string; position: number; queueLength: number }
  | { ok: false; error: string }

let rejectedRunStarts = 0

export function getRejectedRunStarts(): number {
  return rejectedRunStarts
}

export function resetRejectedRunStartsForTests(): void {
  rejectedRunStarts = 0
}

const active = new Map<string, RunEntry>()

/**
 * Global cap on concurrently live runs (chat starts and inline agent
 * instances). Without it a runaway spawner registers unbounded slots, each
 * holding model, terminal, and MCP resources. Resumes that re-enter through
 * `registerRunAbort` directly are not gated so crash recovery is never blocked.
 */
export const MAX_ACTIVE_RUNS = 8
/** Inline Agent V instance children keyed by parent run id (active abort map only). */
const inlineChildrenByParent = new Map<string, Set<string>>()

export function registerInlineChildRun(parentRunId: string, childRunId: string): void {
  let children = inlineChildrenByParent.get(parentRunId)
  if (!children) {
    children = new Set()
    inlineChildrenByParent.set(parentRunId, children)
  }
  children.add(childRunId)
}

export function unregisterInlineChildRun(childRunId: string): void {
  for (const [parentRunId, children] of inlineChildrenByParent.entries()) {
    if (!children.delete(childRunId)) continue
    if (children.size === 0) inlineChildrenByParent.delete(parentRunId)
    return
  }
}

export function getActiveInlineChildRunIds(parentRunId: string): string[] {
  const children = inlineChildrenByParent.get(parentRunId)
  if (!children) return []
  return [...children].filter((childId) => isActive(childId))
}

/** Composer mode queued for the next agent step (consumed by loop via takePendingMode). */
const pendingModeByRun = new Map<string, AgentInteractionMode>()
/** writes_checkpoint persisted in loop finally after the generator consumer ended. */
const lateWriteCheckpointByRun = new Map<string, AgentEvent>()
const lateFollowUpDroppedByRun = new Map<string, AgentEvent>()
/**
 * IPC takeLate* owns late-buffer cleanup after the generator ends, but a window
 * that never gets taken (renderer closed mid-teardown) would retain the event
 * forever. A delayed prune bounds that retention without racing the take window.
 */
const LATE_BUFFER_PRUNE_MS = 60_000
const lateBufferPruneTimers = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleLateBufferPrune(runId: string): void {
  if (lateBufferPruneTimers.has(runId)) return
  const timer = setTimeout(() => {
    lateBufferPruneTimers.delete(runId)
    lateWriteCheckpointByRun.delete(runId)
    lateFollowUpDroppedByRun.delete(runId)
  }, LATE_BUFFER_PRUNE_MS)
  // A cleanup timer must never hold the process (or a quit) open.
  timer.unref?.()
  lateBufferPruneTimers.set(runId, timer)
}

function cancelLateBufferPrune(runId: string): void {
  const timer = lateBufferPruneTimers.get(runId)
  if (!timer) return
  clearTimeout(timer)
  lateBufferPruneTimers.delete(runId)
}

/** Invalidate prior-run late state when a run id registers again (resume). */
function resetLateBufferState(runId: string): void {
  cancelLateBufferPrune(runId)
  lateWriteCheckpointByRun.delete(runId)
  lateFollowUpDroppedByRun.delete(runId)
}
let nextInvokeId = 1

/** Queue a mode switch to apply at the start of the next loop step. */
export function setPendingMode(runId: string, mode: AgentInteractionMode): void {
  pendingModeByRun.set(runId, mode)
}

/** Take and clear any queued mode switch for this run. */
export function takePendingMode(runId: string): AgentInteractionMode | undefined {
  const mode = pendingModeByRun.get(runId)
  if (mode !== undefined) pendingModeByRun.delete(runId)
  return mode
}

/** Loop finally may persist a checkpoint after the IPC consumer stopped yielding. */
export function setLateWriteCheckpoint(runId: string, event: AgentEvent): void {
  lateWriteCheckpointByRun.set(runId, event)
}

export function takeLateWriteCheckpoint(runId: string): AgentEvent | undefined {
  const event = lateWriteCheckpointByRun.get(runId)
  lateWriteCheckpointByRun.delete(runId)
  return event
}

/** Loop finally may drop follow-ups after the IPC consumer stopped yielding. */
export function setLateFollowUpDropped(runId: string, event: AgentEvent): void {
  lateFollowUpDroppedByRun.set(runId, event)
}

export function takeLateFollowUpDropped(runId: string): AgentEvent | undefined {
  const event = lateFollowUpDroppedByRun.get(runId)
  lateFollowUpDroppedByRun.delete(runId)
  return event
}

/** Register abort controller before the async loop starts so cancel works immediately. */
export function registerRunAbort(runId: string, workspacePath: string): RunAbortHandle {
  const existing = active.get(runId)
  // Reuse the live invoke. Never replace a turnComplete entry still unwinding —
  // overlapping runAgent finally blocks corrupt the same runDir.
  if (existing) {
    return { controller: existing.controller, invokeId: existing.invokeId }
  }

  const invokeId = nextInvokeId++
  const controller = new AbortController()
  active.set(runId, {
    controller,
    workspacePath,
    invokeId,
    turnComplete: false,
    forceFinishTimer: null,
    followUps: [],
    streamInterrupt: null
  })
  // Fresh registration — stale late buffers from a prior finish of this id are
  // meaningless now, and a pending prune timer must not eat the new run's ones.
  resetLateBufferState(runId)
  return { controller, invokeId }
}

/**
 * Atomic register for IPC chatStart — rejects if a run slot already exists.
 * Single-threaded: check+set with no await in between.
 */
export function tryRegisterRunAbort(
  runId: string,
  workspacePath: string
): { ok: true; controller: AbortController; invokeId: number } | { ok: false; error: string; code?: string } {
  if (active.has(runId)) {
    rejectedRunStarts++
    return { ok: false, error: 'Run is already active' }
  }
  if (active.size >= MAX_ACTIVE_RUNS) {
    rejectedRunStarts++
    // Surface the live count (M-7 audit): resumes bypass this gate, so
    // active.size can exceed the cap; and offline `wait_forever` runs hold
    // slots indefinitely — the count tells the user why chatStart is refused.
    return {
      ok: false,
      error: `Too many concurrent runs (max ${MAX_ACTIVE_RUNS}; ${active.size} active)`,
      code: 'RUN_LIMIT_REACHED'
    }
  }
  const handle = registerRunAbort(runId, workspacePath)
  return { ok: true, controller: handle.controller, invokeId: handle.invokeId }
}

/**
 * Close the turn for follow-up enqueue atomically.
 * If follow-ups are already queued, leave the turn open so the loop can drain them.
 */
export function tryBeginRunClosing(
  runId: string,
  invokeId: number
): 'closed' | 'has_followups' | 'stale' {
  const entry = active.get(runId)
  if (!entry || entry.invokeId !== invokeId) return 'stale'
  if (entry.followUps.length > 0) return 'has_followups'
  entry.turnComplete = true
  entry.streamInterrupt = null
  return 'closed'
}

/** Re-open follow-up enqueue after auto-continue keeps the same invoke alive. */
export function reopenRunTurn(runId: string, invokeId: number): boolean {
  const entry = active.get(runId)
  if (!entry || entry.invokeId !== invokeId) return false
  if (entry.controller.signal.aborted) return false
  entry.turnComplete = false
  return true
}

/** Allow follow-up enqueue to close; run stays in `active` until `clearRunAbort`. */
export function markRunTurnComplete(runId: string, invokeId: number): void {
  const entry = active.get(runId)
  if (entry && entry.invokeId === invokeId) {
    entry.turnComplete = true
    // Do not clear followUps here — a follow-up can land in the TOCTOU window
    // between the loop's last hasPendingFollowUps check and this mark. Queue is
    // cleared on cancel, drain, or clearRunAbort.
    entry.streamInterrupt = null
  }
}

type CancelGateWaitersOpts = {
  invokeId?: number
  /** Soft-steer enqueue: keep question prompts parked while a follow-up waits. */
  skipQuestions?: boolean
}

/** Clear parked approval/question waiters (lazy require for toolApproval avoids cycle). */
function cancelPendingGateWaiters(runId: string, opts?: CancelGateWaitersOpts): void {
  try {
    const { cancelPendingApprovals } = require('./toolApproval') as {
      cancelPendingApprovals: (runId: string, invokeId?: number) => void
    }
    cancelPendingApprovals(runId, opts?.invokeId)
  } catch {
    // ignore if modules unavailable in early boot / tests
  }
  if (!opts?.skipQuestions) {
    cancelPendingQuestions(runId, opts?.invokeId)
  }
}

/** Kill background terminal sessions immediately (lazy require avoids cycle). */
function disposeTerminalSessionsNow(runId: string, invokeId: number): void {
  try {
    const { disposeTerminalSessionsForInvoke } = require('./tools/terminalSessions') as {
      disposeTerminalSessionsForInvoke: (runId: string, invokeId: number) => number
    }
    disposeTerminalSessionsForInvoke(runId, invokeId)
  } catch {
    // ignore if modules unavailable in early boot / tests
  }
}

/**
 * Drop the persisted follow-up queue for a cancelled run (lazy require avoids
 * cycle). Enqueue persists followups.json; cancel clears the in-memory queue
 * here, so without the disk clear a later chatStart(resume) re-hydrates and
 * executes follow-ups the user already cancelled.
 */
function clearFollowUpsOnDiskNow(runId: string): void {
  try {
    const workspacePath = getRunWorkspace(runId)
    if (!workspacePath) return
    const { resolveRunDir } = require('../storage/paths') as {
      resolveRunDir: (workspacePath: string, runId: string) => string
    }
    const { clearFollowUps: clearDisk } = require('./followUpStore') as {
      clearFollowUps: (runDir: string) => void
    }
    clearDisk(resolveRunDir(workspacePath, runId))
  } catch {
    // ignore if modules unavailable in early boot / tests
  }
}

/**
 * Grace period before a cancelled run that never unwound is force-finalized.
 * The loop's own cancel path (loop.ts) persists `cancelled` within seconds;
 * only a loop frozen on an abort-unaware tool wait stays past this bound.
 */
const CANCEL_FORCE_FINISH_MS = 30_000
export { CANCEL_FORCE_FINISH_MS }

function armCancelForceFinish(runId: string, entry: RunEntry): void {
  if (entry.forceFinishTimer) clearTimeout(entry.forceFinishTimer)
  const timer = setTimeout(() => {
    void forceFinishCancelledRun(runId)
  }, CANCEL_FORCE_FINISH_MS)
  // A cleanup timer must never hold the process (or a quit) open.
  timer.unref?.()
  entry.forceFinishTimer = timer
}

function disarmCancelForceFinish(runId: string): void {
  const entry = active.get(runId)
  if (!entry?.forceFinishTimer) return
  clearTimeout(entry.forceFinishTimer)
  entry.forceFinishTimer = null
}

/**
 * A cancelled run whose loop never unwound (stuck on a tool that ignores the
 * abort) leaves status.json `running` — a zombie the sidebar renders as a live
 * spinner, and one `reconcileStaleRuns` skips forever because isActive stays
 * true. Persist the terminal status the loop will never write, and notify the
 * parent run so its sidebar instance row stops spinning. Safe to run after a
 * late normal unwind: both paths write the same terminal status, and
 * notifyChildTerminal is idempotent for already-resolved waiters.
 */
export async function forceFinishCancelledRun(runId: string): Promise<boolean> {
  if (!isActive(runId)) return false
  const workspacePath = getRunWorkspace(runId)
  if (!workspacePath) return false
  try {
    // Dynamic imports avoid state/agentInstances import cycles. Plain
    // require() here would resolve in the built CJS bundle but not under the
    // vitest ESM loader, which would silently skip the force-finish.
    const { resolveRunDir } = await import('../storage/paths')
    const { loadStatus, updateStatus, appendEvent } = await import('./state')
    const runDir = resolveRunDir(workspacePath, runId)
    const status = loadStatus(runDir)
    if (!status) return false
    if (status.status === 'done' || status.status === 'error' || status.status === 'cancelled') {
      return false
    }
    // Match the loop's own user-cancel contract (loop.ts writeStatus): a plain
    // terminal patch, no resumable flag — this was a cancel, not a crash.
    await updateStatus(runDir, { status: 'cancelled' }, { sync: true })
    appendEvent(runDir, {
      type: 'status',
      runId,
      status: 'cancelled',
      ...(status.invokeId != null ? { invokeId: status.invokeId } : {})
    })
    if (status.inlineInstance && status.parentRunId) {
      const { notifyChildTerminal } = await import('./agentInstances')
      notifyChildTerminal(runId, 'cancelled', undefined, {
        goal: status.goal,
        pathScope: status.pathScope
      })
    }
    const { invalidateListRunsCache } = await import('./runListCache')
    invalidateListRunsCache(workspacePath)
    logger.warn('Cancelled run never unwound — force-finalized on disk', {
      scope: 'agent',
      runId,
      correlationId: runId
    })
    return true
  } catch (err) {
    logger.warn('Cancelled run force-finish failed', {
      scope: 'agent',
      runId,
      err
    })
    return false
  }
}

function cancelRunCore(runId: string, cascadeChildren = true): boolean {
  if (cascadeChildren) {
    for (const childId of getActiveInlineChildRunIds(runId)) {
      cancelRunCore(childId, false)
    }
  }
  const entry = active.get(runId)
  if (!entry) return false
  entry.followUps = []
  entry.turnComplete = true
  entry.streamInterrupt?.abort()
  entry.streamInterrupt = null
  entry.controller.abort()
  armCancelForceFinish(runId, entry)
  cancelPendingGateWaiters(runId)
  disposeTerminalSessionsNow(runId, entry.invokeId)
  clearFollowUpsOnDiskNow(runId)
  return true
}

export function cancelRun(runId: string): boolean {
  return cancelRunCore(runId)
}

export function getRunAbort(runId: string): AbortController | undefined {
  return active.get(runId)?.controller
}

export function getRunWorkspace(runId: string): string | undefined {
  return active.get(runId)?.workspacePath
}

export function isActive(runId: string): boolean {
  // True until clearRunAbort — includes the post-terminal unwind window so
  // chatStart cannot overlap a prior invoke's finally.
  return active.has(runId)
}

/** True after a terminal event while `finally` is still flushing/disposing. */
export function isRunTurnComplete(runId: string): boolean {
  return active.get(runId)?.turnComplete === true
}

/** Wait until `clearRunAbort` removes the run (bounded). Returns false on timeout. */
export async function waitUntilRunInactive(
  runId: string,
  timeoutMs = 15_000
): Promise<boolean> {
  const started = Date.now()
  while (isActive(runId)) {
    if (Date.now() - started >= timeoutMs) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

/** Default bound for cancel-and-wait during quit. */
export const QUIT_RUN_QUIESCE_MS = 15_000

export type CancelAndWaitActiveRunsResult = {
  cancelled: number
  timedOut: string[]
}

/**
 * Abort every live run, then wait (bounded) until each slot is cleared.
 * Used on quit so persistence can finish before browser/PTY/MCP dispose.
 */
export async function cancelAndWaitActiveRuns(
  timeoutMs = QUIT_RUN_QUIESCE_MS
): Promise<CancelAndWaitActiveRunsResult> {
  const runs = listActiveRuns()
  for (const run of runs) {
    cancelRun(run.runId)
  }
  const timedOut: string[] = []
  await Promise.all(
    runs.map(async (run) => {
      const cleared = await waitUntilRunInactive(run.runId, timeoutMs)
      if (!cleared) timedOut.push(run.runId)
    })
  )
  return { cancelled: runs.length, timedOut }
}

/** True when this invoke still owns the run slot (no newer follow-up registered). */
export function isCurrentInvoke(runId: string, invokeId: number): boolean {
  const entry = active.get(runId)
  return entry?.invokeId === invokeId
}

export type ActiveRunInfo = {
  runId: string
  workspacePath: string
  invokeId: number
  pendingFollowUps: { id: string; preview: string }[]
}

export function followUpPreview(message: ChatMessage): string {
  const text = userMessageDisplayText(contentDisplayText(message.content)).trim()
  if (text) return text
  const content = message.content
  if (typeof content !== 'string') {
    const file = content.find((part) => part.type === 'file')
    if (file?.name) return file.name
  }
  return 'Follow-up'
}

export function listActiveRuns(): ActiveRunInfo[] {
  return [...active.entries()].map(([runId, entry]) => ({
    runId,
    workspacePath: entry.workspacePath,
    invokeId: entry.invokeId,
    pendingFollowUps: entry.followUps.map((item) => ({
      id: item.id,
      preview: followUpPreview(item.message)
    }))
  }))
}

export function getRunInvokeId(runId: string): number | undefined {
  return active.get(runId)?.invokeId
}

export function clearRunAbort(runId: string, invokeId?: number): void {
  const entry = active.get(runId)
  if (!entry) return
  if (invokeId !== undefined && entry.invokeId !== invokeId) return
  disarmCancelForceFinish(runId)
  active.delete(runId)
  pendingModeByRun.delete(runId)
  // Keep late checkpoint / follow_up_dropped buffers — IPC takeLate* owns cleanup
  // after the generator ends (set in runAgent finally, taken after for-await).
  // The delayed prune bounds retention when IPC never takes them.
  scheduleLateBufferPrune(runId)
}

/** Queue a user message for mid-run injection (passive — does not interrupt). */
export function enqueueFollowUp(runId: string, message: ChatMessage): EnqueueFollowUpResult {
  const entry = active.get(runId)
  // Reject once the run abort fired — otherwise IPC can ack follow_up_queued and
  // clearRunAbort later drops the message unapplied. Also reject after turnComplete:
  // the finally path may still hold the slot while persistence runs, and orphans
  // would otherwise be ack'd then dropped without disk sync.
  if (!entry || entry.controller.signal.aborted) {
    return { ok: false, error: 'Run is not active' }
  }
  if (entry.turnComplete) {
    return { ok: false, error: 'Run is finishing' }
  }
  if (message.role !== 'user') {
    return { ok: false, error: 'Follow-up must be a user message' }
  }
  const id = randomUUID()
  entry.followUps.push({ id, message })
  // Passive queue — no stream interrupt. The composer shows the item until the
  // user clicks Send now (promoteFollowUp) or the loop drains at a step boundary.
  return {
    ok: true,
    id,
    position: entry.followUps.length,
    queueLength: entry.followUps.length
  }
}

/** Remove a still-queued follow-up before the loop applies it. */
export function removeFollowUp(
  runId: string,
  id: string
): { ok: true; removed: boolean; queueLength: number } | { ok: false; error: string } {
  const entry = active.get(runId)
  if (!entry || entry.controller.signal.aborted) {
    return { ok: false, error: 'Run is not active' }
  }
  const before = entry.followUps.length
  entry.followUps = entry.followUps.filter((item) => item.id !== id)
  return {
    ok: true,
    removed: entry.followUps.length < before,
    queueLength: entry.followUps.length
  }
}

/** Replace a queued follow-up message before the loop applies it. */
export function updateFollowUp(
  runId: string,
  id: string,
  message: ChatMessage
): { ok: true; preview: string } | { ok: false; error: string } {
  const entry = active.get(runId)
  if (!entry || entry.controller.signal.aborted) {
    return { ok: false, error: 'Run is not active' }
  }
  if (message.role !== 'user') {
    return { ok: false, error: 'Follow-up must be a user message' }
  }
  const queued = entry.followUps.find((item) => item.id === id)
  if (!queued) return { ok: false, error: 'Follow-up not found' }
  queued.message = message
  return { ok: true, preview: followUpPreview(message) }
}

/** Move a queued follow-up to the front and interrupt the live stream. */
export function promoteFollowUp(
  runId: string,
  id: string
): { ok: true; queueLength: number } | { ok: false; error: string } {
  const entry = active.get(runId)
  if (!entry || entry.controller.signal.aborted) {
    return { ok: false, error: 'Run is not active' }
  }
  const idx = entry.followUps.findIndex((item) => item.id === id)
  if (idx < 0) return { ok: false, error: 'Follow-up not found' }
  const [item] = entry.followUps.splice(idx, 1)
  item.ready = true
  entry.followUps.unshift(item)
  entry.streamInterrupt?.abort()
  dismissPendingQuestions(runId, entry.invokeId)
  cancelPendingGateWaiters(runId, {
    invokeId: entry.invokeId,
    skipQuestions: true
  })
  return { ok: true, queueLength: entry.followUps.length }
}

export function hasPendingFollowUps(runId: string): boolean {
  const entry = active.get(runId)
  if (!entry) return false
  return entry.followUps.length > 0
}

/** Follow-ups the user promoted with Send now — eligible for loop drain/steer. */
export function hasReadyFollowUps(runId: string): boolean {
  const entry = active.get(runId)
  if (!entry) return false
  return entry.followUps.some((item) => item.ready)
}

export function peekFollowUps(runId: string): FollowUpEntry[] {
  const entry = active.get(runId)
  if (!entry) return []
  return entry.followUps.slice()
}

/** Replace the in-memory queue (e.g. after loading followups.json on resume). */
export function seedFollowUps(runId: string, entries: FollowUpEntry[]): void {
  const entry = active.get(runId)
  if (!entry) return
  entry.followUps = entries.map((item) => ({ ...item, message: { ...item.message } }))
}

/** Take the next queued follow-up (FIFO), regardless of ready state — turn-end auto-apply. */
export function takeNextFollowUp(runId: string): FollowUpEntry | undefined {
  const entry = active.get(runId)
  if (!entry || entry.followUps.length === 0) return undefined
  return entry.followUps.shift()
}

/** Take the front follow-up only when promoted (Send now). */
export function takeNextReadyFollowUp(runId: string): FollowUpEntry | undefined {
  const entry = active.get(runId)
  if (!entry || entry.followUps.length === 0) return undefined
  if (!entry.followUps[0]?.ready) return undefined
  return entry.followUps.shift()
}

/** Take promoted follow-ups only (FIFO among ready items). */
export function drainReadyFollowUps(runId: string): FollowUpEntry[] {
  const drained: FollowUpEntry[] = []
  for (;;) {
    const next = takeNextReadyFollowUp(runId)
    if (!next) break
    drained.push(next)
  }
  return drained
}

/** Take all pending follow-ups (FIFO) — test/cleanup helper. */
export function drainFollowUps(runId: string): FollowUpEntry[] {
  const entry = active.get(runId)
  if (!entry) return []
  const drained = entry.followUps
  entry.followUps = []
  return drained
}

export function clearFollowUps(runId: string): void {
  const entry = active.get(runId)
  if (!entry) return
  entry.followUps = []
}

/** Bind a soft-abort controller for the current stream step. */
export function setStreamInterrupt(runId: string, controller: AbortController | null): void {
  const entry = active.get(runId)
  if (!entry) return
  entry.streamInterrupt = controller
}

export function getStreamInterrupt(runId: string): AbortController | undefined {
  return active.get(runId)?.streamInterrupt ?? undefined
}

/** Combined signal: run cancel OR soft stream interrupt. */
export function streamSignalFor(runId: string, runSignal: AbortSignal): AbortSignal {
  const entry = active.get(runId)
  const soft = entry?.streamInterrupt?.signal
  if (!soft) return runSignal
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([runSignal, soft])
  }
  // Fallback when AbortSignal.any is unavailable: mirror either abort into a local controller.
  if (runSignal.aborted || soft.aborted) {
    const done = new AbortController()
    done.abort()
    return done.signal
  }
  const combined = new AbortController()
  const onAbort = (): void => {
    runSignal.removeEventListener('abort', onAbort)
    soft.removeEventListener('abort', onAbort)
    if (!combined.signal.aborted) combined.abort()
  }
  runSignal.addEventListener('abort', onAbort, { once: true })
  soft.addEventListener('abort', onAbort, { once: true })
  return combined.signal
}

/** Test helper — clear active controllers between tests. */
export function resetActiveRunsForTests(): void {
  for (const entry of active.values()) {
    entry.streamInterrupt?.abort()
    entry.controller.abort()
  }
  active.clear()
  inlineChildrenByParent.clear()
  pendingModeByRun.clear()
  lateWriteCheckpointByRun.clear()
  lateFollowUpDroppedByRun.clear()
  nextInvokeId = 1
  resetRejectedRunStartsForTests()
}

/** Pure cancel helper (no Electron) — used by IPC and tests. */
export function chatCancelResult(
  runId: string
): { ok: true; data: true } | { ok: false; error: string } {
  if (!cancelRunCore(runId)) {
    return { ok: false, error: 'Run not found' }
  }
  return { ok: true, data: true }
}
