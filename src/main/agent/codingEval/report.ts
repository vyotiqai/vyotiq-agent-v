import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  CODING_EVAL_REPORT_VERSION,
  type AttemptResult,
  type CodingEvalReport,
  type CodingEvalTask,
  type ReportComparison,
  type TaskDelta,
  type TaskSummary
} from './types'

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/** Sum of the reported costs; null when no attempt reported one. */
function sumCost(attempts: AttemptResult[]): number | null {
  const known = attempts.map((a) => a.costUsd).filter((c): c is number => typeof c === 'number')
  return known.length ? known.reduce((s, c) => s + c, 0) : null
}

export function summarizeTasks(tasks: CodingEvalTask[], attempts: AttemptResult[]): TaskSummary[] {
  return tasks.map((task) => {
    const mine = attempts.filter((a) => a.taskId === task.id)
    const passes = mine.filter((a) => a.pass).length
    return {
      taskId: task.id,
      ...(task.category ? { category: task.category } : {}),
      attempts: mine.length,
      passes,
      passRate: mine.length ? passes / mine.length : 0,
      flaky: passes > 0 && passes < mine.length,
      medianSteps: median(mine.map((a) => a.steps)),
      medianWallMs: median(mine.map((a) => a.wallMs)),
      totalCostUsd: sumCost(mine)
    }
  })
}

export function buildCodingEvalReport(input: {
  tasks: CodingEvalTask[]
  attempts: AttemptResult[]
  startedAt: string
  finishedAt: string
  provider: string
  model: string
  repeat: number
  label?: string
  gitSha?: string
}): CodingEvalReport {
  const { attempts } = input
  const tasks = summarizeTasks(input.tasks, attempts)
  const passes = attempts.filter((a) => a.pass).length
  return {
    version: CODING_EVAL_REPORT_VERSION,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    provider: input.provider,
    model: input.model,
    ...(input.label ? { label: input.label } : {}),
    ...(input.gitSha ? { gitSha: input.gitSha } : {}),
    repeat: input.repeat,
    tasks,
    attempts,
    totals: {
      attempts: attempts.length,
      passes,
      passRate: attempts.length ? passes / attempts.length : 0,
      tasksAllPass: tasks.filter((t) => t.attempts > 0 && t.passes === t.attempts).length,
      inputTokens: attempts.reduce((s, a) => s + a.inputTokens, 0),
      outputTokens: attempts.reduce((s, a) => s + a.outputTokens, 0),
      costUsd: sumCost(attempts),
      wallMs: attempts.reduce((s, a) => s + a.wallMs, 0)
    }
  }
}

/** Read a report written by an earlier run; throws on a shape it cannot use. */
export function readCodingEvalReport(path: string): CodingEvalReport {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CodingEvalReport>
  if (parsed?.version !== CODING_EVAL_REPORT_VERSION || !Array.isArray(parsed.tasks)) {
    throw new Error(`${path} is not a coding-eval report (version ${String(parsed?.version)})`)
  }
  return parsed as CodingEvalReport
}

/** Per-task pass-rate deltas between two reports. */
export function compareReports(before: CodingEvalReport, after: CodingEvalReport): ReportComparison {
  const prev = new Map(before.tasks.map((t) => [t.taskId, t]))
  const next = new Map(after.tasks.map((t) => [t.taskId, t]))
  const regressions: TaskDelta[] = []
  const improvements: TaskDelta[] = []
  for (const [taskId, now] of next) {
    const was = prev.get(taskId)
    if (!was) continue
    if (now.passRate < was.passRate) regressions.push({ taskId, before: was.passRate, after: now.passRate })
    else if (now.passRate > was.passRate) improvements.push({ taskId, before: was.passRate, after: now.passRate })
  }
  const side = (r: CodingEvalReport): ReportComparison['before'] => ({
    passRate: r.totals.passRate,
    costUsd: r.totals.costUsd,
    model: r.model,
    ...(r.label ? { label: r.label } : {})
  })
  return {
    regressions,
    improvements,
    added: [...next.keys()].filter((id) => !prev.has(id)),
    removed: [...prev.keys()].filter((id) => !next.has(id)),
    before: side(before),
    after: side(after)
  }
}

