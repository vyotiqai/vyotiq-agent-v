import { existsSync, readFileSync, watch, type FSWatcher } from 'fs'
import { dirname, join, resolve } from 'path'
import type { WebContents } from 'electron'
import type { AgentEvent, AgentInteractionMode, ChatMessage, RunReceipt } from '../../shared/ipc'
import { contentDisplayText, DEFAULT_MAX_PARALLEL_INSTANCES, RunReceiptSchema } from '../../shared/ipc'
import { getSettings } from '@main/settings/settings'
import { recallRunModelSelection } from './runModelSelection'
import { IPC } from '../../shared/channels'
import { formatAgentInstanceLabel } from '../../shared/utils/agentInstance'
import {
  emptyStepUsageTotals,
  instanceUsageOf,
  mergeStepUsageTotals,
  stepUsageFromEvent,
  type StepUsageTotals
} from '../../shared/utils/runTelemetry'
import { activityOf } from './runActivity'
import { logger } from '../../shared/logger'
import { abortError } from '../../shared/errors'
import { AWAIT_AGENT_INSTANCE_MAX_MS } from './schemas/tools'
import { getMainWindow } from '../app/window'
import {
  addInstanceWorktree,
  finalizeInstanceWorktree,
  isInstanceWorktreeFallbackError,
  isSafeInstanceWorktreePath,
  mergeInstanceBranch,
  type MergeInstanceBranchResult
} from '../git/instanceWorktree'
import { appendEvent, createRun, loadMessagesAsync, loadStatus } from './state'
import { resolveRunDir } from '@main/storage/paths'
import { createRunId } from './loop'
import { RUN_RECEIPT_FILENAME } from './runReceipt'
import { migrateLegacyReceipt } from './receiptMigration'
import {
  finishInstanceSpend,
  noteLiveInstanceSpend,
  registerInstanceTask,
  spendOf,
  unregisterInstanceTask
} from './taskSpend'
import {
  clearRunAbort,
  cancelRun,
  getRunInvokeId,
  registerInlineChildRun,
  tryRegisterRunAbort,
  unregisterInlineChildRun,
  isActive
} from './runRegistry'
import { startAgentRunInBackground } from './startAgentRun'
import { excludeChatEventUiSubscription } from '../ipc/streamBatch'
import { isSafePathScopePrefix } from './tools/writeGuard'
import { disposeWorkspaceIndexes } from './workspaceIndex'
import { copyWorkspaceIndexesForInstance } from './indexInheritance'

const childToParent = new Map<string, string>()
const childWorkspace = new Map<string, string>()
const childWaiters = new Map<
  string,
  Set<(result: { phase: 'done' | 'error' | 'cancelled'; summary: string }) => void>
>()
const runIpcSenders = new Map<string, WebContents>()
const parentInstanceEmitters = new Map<string, (event: AgentEvent) => void>()

/**
 * What a running child is doing, for its parent's record: without it the
 * parent heard "started" and then, minutes later, "done" — its rows could say
 * nothing in between, and its bill left the children out.
 */
type ChildProgress = {
  stepId?: string
  step: number
  activity?: string
  usage: StepUsageTotals
  /** When the last progress update went out, and one waiting to go. */
  sentAt: number
  timer?: ReturnType<typeof setTimeout>
}
const childProgress = new Map<string, ChildProgress>()
/** At most one live progress update per child per this many ms. */
const PROGRESS_INTERVAL_MS = 1_000
/**
 * Child-status waits are event-driven (fs.watch on the child's run dir) with
 * this as the backstop recheck — a polling timer on a long await did a sync
 * `status.json` read twice a second for the whole wait.
 */
const CHILD_WATCH_DEBOUNCE_MS = 150
const CHILD_WATCH_BACKSTOP_MS = 5_000

export { formatAgentInstanceLabel }

export function registerRunIpcSender(runId: string, wc: WebContents): () => void {
  runIpcSenders.set(runId, wc)
  return () => {
    if (runIpcSenders.get(runId) === wc) runIpcSenders.delete(runId)
  }
}

export function getRunIpcSender(runId: string): WebContents | undefined {
  const wc = runIpcSenders.get(runId)
  if (wc?.isDestroyed()) {
    runIpcSenders.delete(runId)
    return undefined
  }
  return wc
}

/** Instances of this task still running. */
export function runningInstanceCount(parentRunId: string): number {
  let n = 0
  for (const [child, parent] of childToParent) {
    if (parent === parentRunId && isActive(child)) n += 1
  }
  return n
}

function instanceCap(): number {
  try {
    return getSettings().maxParallelInstances ?? DEFAULT_MAX_PARALLEL_INSTANCES
  } catch {
    return DEFAULT_MAX_PARALLEL_INSTANCES
  }
}

function resolveSpawnWebContents(parentRunId: string): WebContents | undefined {
  const registered = getRunIpcSender(parentRunId)
  if (registered) return registered
  const current = getMainWindow()
  if (
    current &&
    !current.isDestroyed() &&
    !current.webContents.isDestroyed()
  ) {
    return current.webContents
  }
  return undefined
}

