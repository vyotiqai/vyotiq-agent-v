import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { WebContents } from 'electron'
import type { AgentEvent, AgentInteractionMode, ChatMessage } from '../../shared/ipc'
import { contentDisplayText, RunReceiptSchema } from '../../shared/ipc'
import { IPC } from '../../shared/channels'
import { formatAgentInstanceLabel } from '../../shared/utils/agentInstance'
import { logger } from '../../shared/logger'
import { abortError } from '../../shared/errors'
import { getMainWindow } from '../app/window'
import {
  addInstanceWorktree,
  finalizeInstanceWorktree,
  isInstanceWorktreeFallbackError,
  isSafeInstanceWorktreePath,
  mergeInstanceBranch
} from '../git/instanceWorktree'
import { appendEvent, createRun, loadMessages, loadMessagesAsync, loadStatus } from './state'
import { resolveRunDir } from '@main/storage/paths'
import { createRunId } from './loop'
import { RUN_RECEIPT_FILENAME } from './runReceipt'
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

const childToParent = new Map<string, string>()
const childWorkspace = new Map<string, string>()
const childWaiters = new Map<
  string,
  Set<(result: { phase: 'done' | 'error' | 'cancelled'; summary: string }) => void>
>()
const runIpcSenders = new Map<string, WebContents>()
const parentInstanceEmitters = new Map<string, (event: AgentEvent) => void>()

/**
 * Repeated hard tool denials (terminal/diagnostics/git_commit on a shared
 * path_scope instance without a worktree) mean the instance structurally
 * cannot reach its goal. After this many denials the instance is cancelled
 * instead of burning steps in a retry loop it can never win.
 */
export const INLINE_INSTANCE_DENIED_TOOL_CANCEL_THRESHOLD = 2

const deniedToolCounts = new Map<string, number>()

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
}

export function unregisterChildInstance(childRunId: string): void {
  const parentRunId = childToParent.get(childRunId)
  childWorkspace.delete(childRunId)
  deniedToolCounts.delete(childRunId)
  if (!parentRunId) return
  childToParent.delete(childRunId)
  unregisterInlineChildRun(childRunId)
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
  emitAgentInstanceUpdate(workspacePath, parentRunId, {
    parentRunId,
    instanceRunId: childRunId,
    phase,
    summary: instanceUiStatusLine(phase),
    ...(opts?.goal ? { goal: opts.goal } : {}),
    ...(opts?.pathScope ? { pathScope: opts.pathScope } : {})
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

function wroteFilesFromReceipt(runDir: string): string[] {
  const receiptPath = join(runDir, RUN_RECEIPT_FILENAME)
  if (!existsSync(receiptPath)) return []
  try {
    const raw = JSON.parse(readFileSync(receiptPath, 'utf8')) as unknown
    const parsed = RunReceiptSchema.safeParse(raw)
    return parsed.success ? parsed.data.wroteFiles : []
  } catch {
    return []
  }
}

function formatWroteFilesBlock(wroteFiles: string[]): string | null {
  if (wroteFiles.length === 0) return null
  const lines = wroteFiles.map((p) => `- ${p}`)
  return `wroteFiles:\n${lines.join('\n')}`
}

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
  const wroteBlock = formatWroteFilesBlock(wroteFilesFromReceipt(runDir))
  if (wroteBlock) parts.push(wroteBlock)
  if (parts.length > 0) return parts.join('\n\n')
  if (status?.status === 'cancelled') return 'Instance cancelled.'
  if (status?.status === 'error') return status.error ?? 'Instance failed.'
  return 'Instance finished.'
}

export function summarizeChildRun(workspacePath: string, childRunId: string): string {
  return formatChildSummary(workspacePath, childRunId, loadMessages(workspacePath, childRunId))
}

async function summarizeChildRunAsync(workspacePath: string, childRunId: string): Promise<string> {
  return formatChildSummary(
    workspacePath,
    childRunId,
    await loadMessagesAsync(workspacePath, childRunId)
  )
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
    lines.push(`${i + 1}. ${msg.role}: ${text || '(empty)'}`)
  }
  const wroteBlock = formatWroteFilesBlock(wroteFilesFromReceipt(runDir))
  if (wroteBlock) {
    lines.push('')
    lines.push(wroteBlock)
  }
  return lines.join('\n')
}

function formatChildTail(
  workspacePath: string,
  childRunId: string,
  messages: ChatMessage[]
): string {
  const runDir = resolveRunDir(workspacePath, childRunId)
  const status = loadStatus(runDir)
  const parts: string[] = [
    `${formatAgentInstanceLabel(childRunId)}`,
    `status: ${status?.status ?? 'unknown'}`,
    `showing ${messages.length} of ${messages.length} messages`
  ]
  for (const msg of messages) {
    const raw = contentDisplayText(msg.content).trim() || '(empty)'
    parts.push(`\n\n[${msg.role}]\n${raw}`)
  }
  return parts.join('')
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
      return `${formatAgentInstanceLabel(childRunId)}\nstatus: ${status?.status ?? 'unknown'}\n\n${formatChildSummary(workspacePath, childRunId, messages)}`
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
    let pollTimer: ReturnType<typeof setInterval> | undefined
    const cleanup = (): void => {
      settled = true
      clearTimeout(timer)
      if (pollTimer) clearInterval(pollTimer)
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
          `Timed out waiting for ${formatAgentInstanceLabel(childRunId)}. Child is still running — use cancel_agent_instance to stop it, await again with a longer timeout_ms, or pull_agent_instance.`
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

    // After app restart maps are empty — poll disk until terminal/timeout.
    const hasRegistration = childToParent.has(childRunId) || childWorkspace.has(childRunId)
    if (!hasRegistration) {
      pollTimer = setInterval(recheck, 500)
    }
  })
}