const pct = (rate: number | null): string => (rate === null ? '-' : `${Math.round(rate * 100)}%`)
const usd = (cost: number | null): string => (cost === null ? '-' : `$${cost.toFixed(4)}`)
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

export function renderComparisonMarkdown(cmp: ReportComparison): string {
  const lines = [
    '## Compared with the previous report',
    '',
    `Pass rate ${pct(cmp.before.passRate)} -> ${pct(cmp.after.passRate)}; cost ${usd(cmp.before.costUsd)} -> ${usd(cmp.after.costUsd)} (${cmp.before.label ?? cmp.before.model} -> ${cmp.after.label ?? cmp.after.model}).`,
    ''
  ]
  if (cmp.regressions.length === 0) lines.push('No regressions.')
  else {
    lines.push('**Regressions**', '', '| Task | Before | After |', '| --- | --- | --- |')
    for (const r of cmp.regressions) lines.push(`| ${r.taskId} | ${pct(r.before)} | ${pct(r.after)} |`)
  }
  if (cmp.improvements.length) {
    lines.push('', '**Improvements**', '', '| Task | Before | After |', '| --- | --- | --- |')
    for (const r of cmp.improvements) lines.push(`| ${r.taskId} | ${pct(r.before)} | ${pct(r.after)} |`)
  }
  if (cmp.added.length) lines.push('', `New tasks: ${cmp.added.join(', ')}`)
  if (cmp.removed.length) lines.push('', `Missing tasks: ${cmp.removed.join(', ')}`)
  return lines.join('\n')
}

export function renderCodingEvalMarkdown(report: CodingEvalReport, comparison?: ReportComparison): string {
  const t = report.totals
  const lines = [
    `# Coding eval: ${report.label ?? report.model}`,
    '',
    `${report.provider} / ${report.model}${report.gitSha ? ` at ${report.gitSha.slice(0, 10)}` : ''}, ${report.startedAt}. ` +
      `${t.passes}/${t.attempts} attempts passed (${pct(t.passRate)}), ${t.tasksAllPass}/${report.tasks.length} tasks passed every attempt. ` +
      `Tokens in ${t.inputTokens}, out ${t.outputTokens}; cost ${usd(t.costUsd)}; wall ${secs(t.wallMs)}.`,
    '',
    '| Task | Pass | Steps (median) | Wall (median) | Cost | Flaky |',
    '| --- | --- | --- | --- | --- | --- |'
  ]
  for (const s of report.tasks) {
    lines.push(
      `| ${s.taskId} | ${s.passes}/${s.attempts} | ${s.medianSteps} | ${secs(s.medianWallMs)} | ${usd(s.totalCostUsd)} | ${s.flaky ? 'yes' : ''} |`
    )
  }
  const failures = report.attempts.filter((a) => !a.pass)
  if (failures.length) {
    lines.push('', '## Failures', '', '| Task | Attempt | Status | Steps | Reason |', '| --- | --- | --- | --- | --- |')
    for (const a of failures) {
      lines.push(
        `| ${a.taskId} | ${a.attempt} | ${a.capHit ? `${a.status} (${a.capHit})` : a.status} | ${a.steps} | ${cell(a.failureReason ?? '')} |`
      )
    }
  }
  if (comparison) lines.push('', renderComparisonMarkdown(comparison))
  return `${lines.join('\n')}\n`
}

/** Write report.json and report.md into `outDir`; returns both paths. */
export function writeCodingEvalReport(
  outDir: string,
  report: CodingEvalReport,
  comparison?: ReportComparison
): { json: string; markdown: string } {
  mkdirSync(outDir, { recursive: true })
  const json = join(outDir, 'report.json')
  const markdown = join(outDir, 'report.md')
  writeFileSync(json, `${JSON.stringify(comparison ? { ...report, comparison } : report, null, 2)}\n`)
  writeFileSync(markdown, renderCodingEvalMarkdown(report, comparison))
  return { json, markdown }
}
