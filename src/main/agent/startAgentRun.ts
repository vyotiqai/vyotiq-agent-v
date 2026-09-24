import type { WebContents } from 'electron'
import { IPC } from '../../shared/channels'
import {
  type AgentEvent,
  type AgentInteractionMode,
  type ChatMessage,
  type ProviderId,
  needsYouDedupeKey,
  runDoneDedupeKey,
  runErrorDedupeKey
} from '../../shared/ipc'
import { isAbortError, formatError } from '../../shared/errors'
import { getMainWindow } from '../app/window'
import { isChatFixtureReplayEnabled, replayChatFixture } from '../e2e/chatFixtureReplay'
import { formatGoalContinueMessage } from '../../shared/goalRuntime'
import {
  ChatEventBatcher,
  getChatEventBatchStats,
  resetChatEventBatchStats
} from '../ipc/streamBatch'
import { resolveRunDir } from '@main/storage/paths'
import { sweepRetentionAuto } from '@main/storage/retention'
import { logger } from '../../shared/logger'
import { appendEvent, loadStatus } from './state'
import { hydrateFollowUpsFromDisk, loadFollowUps, saveFollowUps } from './followUpStore'
import { registerParentInstanceEmitter, registerRunIpcSender, handleInlineInstanceFinished } from './agentInstances'
import { notifyBadgeChange } from '../app/badges'
import { resolveAvailableRuntime, type RunHandle } from './runtimes'
import {
  cancelPendingApprovals,
  registerApprovalSender
} from './toolApproval'
import {
  cancelPendingQuestions,
  registerQuestionSender
} from './agentQuestion'
import { publishLifecycleNotification } from '../notifications/bus'
import { approvalNoticeFor, finishedNoticeFor, questionNoticeFor } from '../notifications/runNotices'
import {
  clearRunAbort,
  followUpPreview,
  isActive,
  markRunTurnComplete,
  notifyProfileRunFinished,
  seedFollowUps,
  takeLateFollowUpDropped,
  takeLateWriteCheckpoint
} from './runRegistry'
import { readGoal } from './runGoal'
import { launchRunFollowUpOrStart } from './launchRunInvoke'
import { emitGoalUpdate } from './goalEvents'
import { planGoalRelaunch } from './goalRelaunchPlan'

/**
 * Per-run relaunch budget + pending delayed-relaunch timers (module scope so
 * they survive across invokes of the same runId within one app session).
 * Timers are cleared when the run is intentionally aborted (see clearGoalRelaunchState).
 */
const relaunchTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Cancel a pending delayed relaunch and drop the run's relaunch state. */
export function clearGoalRelaunchState(runId: string): void {
  const timer = relaunchTimers.get(runId)
  if (timer) {
    clearTimeout(timer)
    relaunchTimers.delete(runId)
  }
}

export function isTerminalAgentRunEvent(ev: AgentEvent): boolean {
  return (
    ev.type === 'error' ||
    (ev.type === 'status' &&
      (ev.status === 'cancelled' || ev.status === 'error' || ev.status === 'done'))
  )
}

function sendToWebContents(
  channel: string,
  payload: unknown,
  fallback: WebContents
): void {
  const current = getMainWindow()
  const target =
    current && !current.isDestroyed() && !current.webContents.isDestroyed()
      ? current.webContents
      : fallback.isDestroyed()
        ? null
        : fallback
  target?.send(channel, payload)
}

export function sendChatEventToRenderer(
  runId: string,
  event: AgentEvent,
  invokeId: number,
  wc: WebContents
): void {
  sendToWebContents(IPC.chatEvent, { ...event, invokeId }, wc)
}

export type StartAgentRunAgentInput = {
  runId: string
  workspacePath: string
  resume?: boolean
  mode?: AgentInteractionMode
  messages?: ChatMessage[]
  newMessages?: ChatMessage[]
  persistedMessageCount?: number
  focusedFile?: string | null
  /** Session-pinned provider — authoritative for this invoke. */
  provider?: ProviderId
  /** Session-pinned model — authoritative for this invoke. */
  model?: string
  /** True only when the user picked `model` by hand (see ChatStartRequestSchema). */
  modelExplicit?: boolean
  /** Teammate profile binding — identity, memory namespace, model pin. */
  agentProfileId?: string
  /** Delegated task that owns this run (scheduler-launched runs only). */
  delegatedTaskId?: string
  /** Execution substrate (Phase 4 runtime seam) — local unless cloud is wired. */
  runtime?: 'local' | 'cloud'
  /** A new task's done-when checks, from its brief. */
  doneWhen?: string[]
}