export function registerParentInstanceEmitter(
  parentRunId: string,
  emit: (event: AgentEvent) => void
): () => void {
  parentInstanceEmitters.set(parentRunId, emit)
  return () => {
    if (parentInstanceEmitters.get(parentRunId) === emit) {
      parentInstanceEmitters.delete(parentRunId)
    }
  }
}

export function registerChildInstance(
  parentRunId: string,
  childRunId: string,
  workspacePath: string
): void {
  childToParent.set(childRunId, parentRunId)
  childWorkspace.set(childRunId, workspacePath)
  registerInlineChildRun(parentRunId, childRunId)
  // Its spend counts toward the task's spend limit (taskSpend.ts).
  registerInstanceTask(childRunId, { runId: parentRunId, runDir: resolveRunDir(workspacePath, parentRunId) })
}

/**
 * Drop every in-memory trace of a child. Always purges all four registries:
 * a child whose run dir vanished (deleted, or a `status.json` too corrupt for
 * `loadStatus` to parse) has no parent link left to read, and the old early
 * return on a missing parent left `childWorkspace`/`childProgress` entries (and
 * the inline-child set in the run registry) behind for the rest of the app's
 * life — a leak, not a no-op. Safe to call repeatedly for an unknown child.
 */
export function unregisterChildInstance(childRunId: string): void {
  childToParent.delete(childRunId)
  childWorkspace.delete(childRunId)
  const progress = childProgress.get(childRunId)
  if (progress?.timer) clearTimeout(progress.timer)
  childProgress.delete(childRunId)
  unregisterInlineChildRun(childRunId)
  unregisterInstanceTask(childRunId)
}

function sendLiveParentInstanceEvent(parentRunId: string, event: AgentEvent): void {
  const liveEmit = parentInstanceEmitters.get(parentRunId)
  if (liveEmit) {
    liveEmit(event)
    return
  }
  // Parent invoke ended — still deliver to UI (do not depend on parentInstanceEmitters).
  const invokeId = getRunInvokeId(parentRunId)
  const payload = invokeId != null ? { ...event, invokeId } : event
  const current = getMainWindow()
  const target =
    current && !current.isDestroyed() && !current.webContents.isDestroyed()
      ? current.webContents
      : getRunIpcSender(parentRunId)
  if (!target || target.isDestroyed()) return
  target.send(IPC.chatEvent, payload)
}

export function emitAgentInstanceUpdate(
  workspacePath: string,
  parentRunId: string,
  update: Omit<Extract<AgentEvent, { type: 'agent_instance_update' }>, 'type' | 'runId'>
): void {
  const event: AgentEvent = {
    type: 'agent_instance_update',
    runId: parentRunId,
    ...update
  }
  appendEvent(resolveRunDir(workspacePath, parentRunId), event)
  sendLiveParentInstanceEvent(parentRunId, event)
}

function sendChildProgress(childRunId: string): void {
  const progress = childProgress.get(childRunId)
  const parentRunId = childToParent.get(childRunId)
  if (!progress || !parentRunId) return
  if (progress.timer) {
    clearTimeout(progress.timer)
    progress.timer = undefined
  }
  progress.sentAt = Date.now()
  // Live only: progress is how the row reads while it runs, and a reload of
  // a finished run has the terminal update, which carries the final usage.
  sendLiveParentInstanceEvent(parentRunId, {
    type: 'agent_instance_update',
    runId: parentRunId,
    parentRunId,
    instanceRunId: childRunId,
    phase: 'started',
    at: new Date(progress.sentAt).toISOString(),
    ...(progress.stepId ? { stepId: progress.stepId } : {}),
    step: progress.step,
    ...(progress.activity ? { activity: progress.activity } : {}),
    usage: instanceUsageOf(progress.usage)
  })
}

function scheduleChildProgress(childRunId: string, progress: ChildProgress): void {
  const wait = progress.sentAt + PROGRESS_INTERVAL_MS - Date.now()
  if (wait <= 0) {
    sendChildProgress(childRunId)
    return
  }
  if (!progress.timer) progress.timer = setTimeout(() => sendChildProgress(childRunId), wait)
}

/**
 * Every event a child run yields passes here (startAgentRun's stream loop);
 * anything that is not an inline child returns at once. A new step, a tool
 * starting and a step's usage are what the parent's row shows.
 */
export function noteInstanceChildEvent(childRunId: string, ev: AgentEvent): void {
  const progress = childProgress.get(childRunId)
  if (!progress || !childToParent.has(childRunId)) return
  if (ev.type === 'context_usage') {
    if (ev.step === progress.step) return
    progress.step = ev.step
    progress.activity = 'Thinking'
  } else if (ev.type === 'tool_start') {
    progress.activity = activityOf(ev.name, ev.summary)
  } else if (ev.type === 'step_usage') {
    const usage = stepUsageFromEvent(ev)
    if (!usage) return
    progress.usage = mergeStepUsageTotals(progress.usage, usage)
    noteLiveInstanceSpend(childRunId, spendOf(progress.usage))
  } else {
    return
  }
  scheduleChildProgress(childRunId, progress)
}

function instanceUiStatusLine(phase: 'done' | 'error' | 'cancelled'): string {
  if (phase === 'cancelled') return 'Instance cancelled.'
  if (phase === 'error') return 'Instance failed.'
  return 'Instance finished.'
}

