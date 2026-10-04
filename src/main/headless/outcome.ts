import type { AgentEvent } from '../../shared/ipc'
import type { DoneWhenCheck } from '../../shared/doneWhenChecks'

/**
 * What a headless run saw, folded from its event stream, and what that adds
 * up to: a status, an exit code, and the result object every output format
 * prints. Pure — fed events in tests exactly as the live run feeds them.
 */

export type HeadlessFileChange = { path: string; action: 'created' | 'modified' | 'deleted' }

type UsageSlice = {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  billedUsd: number
  estimatedUsd: number
  /** Calls that reported neither a bill nor an estimate (unpriced model). */
  unpriced: number
}

function emptySlice(): UsageSlice {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    billedUsd: 0,
    estimatedUsd: 0,
    unpriced: 0
  }
}

export type HeadlessTally = {
  runId: string
  /** Model steps this run finished (distinct `step_usage` steps). */
  steps: Set<number>
  own: UsageSlice
  /** Latest usage per helper instance — live updates restate the total so far. */
  instances: Map<string, UsageSlice>
  /** Last final answer: an assistant message with text and no tool calls. */
  answer: string
  /** Last assistant text of any kind — the fallback when no answer settled. */
  lastText: string
  terminal?: 'done' | 'error' | 'cancelled'
  lastError?: string
  /** An `incomplete` notice that nothing came after (the run stopped on it). */
  incomplete?: { reason: string; message: string }
  files: Map<string, HeadlessFileChange['action']>
  /** Provider and model that served the latest step (a fallback can change them). */
  provider?: string
  model?: string
}

export function createTally(runId: string): HeadlessTally {
  return {
    runId,
    steps: new Set(),
    own: emptySlice(),
    instances: new Map(),
    answer: '',
    lastText: '',
    files: new Map()
  }
}

function addCall(
  slice: UsageSlice,
  usage: {
    inputTokens?: number
    outputTokens?: number
    cachedInputTokens?: number
    reasoningTokens?: number
    billedCost?: number
    estimatedCost?: number
  }
): void {
  slice.inputTokens += usage.inputTokens ?? 0
  slice.outputTokens += usage.outputTokens ?? 0
  slice.cachedInputTokens += usage.cachedInputTokens ?? 0
  slice.reasoningTokens += usage.reasoningTokens ?? 0
  if (typeof usage.billedCost === 'number') slice.billedUsd += usage.billedCost
  else if (typeof usage.estimatedCost === 'number') slice.estimatedUsd += usage.estimatedCost
  else slice.unpriced += 1
}

/** Fold one event of the run (or of a helper instance it spawned) into the tally. */
export function tallyEvent(tally: HeadlessTally, ev: AgentEvent): void {
  if (ev.type === 'agent_instance_update') {
    if (ev.usage) {
      const u = ev.usage
      tally.instances.set(ev.instanceRunId, {
        inputTokens: u.billedInputTokens,
        outputTokens: u.outputTokens,
        cachedInputTokens: u.billedCachedInputTokens,
        reasoningTokens: u.reasoningTokens,
        billedUsd: u.billedCost,
        estimatedUsd: u.estimatedCost,
        unpriced: Math.max(0, u.steps - u.stepsWithCostReport - u.stepsWithEstimate)
      })
    }
    return
  }
  if (ev.runId !== tally.runId) return
  switch (ev.type) {
    case 'step_usage':
      tally.steps.add(ev.step)
      addCall(tally.own, ev)
      if (ev.provider) tally.provider = ev.provider
      if (ev.model) tally.model = ev.model
      tally.incomplete = undefined
      return
    case 'aux_usage':
      addCall(tally.own, ev)
      return
    case 'assistant_message': {
      const text = ev.content.trim()
      if (text) tally.lastText = ev.content
      if (text && !ev.toolCalls?.length) tally.answer = ev.content
      tally.incomplete = undefined
      return
    }
    case 'tool_start':
      tally.incomplete = undefined
      return
    case 'incomplete':
      tally.incomplete = { reason: ev.reason, message: ev.message }
      return
    case 'error':
      tally.lastError = ev.message
      return
    case 'writes_checkpoint':
      for (const f of ev.files) {
        // A file created then edited in one run is still "created".
        const prior = tally.files.get(f.path)
        tally.files.set(f.path, prior === 'created' && f.action === 'modified' ? 'created' : f.action)
      }
      return
    case 'status':
      if (ev.status === 'done' || ev.status === 'error' || ev.status === 'cancelled') tally.terminal = ev.status
      return
    default:
      return
  }
}