/**
 * Record a hard tool denial for an inline instance. When the same instance
 * crosses the threshold, cancel it so the loop stops instead of retrying a
 * structurally-denied tool forever. Returns true when this call cancelled.
 */
export function noteInlineInstanceDeniedTool(childRunId: string | undefined): boolean {
  if (!childRunId || !childToParent.has(childRunId)) return false
  const count = (deniedToolCounts.get(childRunId) ?? 0) + 1
  deniedToolCounts.set(childRunId, count)
  if (count < INLINE_INSTANCE_DENIED_TOOL_CANCEL_THRESHOLD) return false
  deniedToolCounts.delete(childRunId)
  logger.warn('Inline instance auto-cancelled after repeated tool denials', {
    scope: 'agent',
    childRunId,
    denials: count
  })
  cancelRun(childRunId)
  return true
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
  emitParentEvent?: (event: AgentEvent) => void
}

export type SpawnAgentInstanceResult =
  | { ok: true; runId: string; label: string; worktreeBranch?: string }
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
        error: `path_scope entry is not a safe workspace-relative path: ${trimmed}`
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
  briefLines.push(goalText)
  const composedGoal = briefLines.join('\n')
  registerChildInstance(input.parentRunId, childRunId, input.workspacePath)
  const releaseChildIpc = registerRunIpcSender(childRunId, wc)

  const mode: AgentInteractionMode = 'agent'
  // Write-capable instances get a git worktree when possible; otherwise shared + required path_scope.
  let worktreePath: string | undefined
  let worktreeBranch: string | undefined
  {
    const wt = await addInstanceWorktree(input.workspacePath, childRunId, pathScope)
    if (wt.ok) {
      worktreePath = wt.worktreePath
      worktreeBranch = wt.branch
    } else if (!isInstanceWorktreeFallbackError(wt.error)) {
      releaseChildIpc()
      unregisterChildInstance(childRunId)
      clearRunAbort(childRunId, registered.invokeId)
      return { ok: false, error: wt.error }
    } else if (!pathScope?.length) {
      releaseChildIpc()
      unregisterChildInstance(childRunId)
      clearRunAbort(childRunId, registered.invokeId)
      return {
        ok: false,
        error:
          'Cannot isolate instance (no git worktree). Pass path_scope so shared-workspace writes stay constrained, or use a git repository.'
      }
    }
  }

  try {
    createRun(input.workspacePath, childRunId, composedGoal, {
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
    content: composedGoal
  }

  const startedUpdate: AgentEvent = {
    type: 'agent_instance_update',
    runId: input.parentRunId,
    parentRunId: input.parentRunId,
    instanceRunId: childRunId,
    phase: 'started',
    goal: goalText,
    ...(pathScope?.length ? { pathScope } : {})
  }
  // emitLiveEvent (emitParentEvent) already appends agent_instance_update — avoid double persist.
  if (input.emitParentEvent) {
    input.emitParentEvent(startedUpdate)
  } else {
    appendEvent(parentStatusDir, startedUpdate)
    sendLiveParentInstanceEvent(input.parentRunId, startedUpdate)
  }

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
      mode
    }
  })

  return {
    ok: true,
    runId: childRunId,
    label: formatAgentInstanceLabel(childRunId),
    ...(worktreeBranch ? { worktreeBranch } : {})
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
        // (user-backed-out WIP).
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
): Promise<{ ok: true; detail: string } | { ok: false; error: string }> {
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
  deniedToolCounts.clear()
}
