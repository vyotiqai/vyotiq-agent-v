import type { WebContents } from 'electron'
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import type {
  AgentEvent,
  AgentQuestionRequest,
  ProviderIdAny,
  ToolApprovalRequest
} from '../../shared/ipc'
import { IPC } from '../../shared/channels'
import { formatError } from '../../shared/errors'
import { logger } from '../../shared/logger'
import { resolveRunDir } from '../storage/paths'
import { createRunId } from '../agent/loop'
import { cancelRun, clearRunAbort, forceFinishCancelledRun, tryRegisterRunAbort } from '../agent/runRegistry'
import { startAgentRunInBackground } from '../agent/startAgentRun'
import { resolveToolApproval } from '../agent/toolApproval'
import { rejectAgentQuestion, resolveAgentQuestion } from '../agent/agentQuestion'
import { flushEventAppends, flushMessageAppends, flushStatusWrites, runExists, updateStatus } from '../agent/state'
import { readChecks } from '../agent/doneWhenChecks'
import { createTaskWorktree } from '../git/taskWorktrees'
import type { HeadlessApprovalPolicy, HeadlessQuestionPolicy } from './args'
import {
  classifyHeadlessQuestion,
  decideHeadlessApproval,
  headlessQuestionAnswers
} from './policy'
import {
  buildHeadlessResult,
  classifyHeadlessOutcome,
  createTally,
  emptyTranscriptError,
  overStepBudget,
  tallyEvent,
  usageOf,
  type HeadlessDeniedCall,
  type HeadlessResult,
  type HeadlessStopCause
} from './outcome'

/**
 * One headless task, start to finish: the shared adapter for `--headless`
 * and anything else that drives the real agent loop without a window (the
 * coding eval runner).
 *
 * It starts the run through `startAgentRunInBackground` — the same path a
 * window's send takes, e2e fixture replay included — with a stand-in for the
 * window's WebContents. What the window would have shown arrives here
 * instead: the event stream, and the approval and question prompts, which
 * the `--approval` / `--on-question` policies answer through the same
 * resolve calls the window's buttons use. The run's records are ordinary
 * (status.json marked `headless`), so the app's navigator shows them later.
 */

export type HeadlessTaskInput = {
  workspacePath: string
  prompt: string
  mode: 'agent' | 'ask'
  provider?: ProviderIdAny
  model?: string
  approval: HeadlessApprovalPolicy
  onQuestion: HeadlessQuestionPolicy
  doneWhen?: string[]
  maxSteps?: number
  maxCostUsd?: number
  timeoutMs?: number
  /** Branch a git worktree from HEAD and run there. */
  worktree?: boolean
  /** Aborting it stops the run as `interrupted` (Ctrl+C). */
  signal?: AbortSignal
  onItem?: (item: HeadlessStreamItem) => void
}

export type HeadlessStreamItem =
  | { type: 'run_started'; runId: string; workspacePath: string; mode: string; worktree?: HeadlessResult['worktree'] }
  | { type: 'event'; event: AgentEvent }
  | {
      type: 'approval_decision'
      runId: string
      tool: string
      summary: string
      decision: 'allowed' | 'denied'
      reason: string
    }
  | { type: 'question_answered'; runId: string; kind: string; answer: 'answered' | 'declined' | 'stopped' }

/**
 * After a stop, how long the run gets to unwind before we report without it.
 * Most stops unwind in well under a second; a step parked on something deaf
 * to abort (an MCP server still connecting) would otherwise hold a
 * `--timeout 60` run for the registry's 30 s force-finish on top.
 */
const UNWIND_GRACE_MS = 10_000

function isTerminal(ev: AgentEvent): boolean {
  return ev.type === 'status' && (ev.status === 'done' || ev.status === 'error' || ev.status === 'cancelled')
}