export type HeadlessUsage = {
  steps: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  /** Billed where the provider reported it, estimated from list prices otherwise. */
  costUsd: number
  /** 'billed' | 'estimated' | 'mixed', or 'partial' when some calls had no price at all. */
  costSource: 'billed' | 'estimated' | 'mixed' | 'partial' | 'none'
}

export function usageOf(tally: HeadlessTally): HeadlessUsage {
  const all = [tally.own, ...tally.instances.values()]
  const sum = (pick: (s: UsageSlice) => number): number => all.reduce((n, s) => n + pick(s), 0)
  const billed = sum((s) => s.billedUsd)
  const estimated = sum((s) => s.estimatedUsd)
  const unpriced = sum((s) => s.unpriced)
  const costSource: HeadlessUsage['costSource'] =
    unpriced > 0
      ? billed + estimated > 0
        ? 'partial'
        : 'none'
      : billed > 0 && estimated > 0
        ? 'mixed'
        : estimated > 0
          ? 'estimated'
          : billed > 0
            ? 'billed'
            : 'none'
  return {
    steps: tally.steps.size,
    inputTokens: sum((s) => s.inputTokens),
    outputTokens: sum((s) => s.outputTokens),
    cachedInputTokens: sum((s) => s.cachedInputTokens),
    reasoningTokens: sum((s) => s.reasoningTokens),
    costUsd: Math.round((billed + estimated) * 1e6) / 1e6,
    costSource
  }
}

/** Why the runner itself stopped the run, when it did. */
export type HeadlessStopCause = 'timeout' | 'max_steps' | 'max_cost' | 'needs_input' | 'interrupted'

export type HeadlessStatus =
  | 'done'
  | 'not_met'
  | 'incomplete'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'needs_input'
  | 'timeout'
  | 'max_steps'
  | 'max_cost'
  | 'interrupted'

export type DoneWhenVerdict = Pick<DoneWhenCheck, 'id' | 'text' | 'source' | 'verdict' | 'evidence'>

/**
 * Why a run that reported `done` produced no record. A headless run's whole
 * output is its transcript: with nothing in it there is nothing for the caller
 * to read, so `done` would claim a success nothing was produced for. The
 * fixture replay path reaches this — it writes `status.json` and never a
 * single event or message row.
 */
export const EMPTY_TRANSCRIPT_ERROR =
  'The run reported success but wrote no transcript: messages.jsonl and events.jsonl are both empty.'

/**
 * The error for a transcript of `bytes`, or undefined when it holds something.
 * Any row at all counts — one append is proof the path wrote, whatever
 * happened afterwards.
 */
export function emptyTranscriptError(bytes: number): string | undefined {
  return bytes > 0 ? undefined : EMPTY_TRANSCRIPT_ERROR
}

/**
 * The run's status. A run the runner stopped reports why; otherwise the
 * loop's terminal status, refined: `done` with a failed or unmarked brief
 * check is `not_met` (the brief's checks are the caller's contract — a plan's
 * own unmarked checks are not), `done` on an unanswered incomplete notice is
 * `incomplete`, and a failure while approvals were refused is `blocked`.
 */
export function classifyHeadlessOutcome(input: {
  terminal?: HeadlessTally['terminal']
  stopCause?: HeadlessStopCause | null
  incomplete?: HeadlessTally['incomplete']
  checks: readonly DoneWhenVerdict[]
  deniedApprovals: number
}): HeadlessStatus {
  if (input.stopCause) return input.stopCause
  const blockedIfDenied = (status: HeadlessStatus): HeadlessStatus => (input.deniedApprovals > 0 ? 'blocked' : status)
  if (input.terminal === 'error' || input.terminal === undefined) return blockedIfDenied('failed')
  if (input.terminal === 'cancelled') return 'cancelled'
  if (input.incomplete) return blockedIfDenied('incomplete')
  const unmet = input.checks.some(
    (c) => c.verdict === 'not_met' || (c.source === 'brief' && c.verdict !== 'met')
  )
  if (unmet) return blockedIfDenied('not_met')
  return 'done'
}

