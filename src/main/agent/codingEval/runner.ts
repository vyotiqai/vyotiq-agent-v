import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import { runCheck } from './check'
import { buildCodingEvalReport } from './report'
import { applySolution, hasSolution, prepareWorkspace } from './tasks'
import type {
  AttemptResult,
  CheckResult,
  CodingEvalReport,
  CodingEvalTask,
  CodingSolver,
  SolveCaps,
  SolveOutcome
} from './types'

/**
 * Coding-eval runner: every task x repeat gets a fresh copy of its repo in a
 * scratch root this call creates (and only this call removes — the OS temp
 * dir is shared, nothing here sweeps by prefix), the solver works in it under
 * the attempt's caps, then the task's checker scores what is left.
 */

export type KeepWorkspaces = 'never' | 'failed' | 'always'

export interface RunCodingEvalOptions {
  tasks: CodingEvalTask[]
  solver: CodingSolver
  /** Report + per-attempt artifacts land here. */
  outDir: string
  repeat?: number
  /** Overrides applied on top of each task's own caps. */
  caps?: { maxSteps?: number; timeoutSec?: number; maxCostUsd?: number }
  keep?: KeepWorkspaces
  provider: string
  model: string
  label?: string
  gitSha?: string
  /** Parent of the scratch root (default os.tmpdir()). */
  scratchParent?: string
  onProgress?: (line: string) => void
}

export function capsFor(task: CodingEvalTask, override: RunCodingEvalOptions['caps']): SolveCaps {
  return {
    maxSteps: override?.maxSteps ?? task.maxSteps,
    timeoutMs: (override?.timeoutSec ?? task.timeoutSec) * 1000,
    maxCostUsd: override?.maxCostUsd ?? task.maxCostUsd ?? null
  }
}

/** One line on why an attempt failed: cap, solver error, checker error, first failing check. */
export function failureReasonFor(outcome: SolveOutcome | null, solverError: string | null, check: CheckResult): string {
  const parts: string[] = []
  if (solverError) parts.push(`solver error: ${solverError}`)
  if (outcome?.capHit) parts.push(`cap hit: ${outcome.capHit}`)
  else if (outcome && outcome.status !== 'done') {
    parts.push(`run ${outcome.status}${outcome.errors.length ? `: ${outcome.errors[outcome.errors.length - 1]}` : ''}`)
  }
  if (check.error) parts.push(`checker: ${check.error}`)
  const firstFailed = check.checks.find((c) => !c.ok)
  if (firstFailed) parts.push(`${firstFailed.name}${firstFailed.detail ? ` — ${firstFailed.detail.split('\n').find((l) => l.trim()) ?? ''}` : ''}`)
  return (parts.join('; ') || 'failed').slice(0, 600)
}

function emptyOutcome(): SolveOutcome {
  return {
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
}

export async function runCodingEval(opts: RunCodingEvalOptions): Promise<CodingEvalReport> {
  const repeat = Math.max(1, opts.repeat ?? 1)
  const keep = opts.keep ?? 'never'
  const log = opts.onProgress ?? (() => {})
  const startedAt = new Date().toISOString()
  mkdirSync(opts.outDir, { recursive: true })
  const scratch = mkdtempSync(join(opts.scratchParent ?? tmpdir(), 'vyotiq-eval-coding-'))
  const attempts: AttemptResult[] = []
  let keptAny = false
  try {
    for (const task of opts.tasks) {
      for (let attempt = 1; attempt <= repeat; attempt++) {
        const caps = capsFor(task, opts.caps)
        const artifactsDir = join(opts.outDir, 'attempts', `${task.id}-${attempt}`)
        mkdirSync(artifactsDir, { recursive: true })
        const workspace = prepareWorkspace(task, scratch)
        log(`[eval] ${task.id} #${attempt}: solving (max ${caps.maxSteps} steps, ${caps.timeoutMs / 1000}s)`)
        const started = Date.now()
        let outcome: SolveOutcome | null = null
        let solverError: string | null = null
        try {
          outcome = await opts.solver(task, workspace, caps, { attempt, artifactsDir })
        } catch (err) {
          solverError = err instanceof Error ? err.message : String(err)
        }
        const wallMs = Date.now() - started
        const answerFile = join(artifactsDir, 'answer.md')
        writeFileSync(answerFile, outcome?.answer ?? '')
        const check = await runCheck(task, workspace, answerFile)
        writeFileSync(join(artifactsDir, 'check.json'), `${JSON.stringify(check, null, 2)}\n`)
        const o = outcome ?? emptyOutcome()
        const pass = check.pass
        const keepThis = keep === 'always' || (keep === 'failed' && !pass)
        attempts.push({
          taskId: task.id,
          attempt,
          pass,
          ...(pass ? {} : { failureReason: failureReasonFor(outcome, solverError, check) }),
          checks: check.checks,
          ...(check.error ? { checkError: check.error } : {}),
          status: solverError ? 'solver_error' : o.status,
          ...(o.capHit ? { capHit: o.capHit } : {}),
          steps: o.steps,
          inputTokens: o.inputTokens,
          outputTokens: o.outputTokens,
          cachedInputTokens: o.cachedInputTokens,
          costUsd: o.costUsd,
          toolCalls: o.toolCalls,
          failedToolCalls: o.failedToolCalls,
          deniedApprovals: o.deniedApprovals,
          questionsAsked: o.questionsAsked,
          wallMs,
          artifacts: relative(opts.outDir, artifactsDir).split('\\').join('/'),
          ...(keepThis ? { workspace } : {})
        })
        if (keepThis) keptAny = true
        else rmSync(workspace, { recursive: true, force: true })
        log(`[eval] ${task.id} #${attempt}: ${pass ? 'PASS' : `FAIL (${attempts[attempts.length - 1].failureReason})`} in ${(wallMs / 1000).toFixed(1)}s, ${o.steps} steps`)
      }
    }
  } finally {
    // The scratch root is ours alone; keep it only while a kept workspace lives in it.
    if (!keptAny) rmSync(scratch, { recursive: true, force: true })
  }
  return buildCodingEvalReport({
    tasks: opts.tasks,
    attempts,
    startedAt,
    finishedAt: new Date().toISOString(),
    provider: opts.provider,
    model: opts.model,
    repeat,
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.gitSha ? { gitSha: opts.gitSha } : {})
  })
}