export function notifyChildTerminal(
  childRunId: string,
  phase: 'done' | 'error' | 'cancelled',
  waiterSummary?: string,
  opts?: { goal?: string; pathScope?: string[] }
): void {
  const parentRunId = childToParent.get(childRunId)
  const workspacePath = childWorkspace.get(childRunId)
  if (!parentRunId || !workspacePath) return
  const progress = childProgress.get(childRunId)
  if (progress?.timer) {
    clearTimeout(progress.timer)
    progress.timer = undefined
  }
  // Written with the task, so the spend limit still counts it after a restart.
  if (progress) void finishInstanceSpend(childRunId, spendOf(progress.usage))
  emitAgentInstanceUpdate(workspacePath, parentRunId, {
    parentRunId,
    instanceRunId: childRunId,
    phase,
    summary: instanceUiStatusLine(phase),
    at: new Date().toISOString(),
    ...(opts?.goal ? { goal: opts.goal } : {}),
    ...(opts?.pathScope ? { pathScope: opts.pathScope } : {}),
    ...(progress?.stepId ? { stepId: progress.stepId } : {}),
    ...(progress && progress.usage.steps > 0 ? { step: progress.step, usage: instanceUsageOf(progress.usage) } : {})
  })
  const waiters = childWaiters.get(childRunId)
  if (!waiters) return
  childWaiters.delete(childRunId)
  if (waiterSummary !== undefined) {
    for (const resolve of waiters) resolve({ phase, summary: waiterSummary })
    return
  }
  void summarizeChildRunAsync(workspacePath, childRunId).then(
    (summary) => {
      for (const resolve of waiters) resolve({ phase, summary })
    },
    () => {
      for (const resolve of waiters) resolve({ phase, summary: instanceUiStatusLine(phase) })
    }
  )
}

export type PullAgentInstanceView = 'summary' | 'outline' | 'tail'