export type StartAgentRunInput = {
  runId: string
  workspacePath: string
  invokeId: number
  controller: AbortController
  wc: WebContents
  agentInput: StartAgentRunAgentInput
}

/** Goal text for a fixture-created run: the first user message, as runAgent uses. */
function firstUserMessageText(agentInput: StartAgentRunAgentInput): string {
  const messages = agentInput.newMessages ?? agentInput.messages ?? []
  const first = messages.find((m) => m.role === 'user')
  const content = typeof first?.content === 'string' ? first.content : ''
  return content.trim().slice(0, 200) || 'chat'
}

export function startAgentRunInBackground(input: StartAgentRunInput): void {
  const { runId, workspacePath, invokeId, wc, controller, agentInput } = input
  const releaseIpcSender = registerRunIpcSender(runId, wc)

  ;(async () => {
    let terminalSent = false
    let terminalStatus: 'done' | 'error' | 'cancelled' | undefined
    // Held so the finally can detach listeners. dispose() is NOT cancel: a
    // cloud turn must keep running after this window stops watching it.
    let runHandle: RunHandle | null = null
    const sendEvent = (ev: AgentEvent): void => {
      sendChatEventToRenderer(runId, ev, invokeId, wc)
    }
    const batcher = new ChatEventBatcher(sendEvent, { runId, workspacePath })
    const releaseApprovalSender = registerApprovalSender(runId, (request) => {
      batcher.flush()
      sendToWebContents(IPC.toolApprovalRequest, request, wc)
      const notice = approvalNoticeFor(workspacePath, runId, request)
      publishLifecycleNotification({
        source: 'agent',
        kind: 'needs_you',
        title: notice.title,
        body: notice.body,
        dedupeKey: needsYouDedupeKey(runId),
        action: { type: 'open_run', workspacePath, runId }
      })
    })
    const releaseQuestionSender = registerQuestionSender(runId, (request) => {
      batcher.flush()
      sendToWebContents(IPC.agentQuestionRequest, request, wc)
      const notice = questionNoticeFor(workspacePath, runId, request)
      publishLifecycleNotification({
        source: 'agent',
        kind: 'needs_you',
        title: notice.title,
        body: notice.body,
        dedupeKey: needsYouDedupeKey(runId),
        action: { type: 'open_run', workspacePath, runId }
      })
    })
    const releaseInstanceEmitter = registerParentInstanceEmitter(runId, (ev) => {
      batcher.push(ev)
    })
    notifyBadgeChange()
    try {
      const runSignal = controller.signal
      let eventStream: AsyncGenerator<AgentEvent>
      if (isChatFixtureReplayEnabled()) {
        eventStream = replayChatFixture({
          runId,
          invokeId,
          workspacePath,
          runSignal,
          goal: firstUserMessageText(agentInput),
          mode: agentInput.mode,
          ...(agentInput.agentProfileId ? { agentProfileId: agentInput.agentProfileId } : {}),
          ...(agentInput.delegatedTaskId ? { delegatedTaskId: agentInput.delegatedTaskId } : {}),
          ...(agentInput.doneWhen?.length ? { doneWhen: agentInput.doneWhen } : {})
        })
      } else {
        // Confirm the substrate can take the work before anything observes this
        // run as started. There is no fallback to local: a cloud-bound run that
        // quietly executed in-process would put the user's code on a machine
        // they may have chosen this runtime to avoid.
        const resolved = await resolveAvailableRuntime(agentInput.runtime ?? 'local')
        if (!resolved.ok) throw new Error(resolved.error)
        runHandle = resolved.runtime.start(agentInput)
        eventStream = runHandle.events()
      }
      for await (const ev of eventStream) {
        const terminal = isTerminalAgentRunEvent(ev as AgentEvent)
        if (terminal) terminalSent = true
        if (ev.type === 'status') {
          if (ev.status === 'done' || ev.status === 'error' || ev.status === 'cancelled') {
            terminalStatus = ev.status
          }
        }
        batcher.push(ev as AgentEvent)
        if (terminal) markRunTurnComplete(runId, invokeId)
      }
    } catch (err) {
      if (isAbortError(err)) {
        logger.warn('Chat run aborted', {
          scope: 'ipc',
          correlationId: runId
        })
        // A user cancel must not leave a pending delayed relaunch armed.
        clearGoalRelaunchState(runId)
        if (!terminalSent) {
          batcher.push({ type: 'status', runId, status: 'cancelled' })
          terminalStatus = 'cancelled'
        }
        return
      }
      const message = formatError(err)
      logger.error(`Chat run crashed: ${message}`, {
        scope: 'ipc',
        code: 'AGENT_LOOP',
        correlationId: runId,
        err
      })
      if (!terminalSent) {
        const crashEvents = [
          { type: 'error', runId, message, code: 'AGENT_LOOP' },
          { type: 'status', runId, status: 'error' }
        ] as const
        // Persist the crash so a reload shows the failure instead of a
        // silently dead run.
        try {
          const runDir = resolveRunDir(workspacePath, runId)
          for (const ev of crashEvents) appendEvent(runDir, ev)
        } catch (persistErr) {
          logger.warn('Failed to persist crash terminal events', {
            scope: 'ipc',
            correlationId: runId,
            err: persistErr
          })
        }
        for (const ev of crashEvents) batcher.push(ev)
        terminalStatus = 'error'
      }
    } finally {
      notifyBadgeChange()
      // Forward the loop finally's late events (writes_checkpoint,
      // follow_up_dropped) on EVERY exit path. Taking them only on the happy
      // path meant an abort/crash exit left the renderer without the final
      // checkpoint card and the registry buffers holding the entries.
      const lateCheckpoint = takeLateWriteCheckpoint(runId)
      if (lateCheckpoint) batcher.push(lateCheckpoint)
      const lateDropped = takeLateFollowUpDropped(runId)
      if (lateDropped) batcher.push(lateDropped)
      batcher.flush()
      batcher.dispose()
      if (process.env.VYOTIQ_PERF === '1') {
        const stats = getChatEventBatchStats()
        console.info('[vyotiq-perf] chatEvent batch', JSON.stringify(stats))
        if (stats.attachedRuns === 0) resetChatEventBatchStats()
      }
      releaseApprovalSender()
      releaseQuestionSender()
      releaseInstanceEmitter()
      releaseIpcSender()
      cancelPendingApprovals(runId, invokeId)
      cancelPendingQuestions(runId, invokeId)
      const runDir = resolveRunDir(workspacePath, runId)
      const persisted = loadStatus(runDir)
      // A goal run stopped resumably (network / provider outage) must not sit
      // dead until the user notices — relaunch it the same way app-restart goal
      // resume does. The stop is resumable: status was written with resumable
      // and the loop checkpoint + followups.json are intact.
      let relaunchedActiveGoal = false
      if (
        terminalStatus === 'error' &&
        persisted?.status === 'error' &&
        persisted.resumable === true &&
        persisted.inlineInstance !== true
      ) {
        const goal = readGoal(runDir)
        const plan = planGoalRelaunch({
          terminalStatus,
          persisted,
          goalActive: goal?.status === 'active'
        })
        if (plan.kind === 'blocked_quota') {
          logger.warn('Goal run stopped on provider quota exhaustion — not relaunching', {
            scope: 'goal',
            correlationId: runId
          })
        } else if (goal && plan.kind !== 'none' && !isActive(runId)) {
          const executeRelaunch = (): void => {
            launchRunFollowUpOrStart({
              workspacePath,
              runId,
              wc,
              mode: persisted?.mode ?? 'agent',
              message: {
                role: 'user',
                content: formatGoalContinueMessage(goal.objective),
                synthetic: true
              }
            })
            emitGoalUpdate({
              workspacePath,
              runId,
              runDir,
              goal,
              notice: `Connection lost — resuming goal: ${goal.objective}`,
              wc
            })
          }
          if (plan.kind === 'delayed') {
            logger.info(
              `Circuit open — delaying goal relaunch ${Math.round(plan.delayMs / 1000)}s`,
              { scope: 'goal', correlationId: runId, retryAfterMs: plan.delayMs }
            )
            relaunchedActiveGoal = true
            const relaunchTimer = setTimeout(() => {
              relaunchTimers.delete(runId)
              if (isActive(runId)) return
              executeRelaunch()
            }, plan.delayMs)
            relaunchTimers.set(runId, relaunchTimer)
          } else {
            logger.info('Relaunching goal run after resumable stop', {
              scope: 'goal',
              correlationId: runId
            })
            relaunchedActiveGoal = true
            executeRelaunch()
          }
        }
      }
      if (
        !persisted?.inlineInstance &&
        (terminalStatus === 'done' || terminalStatus === 'error') &&
        !relaunchedActiveGoal
      ) {
        const failed = terminalStatus === 'error'
        const notice = finishedNoticeFor({ workspacePath, runId, runDir, failed, status: persisted })
        publishLifecycleNotification({
          source: 'agent',
          kind: failed ? 'run_error' : 'run_done',
          title: notice.title,
          body: notice.body,
          dedupeKey: failed ? runErrorDedupeKey(runId) : runDoneDedupeKey(runId),
          action: { type: 'open_run', workspacePath, runId },
          ...(notice.reviewFiles ? { reviewFiles: notice.reviewFiles } : {})
        })
      }
      if (persisted?.inlineInstance && persisted.parentRunId) {
        const finishStatus =
          terminalStatus ??
          (persisted.status === 'done' ||
          persisted.status === 'cancelled' ||
          persisted.status === 'error'
            ? persisted.status
            : 'error')
        await handleInlineInstanceFinished(workspacePath, runId, finishStatus)
      }
      // L-14 (audit 02-agent-core): relaunch maps were only cleared on cancel
      // or timer fire — a completed-but-never-cancelled run kept its entry
      // until process exit. Clear on every terminal exit that is not handing
      // the run off to a pending delayed relaunch.
      if (
        (terminalStatus === 'done' || terminalStatus === 'cancelled') ||
        (terminalStatus === 'error' && !relaunchedActiveGoal)
      ) {
        clearGoalRelaunchState(runId)
      }
      // Detach this window's listeners from the runtime. Deliberately NOT a
      // cancel — a runtime whose work outlives the app must keep going.
      try {
        runHandle?.dispose()
      } catch (err) {
        logger.warn('Runtime dispose failed', { scope: 'agent', correlationId: runId, err })
      }
      // Storage retention run-end sweep (audit H4/H5): free pass + armed
      // policy per §8.1 ack. Fire-and-forget — never blocks the terminal path.
      void sweepRetentionAuto()
      // Safety net: a generator that throws BEFORE the loop's try (e.g.
      // 'Unknown agent profile' during binding resolution) never runs its own
      // finally, leaking the registry slot — which would permanently blind the
      // scheduler's one-run-per-teammate gate. Normal paths are already clear
      // by the time this finally runs, so this is a no-op for them; the
      // invokeId guard never clears a fresh re-registration of the same runId.
      clearRunAbort(runId, invokeId)
      // A teammate-bound run ending frees the identity for the task scheduler's
      // queue (delegated tasks wait behind user chats and resumed runs) — but a
      // delayed goal relaunch keeps the identity busy until it re-registers.
      if (persisted?.agentProfileId && !relaunchedActiveGoal) {
        notifyProfileRunFinished(persisted.agentProfileId, runId)
      }
    }
  })().catch((err) => {
    logger.error('Background agent run failed after terminal cleanup', {
      scope: 'agent',
      correlationId: runId,
      err
    })
  })
}

export function hydrateRunFollowUps(
  workspacePath: string,
  runId: string,
  dedupeAgainst?: ChatMessage[]
): void {
  const runDir = resolveRunDir(workspacePath, runId)
  if (dedupeAgainst && dedupeAgainst.length > 0) {
    // A crash after enqueue but before apply, followed by a manual resend of
    // the same text, would otherwise apply the message twice — once as the
    // turn message and again from the hydrated queue. Drop queued duplicates
    // before seeding.
    const newTexts = new Set(
      dedupeAgainst.filter((m) => m.role === 'user').map((m) => followUpPreview(m))
    )
    const entries = loadFollowUps(runDir).filter(
      (entry) => !newTexts.has(followUpPreview(entry.message))
    )
    if (entries.length > 0) seedFollowUps(runId, entries)
    saveFollowUps(runDir, entries)
    return
  }
  hydrateFollowUpsFromDisk(runDir, runId)
}
