/**
 * Coding-eval contract: task fixtures (scripts/evals/coding/<id>/), the solver
 * seam the runner drives, and the report shape `--compare` reads back.
 *
 * The report is persisted JSON that later runs diff against, so fields are
 * only ever added (bump `CODING_EVAL_REPORT_VERSION` on a breaking change).
 */

export const CODING_EVAL_REPORT_VERSION = 1

export type CodingEvalMode = 'agent' | 'ask'

/** One fixture, parsed from `task.json` plus its directory. */
export interface CodingEvalTask {
  id: string
  /** Absolute fixture dir (holds task.json, check.mjs, repo/, solution/, hidden/). */
  dir: string
  instruction: string
  doneWhen: string[]
  timeoutSec: number
  maxSteps: number
  /** Optional per-task spend cap (USD); the run-level cap applies when absent. */
  maxCostUsd?: number
  mode: CodingEvalMode
  category?: string
}

/** Hard limits for one attempt. The runner cancels the run when one trips. */
export interface SolveCaps {
  maxSteps: number
  timeoutMs: number
  /** USD; null = no cost cap. */
  maxCostUsd: number | null
}

export type CapHit = 'max_steps' | 'timeout' | 'max_cost'

/** What the solver reports about one attempt; scoring is the checker's job. */
export interface SolveOutcome {
  /** Terminal run status (`status` event), or 'unknown' when none arrived. */
  status: 'done' | 'error' | 'cancelled' | 'unknown'
  capHit?: CapHit
  steps: number
  /** Sum of per-step input tokens (the billed shape). */
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  /** USD from provider-reported or estimated step costs; null when no step reported one. */
  costUsd: number | null
  toolCalls: number
  failedToolCalls: number
  /** Approvals the headless gate denied (danger-held calls under the 'safe' policy). */
  deniedApprovals: number
  /** ask_question calls answered with no answer (nobody is watching an eval). */
  questionsAsked: number
  /** Final assistant text — what Ask-mode checkers score. */
  answer: string
  /** Error events and thrown errors, newest last. */
  errors: string[]
  /** Run directory holding events.jsonl / messages.jsonl, when the run created one. */
  runDir?: string
}

export interface SolveContext {
  attempt: number
  /** Directory the solver may copy run artifacts into. */
  artifactsDir: string
}

export type CodingSolver = (
  task: CodingEvalTask,
  workspace: string,
  caps: SolveCaps,
  ctx: SolveContext
) => Promise<SolveOutcome>

export interface CheckItem {
  name: string
  ok: boolean
  detail?: string
}

export interface CheckResult {
  pass: boolean
  checks: CheckItem[]
  /** Checker crashed or printed no result line; never a pass. */
  error?: string
  durationMs: number
}

export interface AttemptResult {
  taskId: string
  attempt: number
  pass: boolean
  /** One line: why it failed (cap, solver error, first failing check). */
  failureReason?: string
  checks: CheckItem[]
  checkError?: string
  status: SolveOutcome['status'] | 'solver_error'
  capHit?: CapHit
  steps: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  costUsd: number | null
  toolCalls: number
  failedToolCalls: number
  deniedApprovals: number
  questionsAsked: number
  wallMs: number
  /** Copied run artifacts (events.jsonl etc.), relative to the report dir. */
  artifacts?: string
  /** Kept workspace path (see --keep), absolute. */
  workspace?: string
}

export interface TaskSummary {
  taskId: string
  category?: string
  attempts: number
  passes: number
  passRate: number
  /** Passed some attempts and failed others. */
  flaky: boolean
  medianSteps: number
  medianWallMs: number
  totalCostUsd: number | null
}

export interface CodingEvalReport {
  version: typeof CODING_EVAL_REPORT_VERSION
  startedAt: string
  finishedAt: string
  provider: string
  model: string
  label?: string
  gitSha?: string
  repeat: number
  tasks: TaskSummary[]
  attempts: AttemptResult[]
  totals: {
    attempts: number
    passes: number
    passRate: number
    tasksAllPass: number
    inputTokens: number
    outputTokens: number
    costUsd: number | null
    wallMs: number
  }
}

export interface TaskDelta {
  taskId: string
  before: number | null
  after: number | null
}

export interface ReportComparison {
  /** Pass rate dropped. */
  regressions: TaskDelta[]
  /** Pass rate rose. */
  improvements: TaskDelta[]
  /** In the new report only. */
  added: string[]
  /** In the old report only. */
  removed: string[]
  before: { passRate: number; costUsd: number | null; label?: string; model: string }
  after: { passRate: number; costUsd: number | null; label?: string; model: string }
}