export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_USAGE = 2
export const EXIT_BLOCKED = 3
export const EXIT_TIMEOUT = 124
export const EXIT_INTERRUPTED = 130

export function exitCodeForStatus(status: HeadlessStatus): number {
  switch (status) {
    case 'done':
      return EXIT_OK
    case 'blocked':
    case 'needs_input':
      return EXIT_BLOCKED
    case 'timeout':
      return EXIT_TIMEOUT
    case 'interrupted':
      return EXIT_INTERRUPTED
    case 'not_met':
    case 'incomplete':
    case 'failed':
    case 'cancelled':
    case 'max_steps':
    case 'max_cost':
      return EXIT_FAILED
    default: {
      const exhaustive: never = status
      return exhaustive
    }
  }
}

export type HeadlessDeniedCall = { tool: string; summary: string; reason: string }

export type HeadlessResult = {
  type: 'result'
  status: HeadlessStatus
  exitCode: number
  runId: string
  workspacePath: string
  /** Set with --worktree: where the run worked and on which branch. */
  worktree?: { path: string; branch: string; baseBranch: string }
  mode: 'agent' | 'ask'
  provider?: string
  model?: string
  answer: string
  error?: string
  incomplete?: { reason: string; message: string }
  filesChanged: HeadlessFileChange[]
  doneWhen: DoneWhenVerdict[]
  usage: HeadlessUsage
  approvals: { allowed: number; denied: number; deniedCalls: HeadlessDeniedCall[] }
  questions: number
  durationMs: number
}

export function buildHeadlessResult(input: {
  tally: HeadlessTally
  status: HeadlessStatus
  workspacePath: string
  worktree?: HeadlessResult['worktree']
  mode: HeadlessResult['mode']
  provider?: string
  model?: string
  checks: readonly DoneWhenVerdict[]
  approvals: HeadlessResult['approvals']
  questions: number
  durationMs: number
  /** An error the runner hit outside the loop (setup, worktree…). */
  error?: string
}): HeadlessResult {
  const { tally } = input
  const error = input.error ?? (input.status === 'done' ? undefined : tally.lastError)
  return {
    type: 'result',
    status: input.status,
    exitCode: exitCodeForStatus(input.status),
    runId: tally.runId,
    workspacePath: input.workspacePath,
    ...(input.worktree ? { worktree: input.worktree } : {}),
    mode: input.mode,
    ...((tally.provider ?? input.provider) ? { provider: tally.provider ?? input.provider } : {}),
    ...((tally.model ?? input.model) ? { model: tally.model ?? input.model } : {}),
    answer: tally.answer || tally.lastText,
    ...(error ? { error } : {}),
    ...(tally.incomplete && input.status !== 'done' ? { incomplete: tally.incomplete } : {}),
    filesChanged: [...tally.files].map(([path, action]) => ({ path, action })),
    doneWhen: input.checks.map((c) => ({
      id: c.id,
      text: c.text,
      source: c.source,
      verdict: c.verdict,
      ...(c.evidence ? { evidence: c.evidence } : {})
    })),
    usage: usageOf(tally),
    approvals: input.approvals,
    questions: input.questions,
    durationMs: input.durationMs
  }
}

/**
 * Has the run used up its step budget? It may finish the step it is on —
 * tools included — and is stopped when the model is about to be called again.
 */
export function overStepBudget(tally: HeadlessTally, maxSteps: number | undefined, ev: AgentEvent): boolean {
  if (!maxSteps || tally.steps.size < maxSteps || ev.runId !== tally.runId) return false
  switch (ev.type) {
    case 'text_delta':
    case 'thinking_delta':
    case 'tool_call_delta':
      return true
    case 'step_usage':
      return !tally.steps.has(ev.step)
    default:
      return false
  }
}