export async function runHeadlessTask(input: HeadlessTaskInput): Promise<HeadlessResult> {
  const startedAt = Date.now()
  const runId = createRunId()
  const tally = createTally(runId)
  let workspacePath = input.workspacePath
  let worktree: HeadlessResult['worktree']
  const approvals = { allowed: 0, denied: 0, deniedCalls: [] as HeadlessDeniedCall[] }
  let questions = 0
  let stopCause: HeadlessStopCause | null = null
  let setupError: string | undefined
  const emit = (item: HeadlessStreamItem): void => {
    try {
      input.onItem?.(item)
    } catch (err) {
      logger.warn('Headless output callback failed', { scope: 'headless', correlationId: runId, err })
    }
  }

  const finish = (error?: string): HeadlessResult => {
    const runDir = resolveRunDir(workspacePath, runId)
    const checks = runExists(workspacePath, runId) ? readChecks(runDir) : []
    const status = error
      ? 'failed'
      : classifyHeadlessOutcome({
          terminal: tally.terminal,
          stopCause,
          incomplete: tally.incomplete,
          checks,
          deniedApprovals: approvals.denied
        })
    return buildHeadlessResult({
      tally,
      status,
      workspacePath,
      worktree,
      mode: input.mode,
      provider: input.provider,
      model: input.model,
      checks,
      approvals,
      questions,
      durationMs: Date.now() - startedAt,
      error
    })
  }

  if (input.worktree) {
    try {
      const made = await createTaskWorktree(input.workspacePath, input.prompt)
      workspacePath = made.workspacePath
      worktree = { path: made.workspacePath, branch: made.branch, baseBranch: made.baseBranch }
    } catch (err) {
      return finish(`Could not make the worktree: ${formatError(err)}`)
    }
  }

  const registered = tryRegisterRunAbort(runId, workspacePath)
  if (!registered.ok) return finish(registered.error)
  const { invokeId, controller } = registered

  const stop = (cause: HeadlessStopCause): void => {
    if (stopCause || tally.terminal) return
    stopCause = cause
    logger.info('Headless run stopped by its limits', { scope: 'headless', correlationId: runId, reason: cause })
    cancelRun(runId)
  }

  let markedHeadless = false
  const onParentEvent = (ev: AgentEvent): void => {
    if (!markedHeadless && runExists(workspacePath, runId)) {
      markedHeadless = true
      void updateStatus(resolveRunDir(workspacePath, runId), { headless: true })
    }
    if (overStepBudget(tally, input.maxSteps, ev)) stop('max_steps')
    tallyEvent(tally, ev)
    if (input.maxCostUsd && usageOf(tally).costUsd >= input.maxCostUsd && !isTerminal(ev)) stop('max_cost')
    emit({ type: 'event', event: ev })
  }

  const onApproval = (request: ToolApprovalRequest): void => {
    const verdict = decideHeadlessApproval(input.approval, request)
    if (verdict.decision === 'deny') {
      approvals.denied += 1
      if (approvals.deniedCalls.length < 50) {
        approvals.deniedCalls.push({ tool: request.name, summary: request.summary, reason: verdict.reason })
      }
    } else {
      approvals.allowed += 1
    }
    logger.info('Headless approval decision', {
      scope: 'headless',
      correlationId: request.runId,
      tool: request.name,
      decision: verdict.decision,
      reason: verdict.reason
    })
    emit({
      type: 'approval_decision',
      runId: request.runId,
      tool: request.name,
      summary: request.summary,
      decision: verdict.decision === 'deny' ? 'denied' : 'allowed',
      reason: verdict.reason
    })
    // The gate parks the request before it sends it; answer on the next tick
    // so the answer never lands inside the gate's own send call.
    queueMicrotask(() => {
      resolveToolApproval({ requestId: request.requestId, runId: request.runId, decision: verdict.decision })
    })
  }

  const onQuestion = (request: AgentQuestionRequest): void => {
    questions += 1
    const kind = classifyHeadlessQuestion(request)
    queueMicrotask(() => {
      if (kind === 'spend-limit') {
        // No answer reads as "Stop here": only a person decides to spend more.
        resolveAgentQuestion({ requestId: request.requestId, runId: request.runId, answers: [] })
        emit({ type: 'question_answered', runId: request.runId, kind, answer: 'declined' })
        return
      }
      if (kind === 'workspace-hooks') {
        // Declined, not denied: a denial would be remembered for the window too.
        rejectAgentQuestion({
          requestId: request.requestId,
          runId: request.runId,
          reason: 'No person to ask in a headless run'
        })
        emit({ type: 'question_answered', runId: request.runId, kind, answer: 'declined' })
        return
      }
      if (input.onQuestion === 'fail') {
        emit({ type: 'question_answered', runId: request.runId, kind, answer: 'stopped' })
        stop('needs_input')
        return
      }
      resolveAgentQuestion({
        requestId: request.requestId,
        runId: request.runId,
        answers: headlessQuestionAnswers(request)
      })
      emit({ type: 'question_answered', runId: request.runId, kind, answer: 'answered' })
    })
  }

  // Stands in for the window. Only `send` and `isDestroyed` are ever called on
  // a run's WebContents; helper instances the run spawns inherit it, so their
  // approvals and questions reach the same policies.
  const sink = {
    id: -1,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown): void => {
      if (channel === IPC.chatEvent) {
        const ev = payload as AgentEvent
        if (ev?.runId === runId) onParentEvent(ev)
      } else if (channel === IPC.toolApprovalRequest) {
        onApproval(payload as ToolApprovalRequest)
      } else if (channel === IPC.agentQuestionRequest) {
        onQuestion(payload as AgentQuestionRequest)
      }
    }
  } as unknown as WebContents

  let timer: ReturnType<typeof setTimeout> | undefined
  const onAbort = (): void => stop('interrupted')
  try {
    emit({ type: 'run_started', runId, workspacePath, mode: input.mode, ...(worktree ? { worktree } : {}) })
    if (input.timeoutMs) timer = setTimeout(() => stop('timeout'), input.timeoutMs)
    if (input.signal?.aborted) stop('interrupted')
    else input.signal?.addEventListener('abort', onAbort, { once: true })

    const settled = startAgentRunInBackground({
      runId,
      workspacePath,
      invokeId,
      controller,
      wc: sink,
      agentInput: {
        runId,
        workspacePath,
        mode: input.mode,
        messages: [{ role: 'user', content: input.prompt }],
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.doneWhen?.length ? { doneWhen: input.doneWhen } : {})
      }
    })
    // A stop that never unwinds (a tool deaf to abort) must not hold the
    // process: report after the grace with what the run left.
    const unwound = await Promise.race([
      settled.then(() => true),
      new Promise<boolean>((resolve) => {
        const poll = setInterval(() => {
          if (!stopCause) return
          clearInterval(poll)
          setTimeout(() => resolve(false), UNWIND_GRACE_MS).unref?.()
        }, 250)
        void settled.finally(() => clearInterval(poll))
      })
    ])
    // Write the stopped record the registry's force-finish would have written.
    if (!unwound) await forceFinishCancelledRun(runId).catch(() => false)
  } catch (err) {
    setupError = formatError(err)
    logger.error('Headless run failed to start', { scope: 'headless', correlationId: runId, err })
  } finally {
    if (timer) clearTimeout(timer)
    input.signal?.removeEventListener('abort', onAbort)
    // Normally cleared by the run itself; a no-op then (invokeId-guarded).
    clearRunAbort(runId, invokeId)
  }

  try {
    await Promise.all([flushMessageAppends(), flushEventAppends(), flushStatusWrites()])
  } catch (err) {
    logger.warn('Headless run could not flush its records', { scope: 'headless', correlationId: runId, err })
  }
  if (setupError) return finish(setupError)

  /**
   * A run whose whole output is its transcript wrote nothing: the fixture
   * replay path reaches `status: done` without a single append, so a run that
   * asked a question and received an answer would otherwise leave a success
   * with nothing behind it. Both the result and the record name the gap, so
   * `done` and a silent failure are no longer the same bytes on disk.
   */
  const empty = emptyTranscriptError(transcriptBytes())
  if (!empty) return finish()
  logger.error('Headless run finished with nothing written', { scope: 'headless', correlationId: runId, err: empty })
  if (runExists(workspacePath, runId)) {
    await updateStatus(
      resolveRunDir(workspacePath, runId),
      { status: 'error', error: empty },
      { sync: true }
    ).catch((err: unknown) => {
      logger.warn('Headless run could not record its empty transcript', {
        scope: 'headless',
        correlationId: runId,
        err
      })
    })
  }
  return finish(empty)

  /**
   * Transcript bytes on disk. Rotation only ever moves rows INTO the live
   * files (eventAppendQueue.ts:199, messageAppendQueue.ts:216), so a run whose
   * live pair is empty never appended a row.
   */
  function transcriptBytes(): number {
    if (!runExists(workspacePath, runId)) return 0
    const runDir = resolveRunDir(workspacePath, runId)
    return ['messages.jsonl', 'events.jsonl'].reduce((total, file) => {
      const path = join(runDir, file)
      return total + (existsSync(path) ? statSync(path).size : 0)
    }, 0)
  }
}
