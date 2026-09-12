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
import { runAgent } from './loop'
import {
  cancelPendingApprovals,
  registerApprovalSender
} from './toolApproval'
import {
  cancelPendingQuestions,
  registerQuestionSender
} from './agentQuestion'
import { publishLifecycleNotification } from '../notifications/bus'
import {
  followUpPreview,
  isActive,
  markRunTurnComplete,
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
}

export type StartAgentRunInput = {
  runId: string
  workspacePath: string
  invokeId: number
  controller: AbortController
  wc: WebContents
  agentInput: StartAgentRunAgentInput
}

export function startAgentRunInBackground(input: StartAgentRunInput): void {
  const { runId, workspacePath, invokeId, wc, controller, agentInput } = input
  const releaseIpcSender = registerRunIpcSender(runId, wc)

  ;(async () => {
    let terminalSent = false
    let terminalStatus: 'done' | 'error' | 'cancelled' | undefined
    const sendEvent = (ev: AgentEvent): void => {
      sendChatEventToRenderer(runId, ev, invokeId, wc)
    }
    const batcher = new ChatEventBatcher(sendEvent, { runId, workspacePath })
    const releaseApprovalSender = registerApprovalSender(runId, (request) => {
      batcher.flush()
      sendToWebContents(IPC.toolApprovalRequest, request, wc)
      publishLifecycleNotification({
        source: 'agent',
        kind: 'needs_you',
        title: 'Needs your input',
        body: request.summary.trim() || request.name,
        dedupeKey: needsYouDedupeKey(runId),
        action: { type: 'open_run', workspacePath, runId }
      })
    })
    const releaseQuestionSender = registerQuestionSender(runId, (request) => {
      batcher.flush()
      sendToWebContents(IPC.agentQuestionRequest, request, wc)
      const firstPrompt = request.questions[0]?.prompt ?? ''
      publishLifecycleNotification({
        source: 'agent',
        kind: 'needs_you',
        title: 'Needs your input',
        body: (request.title ?? firstPrompt).trim() || 'Waiting for your answer',
        dedupeKey: needsYouDedupeKey(runId),
        action: { type: 'open_run', workspacePath, runId }
      })
    })
    const releaseInstanceEmitter = registerParentInstanceEmitter(runId, (ev) => {
      batcher.push(ev)
    })
    try {
      const runSignal = controller.signal
      const eventStream = isChatFixtureReplayEnabled()
        ? replayChatFixture({
            runId,
            invokeId,
            workspacePath,
            runSignal
          })
        : runAgent(agentInput)
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
        const goal = persisted?.goal?.trim() ?? ''
        const failed = terminalStatus === 'error'
        publishLifecycleNotification({
          source: 'agent',
          kind: failed ? 'run_error' : 'run_done',
          title: failed
            ? goal
              ? `Failed: ${goal}`
              : 'Failed'
            : goal
              ? `Finished: ${goal}`
              : 'Finished',
          body: failed ? 'Agent run failed' : 'Agent run finished',
          dedupeKey: failed ? runErrorDedupeKey(runId) : runDoneDedupeKey(runId),
          action: { type: 'open_run', workspacePath, runId }
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
      // Storage retention run-end sweep (audit H4/H5): free pass + armed
      // policy per §8.1 ack. Fire-and-forget — never blocks the terminal path.
      void sweepRetentionAuto()
    }
  })().catch((err) => {
    logger.error('Background agent run failed after terminal cleanup', {
      scope: 'agent',
      correlationId: runId,
      error: formatError(err)
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