export interface FixtureSelfCheck {
  taskId: string
  /** Untouched repo: must fail. */
  baseline: CheckResult
  /** Reference solution applied: must pass. */
  solution: CheckResult | null
  ok: boolean
  problem?: string
}

/**
 * Prove each checker is meaningful without a model: the untouched fixture
 * must FAIL and the reference solution (solution/) must PASS.
 */
export async function selfCheckFixtures(
  tasks: CodingEvalTask[],
  opts: { scratchParent?: string; onProgress?: (line: string) => void; concurrency?: number } = {}
): Promise<FixtureSelfCheck[]> {
  const log = opts.onProgress ?? (() => {})
  const scratch = mkdtempSync(join(opts.scratchParent ?? tmpdir(), 'vyotiq-eval-selfcheck-'))
  const results: FixtureSelfCheck[] = new Array(tasks.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (let index = next++; index < tasks.length; index = next++) {
      const task = tasks[index]
      const emptyAnswer = join(scratch, `${task.id}-baseline-answer.md`)
      writeFileSync(emptyAnswer, '')
      const baseWs = prepareWorkspace(task, scratch)
      const baseline = await runCheck(task, baseWs, emptyAnswer)
      let solution: CheckResult | null = null
      let problem: string | undefined
      if (!hasSolution(task)) problem = 'no solution/ to prove the checker can pass'
      else {
        const solWs = prepareWorkspace(task, scratch)
        try {
          const answer = applySolution(task, solWs)
          const answerFile = join(scratch, `${task.id}-solution-answer.md`)
          writeFileSync(answerFile, answer)
          solution = await runCheck(task, solWs, answerFile)
        } catch (err) {
          problem = `applying solution failed: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      if (!problem && baseline.pass) problem = 'untouched fixture PASSES — the checker cannot tell solved from unsolved'
      if (!problem && baseline.error) problem = `baseline checker error: ${baseline.error}`
      if (!problem && solution && !solution.pass) {
        const failed = solution.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail ?? ''}`)
        problem = `reference solution FAILS: ${solution.error ?? failed.join('; ')}`
      }
      const ok = !problem
      results[index] = { taskId: task.id, baseline, solution, ok, ...(problem ? { problem } : {}) }
      const failedNames = baseline.checks.filter((c) => !c.ok).map((c) => c.name)
      log(`[self-check] ${ok ? 'ok  ' : 'BAD '} ${task.id}: baseline fails [${failedNames.join(', ')}], solution ${solution?.pass ? 'passes' : 'does not pass'}${problem ? ` — ${problem}` : ''}`)
    }
  }
  try {
    const workers = Math.max(1, Math.min(opts.concurrency ?? 1, tasks.length))
    await Promise.all(Array.from({ length: workers }, () => worker()))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  return results
}
