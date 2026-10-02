import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { AgentEvent, ProviderIdAny } from '../../../shared/ipc'
import { resolveRunDir } from '../../storage/paths'
import { registerQuestionSender, resolveAgentQuestion } from '../agentQuestion'
import { flushEventAppends } from '../eventAppendQueue'
import { createRunId, runAgent } from '../loop'
import { cancelRun, waitUntilRunInactive } from '../runRegistry'
import { registerApprovalSender, resolveToolApproval } from '../toolApproval'
import type { CapHit, CodingSolver, SolveOutcome } from './types'

/**
 * Coding-eval solver that drives the REAL agent loop (`runAgent`) headless.
 *
 * Nothing in the loop changes for an eval: the solver plays the renderer's
 * part through the loop's existing seams — it registers the approval and
 * question senders a window would, answers them itself, reads the same
 * AgentEvent stream the UI reads, and stops a run with the same `cancelRun`
 * the Stop button uses when a step, time or cost cap trips.
 *
 * Electron access (settings, secrets, userData) is the caller's problem:
 * scripts/eval-coding.mjs runs this inside an Electron main process (or plain
 * Node with an electron stub), the vitest self-test mocks it.
 */

/**
 * 'safe' answers every approval card "Allow once" except calls the command
 * guard held as dangerous, which it denies (an eval workspace is a temp copy,
 * but a dangerous command can reach outside it). 'all' allows those too.
 */
export type HeadlessApprovalPolicy = 'safe' | 'all'

export interface LoopSolverOptions {
  /** Session-pinned provider/model; omitted = the configured settings. */
  provider?: ProviderIdAny
  model?: string
  approve?: HeadlessApprovalPolicy
  /** Pass task.json done_when to the run as its brief checks. Default false. */
  passDoneWhen?: boolean
  /** Every live event, for progress output. */
  onEvent?: (event: AgentEvent) => void
}

const RUN_ARTIFACTS = ['events.jsonl', 'messages.jsonl', 'status.json', 'receipt.json', 'todos.json']

/** Fold one live event into the attempt's tally. Exported for tests. */
export function tallyEvent(outcome: SolveOutcome, event: AgentEvent, seen: { assistantMessages: number }): void {
  switch (event.type) {
    case 'step_usage': {
      outcome.steps = Math.max(outcome.steps, event.step)
      outcome.inputTokens += event.inputTokens ?? 0
      outcome.outputTokens += event.outputTokens ?? 0
      outcome.cachedInputTokens += event.cachedInputTokens ?? 0
      const cost = event.billedCost ?? event.estimatedCost
      if (typeof cost === 'number') outcome.costUsd = (outcome.costUsd ?? 0) + cost
      break
    }
    case 'aux_usage': {
      outcome.inputTokens += event.inputTokens ?? 0
      outcome.outputTokens += event.outputTokens ?? 0
      const cost = event.billedCost ?? event.estimatedCost
      if (typeof cost === 'number') outcome.costUsd = (outcome.costUsd ?? 0) + cost
      break
    }
    case 'assistant_message':
      // Not every provider reports usage, so a step without step_usage still
      // counts: each model call ends in one assistant message.
      seen.assistantMessages += 1
      outcome.steps = Math.max(outcome.steps, seen.assistantMessages)
      if (event.content.trim()) outcome.answer = event.content
      break
    case 'tool_result':
      outcome.toolCalls += 1
      if (!event.ok) outcome.failedToolCalls += 1
      break
    case 'status':
      if (event.status !== 'running') outcome.status = event.status
      break
    case 'error':
      outcome.errors.push(event.message)
      break
    default:
      break
  }
}

export function createLoopSolver(opts: LoopSolverOptions = {}): CodingSolver {
  const policy = opts.approve ?? 'safe'
  return async (task, workspace, caps, ctx) => {
    const runId = createRunId()
    const outcome: SolveOutcome = {
      status: 'unknown',
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: null,
      toolCalls: 0,
      failedToolCalls: 0,
      deniedApprovals: 0,
      questionsAsked: 0,
      answer: '',
      errors: []
    }
    const seen = { assistantMessages: 0 }
    let capHit: CapHit | undefined
    const trip = (cap: CapHit): void => {
      if (capHit) return
      capHit = cap
      cancelRun(runId)
    }

    const offApproval = registerApprovalSender(runId, (request) => {
      const deny = policy === 'safe' && Boolean(request.danger)
      if (deny) outcome.deniedApprovals += 1
      // The gate registers the pending entry before calling the sender; answer
      // on the next tick so the resolve always finds it.
      queueMicrotask(() => {
        resolveToolApproval({ requestId: request.requestId, runId, decision: deny ? 'deny' : 'once' })
      })
    })
    const offQuestion = registerQuestionSender(runId, (request) => {
      outcome.questionsAsked += 1
      queueMicrotask(() => {
        resolveAgentQuestion({ requestId: request.requestId, runId, answers: [] })
      })
    })
    const timer = setTimeout(() => trip('timeout'), caps.timeoutMs)

    try {
      for await (const event of runAgent({
        runId,
        messages: [{ role: 'user', content: task.instruction }],
        workspacePath: workspace,
        mode: task.mode,
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.passDoneWhen ? { doneWhen: task.doneWhen } : {})
      })) {
        tallyEvent(outcome, event, seen)
        opts.onEvent?.(event)
        if (outcome.steps >= caps.maxSteps && outcome.status === 'unknown') trip('max_steps')
        if (caps.maxCostUsd !== null && (outcome.costUsd ?? 0) > caps.maxCostUsd) trip('max_cost')
      }
    } catch (err) {
      outcome.errors.push(err instanceof Error ? err.message : String(err))
    } finally {
      clearTimeout(timer)
      offApproval()
      offQuestion()
    }
    if (capHit) outcome.capHit = capHit

    // The generator's own finally has run; wait for main-side teardown
    // (terminal sessions, receipt) before the runner scores or deletes anything.
    await waitUntilRunInactive(runId, 30_000)
    try {
      const runDir = resolveRunDir(workspace, runId)
      if (existsSync(runDir)) {
        outcome.runDir = runDir
        await flushEventAppends(runDir)
        const dest = join(ctx.artifactsDir, 'run')
        mkdirSync(dest, { recursive: true })
        for (const name of RUN_ARTIFACTS) {
          const from = join(runDir, name)
          if (existsSync(from)) copyFileSync(from, join(dest, name))
        }
      }
    } catch (err) {
      outcome.errors.push(`copying run artifacts failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return outcome
  }
}