function readChildReceipt(runDir: string): RunReceipt | null {
  const receiptPath = join(runDir, RUN_RECEIPT_FILENAME)
  if (!existsSync(receiptPath)) return null
  try {
    const raw = JSON.parse(readFileSync(receiptPath, 'utf8')) as unknown
    // Migrate before the parse: `version` is a `z.literal(RUN_RECEIPT_VERSION)`,
    // so a receipt from an older build (v2/3/4) otherwise parses to null and the
    // parent silently loses this child's verification line and wroteFiles block.
    const parsed = RunReceiptSchema.safeParse(migrateLegacyReceipt(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Whether the child's own code passed a check after its last change, as its
 * receipt judged it — so the parent verifies from evidence, not only from the
 * child's prose. Nothing when the child wrote no code.
 */
function formatChildVerificationLine(receipt: RunReceipt | null): string | null {
  if (!receipt) return null
  const gate = receipt.verificationGate
  if (gate?.wouldFire) {
    return gate.reason === 'check_failed'
      ? 'verification: FAILED — the last check after its code changes did not pass'
      : 'verification: UNCHECKED — no test, typecheck or lint run passed after its last code change'
  }
  const v = receipt.verification
  if (!v?.lastMutationAt) return null
  return v.verifiedAfterLastMutation
    ? 'verification: checked — a check passed after its last code change'
    : 'verification: UNCHECKED — no test, typecheck or lint run passed after its last code change'
}

function formatWroteFilesBlock(wroteFiles: string[]): string | null {
  if (wroteFiles.length === 0) return null
  const lines = wroteFiles.map((p) => `- ${p}`)
  return `wroteFiles:\n${lines.join('\n')}`
}

/**
 * What an await hands the parent. Run dd5aafe0's three reports were all cut at
 * the old 6,000 and the parent answered from the stubs; this fits a full
 * report. `pull_agent_instance` view summary goes to the larger cap.
 */
const CHILD_SUMMARY_MAX_CHARS = 20_000
const CHILD_PULL_SUMMARY_MAX_CHARS = 60_000
const CHILD_OUTLINE_LINE_MAX_CHARS = 280
const CHILD_OUTLINE_MAX_CHARS = 10_000
const CHILD_TAIL_MAX_MESSAGES = 40
const CHILD_TAIL_MESSAGE_MAX_CHARS = 2_000
const CHILD_TAIL_MAX_CHARS = 12_000

function capChildText(text: string, max: number, more?: string): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n[...truncated ${text.length - max} chars${more ? ` — ${more}` : ''}]`
}

/**
 * `noun` labels the bare fallback — reached when a run produced neither a final
 * message nor a write record.
 */
function formatChildSummary(
  workspacePath: string,
  childRunId: string,
  messages: ChatMessage[]
): string {
  const runDir = resolveRunDir(workspacePath, childRunId)
  const status = loadStatus(runDir)
  const parts: string[] = []
  if (status?.error) {
    parts.push(status.error)
  } else {
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
    if (lastAssistant) {
      const text = contentDisplayText(lastAssistant.content).trim()
      if (text) parts.push(text)
    }
  }
  const receipt = readChildReceipt(runDir)
  const wroteBlock = formatWroteFilesBlock(receipt?.wroteFiles ?? [])
  if (wroteBlock) parts.push(wroteBlock)
  const verificationLine = formatChildVerificationLine(receipt)
  if (verificationLine) parts.push(verificationLine)
  if (parts.length > 0) return parts.join('\n\n')
  if (status?.status === 'cancelled') return 'Instance cancelled.'
  if (status?.status === 'error') return status.error ?? 'Instance failed.'
  return 'Instance finished.'
}

export async function summarizeChildRunAsync(
  workspacePath: string,
  childRunId: string
): Promise<string> {
  const summary = formatChildSummary(
    workspacePath,
    childRunId,
    await loadMessagesAsync(workspacePath, childRunId)
  )
  return capChildText(summary, CHILD_SUMMARY_MAX_CHARS, 'pull_agent_instance with view "summary" returns the rest')
}

function formatChildOutline(
  workspacePath: string,
  childRunId: string,
  messages: ChatMessage[]
): string {
  const runDir = resolveRunDir(workspacePath, childRunId)
  const status = loadStatus(runDir)
  const lines: string[] = [
    `${formatAgentInstanceLabel(childRunId)}`,
    `status: ${status?.status ?? 'unknown'}`,
    `messages: ${messages.length}`
  ]
  for (const [i, msg] of messages.entries()) {
    const text = contentDisplayText(msg.content).replace(/\s+/g, ' ').trim()
    const capped =
      text.length <= CHILD_OUTLINE_LINE_MAX_CHARS
        ? text
        : `${text.slice(0, CHILD_OUTLINE_LINE_MAX_CHARS)}…[truncated]`
    lines.push(`${i + 1}. ${msg.role}: ${capped || '(empty)'}`)
  }
  const receipt = readChildReceipt(runDir)
  const wroteBlock = formatWroteFilesBlock(receipt?.wroteFiles ?? [])
  if (wroteBlock) {
    lines.push('')
    lines.push(wroteBlock)
  }
  const verificationLine = formatChildVerificationLine(receipt)
  if (verificationLine) lines.push(verificationLine)
  return capChildText(lines.join('\n'), CHILD_OUTLINE_MAX_CHARS)
}

function formatChildTail(
  workspacePath: string,
  childRunId: string,
  messages: ChatMessage[]
): string {
  const runDir = resolveRunDir(workspacePath, childRunId)
  const status = loadStatus(runDir)
  const total = messages.length
  const shown = Math.min(CHILD_TAIL_MAX_MESSAGES, total)
  const parts: string[] = [
    `${formatAgentInstanceLabel(childRunId)}`,
    `status: ${status?.status ?? 'unknown'}`,
    `showing ${shown} of ${total} messages`
  ]
  for (const msg of messages.slice(total - shown)) {
    const raw = contentDisplayText(msg.content).trim() || '(empty)'
    parts.push(`\n\n[${msg.role}]\n${capChildText(raw, CHILD_TAIL_MESSAGE_MAX_CHARS)}`)
  }
  return capChildText(parts.join(''), CHILD_TAIL_MAX_CHARS)
}

export async function pullChildRun(
  workspacePath: string,
  childRunId: string,
  view: PullAgentInstanceView
): Promise<string> {
  const messages = await loadMessagesAsync(workspacePath, childRunId)
  switch (view) {
    case 'summary': {
      const status = loadStatus(resolveRunDir(workspacePath, childRunId))
      const summary = `${formatAgentInstanceLabel(childRunId)}\nstatus: ${status?.status ?? 'unknown'}\n\n${formatChildSummary(workspacePath, childRunId, messages)}`
      return capChildText(summary, CHILD_PULL_SUMMARY_MAX_CHARS)
    }
    case 'outline':
      return formatChildOutline(workspacePath, childRunId, messages)
    case 'tail':
      return formatChildTail(workspacePath, childRunId, messages)
    default: {
      const _exhaustive: never = view
      return _exhaustive
    }
  }
}

function terminalPhaseFromStatus(
  status: ReturnType<typeof loadStatus>
): 'done' | 'error' | 'cancelled' | null {
  if (!status) return null
  if (status.status === 'done') return 'done'
  if (status.status === 'error') return 'error'
  if (status.status === 'cancelled') return 'cancelled'
  return null
}

export function waitForChildTerminal(
  childRunId: string,
  workspacePath: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ phase: 'done' | 'error' | 'cancelled'; summary: string }> {
  if (signal?.aborted) {
    return Promise.reject(abortError())
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const watchers: FSWatcher[] = []
    let debounceTimer: ReturnType<typeof setTimeout> | undefined
    let backstopTimer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      settled = true
      clearTimeout(timer)
      if (debounceTimer) clearTimeout(debounceTimer)
      if (backstopTimer) clearTimeout(backstopTimer)
      for (const watcher of watchers) {
        try {
          watcher.close()
        } catch {
          // already closed
        }
      }
      watchers.length = 0
      signal?.removeEventListener('abort', onAbort)
      const waiters = childWaiters.get(childRunId)
      waiters?.delete(onResolve)
      if (waiters && waiters.size === 0) childWaiters.delete(childRunId)
    }
    const finish = (result: { phase: 'done' | 'error' | 'cancelled'; summary: string }): void => {
      if (settled) return
      cleanup()
      resolve(result)
    }
    const onResolve = (result: { phase: 'done' | 'error' | 'cancelled'; summary: string }) => {
      finish(result)
    }
    const onAbort = (): void => {
      if (settled) return
      cleanup()
      const err = new Error('Aborted')
      err.name = 'AbortError'
      reject(err)
    }
    const timer = setTimeout(() => {
      if (settled) return
      cleanup()
      reject(
        new Error(
          `Timed out waiting for ${formatAgentInstanceLabel(childRunId)} after ${timeoutMs} ms. ` +
            `Child is still running. Each await_agent_instance call waits at most ${AWAIT_AGENT_INSTANCE_MAX_MS} ms — timeout_ms is capped there, so a longer timeout_ms cannot extend a single wait. ` +
            'Await again to start another wait, use cancel_agent_instance to stop the child, or pull_agent_instance for its current state.'
        )
      )
    }, timeoutMs)

    // Register waiter first (avoids TOCTOU hang if child finishes between check and register).
    const waiters = childWaiters.get(childRunId) ?? new Set()
    waiters.add(onResolve)
    childWaiters.set(childRunId, waiters)
    signal?.addEventListener('abort', onAbort, { once: true })

    const recheck = (): void => {
      if (settled) return
      const status = loadStatus(resolveRunDir(workspacePath, childRunId))
      if (!status) {
        // `loadStatus` answers null for a run dir that vanished and for a
        // `status.json` too corrupt to parse. Either way the child has no
        // status left to wait on, and the inline finish path that normally
        // unregisters it needs a parent link plus a startAgentRun finally that
        // saw the status — neither exists for a child whose dir is gone, so
        // its maps entry outlived the run. Memory-only: the run's abort entry
        // and its disk state are untouched, so this cannot end a run.
        unregisterChildInstance(childRunId)
        return
      }
      const phase = terminalPhaseFromStatus(status)
      if (phase) {
        void summarizeChildRunAsync(workspacePath, childRunId).then(
          (summary) => {
            finish({ phase, summary })
          },
          () => {
            finish({ phase, summary: instanceUiStatusLine(phase) })
          }
        )
        return
      }
      if (status?.status === 'running' && !isActive(childRunId)) {
        finish({
          phase: 'error',
          summary: `${formatAgentInstanceLabel(childRunId)} is not running.`
        })
      }
    }
    recheck()
    if (settled) return

    // After app restart the maps are empty, so nothing will resolve the waiter
    // in memory: follow the child's run dir on the filesystem instead of
    // re-reading `status.json` on a 500 ms timer. The run dir's parent is
    // watched too, so a child whose dir is still being created is picked up.
    // The backstop timer only re-reads; it can never end this wait early —
    // only the caller's own timeoutMs (unchanged) rejects.
    const hasRegistration = childToParent.has(childRunId) || childWorkspace.has(childRunId)
    if (!hasRegistration) {
      const onFsEvent = (): void => {
        if (settled) return
        if (debounceTimer) clearTimeout(debounceTimer)
        // status.json is replaced atomically — collapse the burst of events a
        // single write produces into one read.
        debounceTimer = setTimeout(recheck, CHILD_WATCH_DEBOUNCE_MS)
      }
      const armBackstop = (): void => {
        if (settled) return
        backstopTimer = setTimeout(() => {
          recheck()
          armBackstop()
        }, CHILD_WATCH_BACKSTOP_MS)
        backstopTimer.unref?.()
      }
      const runDir = resolveRunDir(workspacePath, childRunId)
      for (const target of [runDir, dirname(runDir)]) {
        try {
          const watcher = watch(target, { persistent: false }, onFsEvent)
          watcher.on('error', () => {
            try {
              watcher.close()
            } catch {
              // already closed
            }
          })
          watchers.push(watcher)
        } catch {
          // Not watchable here (missing dir, platform without fs events) —
          // the backstop recheck still covers it.
        }
      }
      armBackstop()
    }
  })
}

/**
 * Record a hard tool denial for an inline instance. Run-stopping caps removed
 * (user decision): denials are logged but never cancel the instance — the
 * loop keeps going and the user decides when to stop it. Always returns
 * false (never cancelled here).
 */
export function noteInlineInstanceDeniedTool(childRunId: string | undefined): boolean {
  if (!childRunId || !childToParent.has(childRunId)) return false
  logger.warn('Inline instance tool call denied', {
    scope: 'agent',
    childRunId
  })
  return false
}

/** Parent-side cancel for an inline child (cancel_agent_instance tool). */
export function cancelChildInstance(
  workspacePath: string,
  parentRunId: string,
  childRunId: string
): { ok: true; phase: 'cancelled' | 'already-terminal' } | { ok: false; error: string } {
  const childStatus = loadStatus(resolveRunDir(workspacePath, childRunId))
  if (!childStatus?.inlineInstance || childStatus.parentRunId !== parentRunId) {
    return { ok: false, error: 'run_id is not an inline instance spawned by this parent run' }
  }
  const terminalPhase = terminalPhaseFromStatus(childStatus)
  if (terminalPhase) {
    return { ok: true, phase: 'already-terminal' }
  }
  if (!cancelRun(childRunId)) {
    // Not registered in-memory (e.g. spawned before an app restart). The disk
    // status is still non-terminal, but there is no live loop left to abort.
    return {
      ok: false,
      error:
        'Instance is not running in this app session (background instances do not survive restart).'
    }
  }
  return { ok: true, phase: 'cancelled' }
}

export type SpawnAgentInstanceInput = {
  parentRunId: string
  workspacePath: string
  goal: string
  outcome: string
  subTasks: string[]
  doneWhen: string
  pathScope?: string[]
  isolation?: 'worktree' | 'shared'
  /** The plan step (todo id) this child carries out. */
  stepId?: string
  /** A read-and-report child: Ask mode, in this workspace, no worktree. */
  readOnly?: boolean
  emitParentEvent?: (event: AgentEvent) => void
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A worktree child is sandboxed to its checkout, so a brief naming the
 * parent's absolute root points outside it: run dd5aafe0's children each spent
 * reasoning on "the path is outside the sandbox". The same file lives at the
 * same relative path in the worktree, so the root is rewritten there.
 */
export function rewriteWorkspaceRoot(text: string, fromRoot: string, toRoot: string): string {
  const from = resolve(fromRoot).replace(/[\\/]+$/, '')
  if (!from) return text
  // Either slash style, case-insensitive where the filesystem is.
  const pattern = escapeRegExp(from).replace(/\\\\/g, '[\\\\/]')
  const flags = process.platform === 'win32' || process.platform === 'darwin' ? 'gi' : 'g'
  return text.replace(new RegExp(pattern, flags), () => toRoot)
}

export type SpawnAgentInstanceResult =
  | {
      ok: true
      runId: string
      label: string
      worktreeBranch?: string
      /** Why a child asked for a worktree runs shared in path_scope instead. */
      sharedBecause?: string
    }
  | { ok: false; error: string }

function resolveSpawnPathScope(
  raw: string[] | undefined
): { ok: true; pathScope?: string[] } | { ok: false; error: string } {
  if (!raw?.length) return { ok: true }
  const pathScope: string[] = []
  for (const entry of raw) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    if (!isSafePathScopePrefix(trimmed)) {
      return {
        ok: false,
        error:
          `path_scope entry is not a safe workspace-relative path: ${trimmed}. ` +
          'path_scope only accepts workspace-relative prefixes inside this workspace — ' +
          'omit it entirely when git worktree isolation is available.'
      }
    }
    pathScope.push(trimmed)
  }
  return { ok: true, pathScope: pathScope.length > 0 ? pathScope : undefined }
}

export async function spawnAgentInstance(
  input: SpawnAgentInstanceInput
): Promise<SpawnAgentInstanceResult> {
  const parentStatusDir = resolveRunDir(input.workspacePath, input.parentRunId)
  const parentStatus = loadStatus(parentStatusDir)
  if (parentStatus?.inlineInstance || parentStatus?.parentRunId) {
    return { ok: false, error: 'Inline instances cannot spawn nested instances (depth limit 1).' }
  }

  const wc = resolveSpawnWebContents(input.parentRunId)
  if (!wc) {
    return { ok: false, error: 'No active UI window available; cannot spawn inline instance.' }
  }

  const childRunId = createRunId()
  excludeChatEventUiSubscription(childRunId)
  const registered = tryRegisterRunAbort(childRunId, input.workspacePath)
  if (!registered.ok) {
    return { ok: false, error: registered.error }
  }

  const goalText = input.goal.trim()
  if (!goalText) {
    clearRunAbort(childRunId, registered.invokeId)
    return { ok: false, error: 'goal is required' }
  }

  const outcome = input.outcome.trim()
  if (!outcome) {
    clearRunAbort(childRunId, registered.invokeId)
    return { ok: false, error: 'outcome is required' }
  }

  if (!Array.isArray(input.subTasks) || input.subTasks.length === 0) {
    clearRunAbort(childRunId, registered.invokeId)
    return { ok: false, error: 'sub_tasks must be a non-empty array of strings' }
  }
  const subTasks: string[] = []
  for (const task of input.subTasks) {
    const trimmedTask = task.trim()
    if (!trimmedTask) {
      clearRunAbort(childRunId, registered.invokeId)
      return { ok: false, error: 'sub_tasks must be a non-empty array of strings' }
    }
    subTasks.push(trimmedTask)
  }

  const doneWhen = input.doneWhen.trim()
  if (!doneWhen) {
    clearRunAbort(childRunId, registered.invokeId)
    return { ok: false, error: 'done_when is required' }
  }

  const scoped = resolveSpawnPathScope(input.pathScope)
  if (!scoped.ok) {
    clearRunAbort(childRunId, registered.invokeId)
    return scoped
  }
  const pathScope = scoped.pathScope

  const briefLines = [
    `Outcome: ${outcome}`,
    '',
    'Sub-tasks:',
    ...subTasks.map((task, i) => `${i + 1}. ${task}`),
    '',
    `Done when: ${doneWhen}`
  ]
  if (pathScope?.length) {
    briefLines.push(`Paths: ${pathScope.join(', ')}`)
  }
  // The goal is appended verbatim as the child's background. When the caller's
  // goal *was* the brief — the Task/subagent alias sends a single prompt and the
  // arg normalizer backfills the missing brief fields from it — appending it
  // again would compose the same text into the child prompt up to four times.
  if (goalText !== outcome && goalText !== doneWhen && !subTasks.includes(goalText)) {
    briefLines.push(goalText)
  }
  const composedGoal = briefLines.join('\n')
  // Settings → Agent → Instances at once. Counted and registered with no await
  // between, so spawns in one step cannot both pass the check.
  const cap = instanceCap()
  const running = runningInstanceCount(input.parentRunId)
  if (running >= cap) {
    clearRunAbort(childRunId, registered.invokeId)
    return {
      ok: false,
      error:
        `This task already has ${running} ${running === 1 ? 'instance' : 'instances'} running — the most Settings → Agent → Instances at once allows (${cap}). ` +
        'Wait for one with await_agent_instance, then spawn the next.'
    }
  }
  registerChildInstance(input.parentRunId, childRunId, input.workspacePath)
  const releaseChildIpc = registerRunIpcSender(childRunId, wc)

  // A read-and-report child runs in Ask mode (read-only tools, enforced by
  // the mode gate) right in this workspace: nothing to isolate, so no
  // worktree — run dd5aafe0 spent 19 s creating three, one at a time behind
  // the worktree lock, for children that only read.
  const readOnly = input.readOnly === true
  const mode: AgentInteractionMode = readOnly ? 'ask' : 'agent'
  // Write-capable instances get a git worktree when possible; otherwise shared
  // + required path_scope. isolation: 'shared' skips the worktree (requires
  // path_scope) for cheap, disjoint-scope workstreams.
  let worktreePath: string | undefined
  let worktreeBranch: string | undefined
  let sharedBecause: string | undefined
  if (readOnly) {
    // Nothing to set up.
  } else if (input.isolation === 'shared') {
    if (!pathScope?.length) {
      releaseChildIpc()
      unregisterChildInstance(childRunId)
      clearRunAbort(childRunId, registered.invokeId)
      return {
        ok: false,
        error:
          "isolation: 'shared' requires path_scope so shared-workspace writes stay constrained. " +
          'Pass workspace-relative path prefixes, or omit isolation to get a git worktree.'
      }
    }
  } else {
    const wt = await addInstanceWorktree(input.workspacePath, childRunId, pathScope)
    if (wt.ok) {
      worktreePath = wt.worktreePath
      worktreeBranch = wt.branch
    } else if (!isInstanceWorktreeFallbackError(wt.error)) {
      releaseChildIpc()
      unregisterChildInstance(childRunId)
      clearRunAbort(childRunId, registered.invokeId)
      return { ok: false, error: wt.error }
    } else if (pathScope?.length) {
      // Run 528a737f's children fell back here with nothing said: they found
      // out only when `terminal` was refused to them.
      sharedBecause = wt.error
      logger.warn('instance worktree unavailable; child runs shared in path_scope', {
        scope: 'agentInstances',
        childRunId,
        reason: wt.error
      })
    } else {
      releaseChildIpc()
      unregisterChildInstance(childRunId)
      clearRunAbort(childRunId, registered.invokeId)
      return {
        ok: false,
        error:
          `Cannot isolate instance (no git worktree). Pass path_scope so shared-workspace writes stay constrained, or use a git repository. Workspace resolved to "${resolve(
            input.workspacePath
          )}", which is not a git repository.`
      }
    }
  }

  // Warm-start the child's code index from the
  // parent workspace so its first codebase_search is already warm instead of
  // re-indexing identical code. Best-effort: a failed
  // copy only costs the child a cold start.
  if (worktreePath) {
    try {
      await copyWorkspaceIndexesForInstance(input.workspacePath, worktreePath)
    } catch (err) {
      logger.warn('instance index inheritance failed', {
        scope: 'agentInstances',
        err
      })
    }
  }

  const childPrompt = worktreePath ? rewriteWorkspaceRoot(composedGoal, input.workspacePath, worktreePath) : composedGoal
  try {
    createRun(input.workspacePath, childRunId, childPrompt, {
      mode,
      parentRunId: input.parentRunId,
      inlineInstance: true,
      ...(pathScope?.length ? { pathScope } : {}),
      ...(worktreePath ? { worktreePath } : {}),
      ...(worktreeBranch ? { worktreeBranch } : {})
    })
  } catch (err) {
    releaseChildIpc()
    unregisterChildInstance(childRunId)
    clearRunAbort(childRunId, registered.invokeId)
    if (worktreePath) {
      await finalizeInstanceWorktree(input.workspacePath, worktreePath, {
        keepBranch: false,
        branch: worktreeBranch
      })
    }
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Failed to create instance run: ${message}` }
  }

  // The child's prompt is the composed structured brief verbatim:
  // outcome → sub-tasks → done-when → paths → raw goal (last line).
  const childMessage: ChatMessage = {
    role: 'user',
    content: childPrompt
  }

  const stepId = input.stepId?.trim() || undefined
  childProgress.set(childRunId, {
    ...(stepId ? { stepId } : {}),
    step: 0,
    usage: emptyStepUsageTotals(),
    sentAt: 0
  })
  const startedUpdate: AgentEvent = {
    type: 'agent_instance_update',
    runId: input.parentRunId,
    parentRunId: input.parentRunId,
    instanceRunId: childRunId,
    phase: 'started',
    goal: goalText,
    at: new Date().toISOString(),
    ...(stepId ? { stepId } : {}),
    ...(pathScope?.length ? { pathScope } : {})
  }
  // emitLiveEvent (emitParentEvent) already appends agent_instance_update — avoid double persist.
  if (input.emitParentEvent) {
    input.emitParentEvent(startedUpdate)
  } else {
    appendEvent(parentStatusDir, startedUpdate)
    sendLiveParentInstanceEvent(input.parentRunId, startedUpdate)
  }

  // The helper model when one is set; otherwise the model this task runs on.
  // Without either the child fell back to the workspace default, so a task
  // started on one model quietly fanned its helpers out to another.
  const childModel = getSettings().helperModel ?? recallRunModelSelection(input.parentRunId)
  startAgentRunInBackground({
    runId: childRunId,
    workspacePath: input.workspacePath,
    invokeId: registered.invokeId,
    controller: registered.controller,
    wc,
    agentInput: {
      runId: childRunId,
      messages: [childMessage],
      workspacePath: input.workspacePath,
      mode,
      ...(childModel ? { provider: childModel.provider, model: childModel.model } : {})
    }
  })

  return {
    ok: true,
    runId: childRunId,
    label: formatAgentInstanceLabel(childRunId),
    ...(worktreeBranch ? { worktreeBranch } : {}),
    ...(sharedBecause ? { sharedBecause } : {})
  }
}

export async function handleInlineInstanceFinished(
  workspacePath: string,
  childRunId: string,
  status: 'running' | 'cancelled' | 'error' | 'done'
): Promise<void> {
  const phase =
    status === 'done' ? 'done' : status === 'cancelled' ? 'cancelled' : 'error'
  const childStatus = loadStatus(resolveRunDir(workspacePath, childRunId))
  const worktreePath = childStatus?.worktreePath
  try {
    // Commit dirty edits then remove checkout; never block notify/unregister on disk errors.
    if (worktreePath && isSafeInstanceWorktreePath(workspacePath, worktreePath)) {
      disposeWorkspaceIndexes(worktreePath, { permanent: true })
      await finalizeInstanceWorktree(workspacePath, worktreePath, {
        // Keep the branch for 'done' AND 'error' children: an error'd child's
        // committed checkpoint is the only durable copy of its applied edits —
        // run 79f92c12 (2026-08-31) lost its branch here and survived only as
        // an fsck-unreachable commit. Cancelled children keep the old contract
        // (user-backed-out WIP). Retention is bounded elsewhere: deleteRun
        // drops the branch with the run, and pruneStaleInstanceWorktrees ages
        // out what is left (INSTANCE_BRANCH_MAX_AGE_MS).
        keepBranch: phase !== 'cancelled',
        branch: childStatus?.worktreeBranch
      })
    } else if (worktreePath) {
      logger.warn('skipping unsafe instance worktree finalize', {
        scope: 'agent',
        childRunId,
        worktreePath
      })
    }
  } catch (err) {
    logger.warn('instance worktree finalize failed', {
      scope: 'agent',
      childRunId,
      worktreePath,
      err
    })
  } finally {
    notifyChildTerminal(childRunId, phase, undefined, {
      goal: childStatus?.goal,
      pathScope: childStatus?.pathScope
    })
    unregisterChildInstance(childRunId)
    const wc = runIpcSenders.get(childRunId)
    if (wc) runIpcSenders.delete(childRunId)
  }
}

export async function mergeAgentInstanceBranch(
  workspacePath: string,
  parentRunId: string,
  childRunId: string
): Promise<MergeInstanceBranchResult> {
  const childStatus = loadStatus(resolveRunDir(workspacePath, childRunId))
  if (!childStatus?.inlineInstance || childStatus.parentRunId !== parentRunId) {
    return { ok: false, error: 'run_id is not an inline instance spawned by this parent run' }
  }
  if (childStatus.status !== 'done') {
    return {
      ok: false,
      error:
        childStatus.status === 'error' || childStatus.status === 'cancelled'
          ? 'Instance did not finish successfully — only done instances can be merged'
          : 'Instance is still running — await it before merging'
    }
  }
  const branch = childStatus.worktreeBranch
  if (!branch) {
    return {
      ok: false,
      error:
        'Instance has no worktree branch (shared-workspace fallback). Merge is only for git worktree instances.'
    }
  }
  return mergeInstanceBranch(workspacePath, branch)
}

export function resetAgentInstancesForTests(): void {
  childToParent.clear()
  childWorkspace.clear()
  childWaiters.clear()
  runIpcSenders.clear()
  parentInstanceEmitters.clear()
  for (const progress of childProgress.values()) if (progress.timer) clearTimeout(progress.timer)
  childProgress.clear()
}
