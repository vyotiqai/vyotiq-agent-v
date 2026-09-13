import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ArcEvalReport, ArcTaskResult } from './types'

export interface ReportMeta {
  model: string
  candidateCount: number
  startedAt: string
}

/**
 * Assemble the ArcEvalReport from per-task results. Rates are fractions in
 * [0, 1] and are 0 when there are no tasks. totalDurationMs is the sum of
 * every candidate's durationMs.
 */
export function buildReport(results: ArcTaskResult[], meta: ReportMeta): ArcEvalReport {
  const taskCount = results.length
  const pass1Count = results.filter((r) => r.pass1).length
  const passVoteCount = results.filter((r) => r.passVote).length
  const totalDurationMs = results.reduce(
    (sum, r) => sum + r.candidates.reduce((s, c) => s + c.durationMs, 0),
    0
  )
  return {
    startedAt: meta.startedAt,
    model: meta.model,
    taskCount,
    candidateCount: meta.candidateCount,
    results,
    pass1Rate: taskCount === 0 ? 0 : pass1Count / taskCount,
    passVoteRate: taskCount === 0 ? 0 : passVoteCount / taskCount,
    totalDurationMs
  }
}

/** Compact, emoji-free console summary of a report. */
export function formatConsole(report: ArcEvalReport): string {
  const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`
  const lines: string[] = []
  lines.push('ARC-AGI eval report')
  lines.push(`  model:          ${report.model}`)
  lines.push(`  startedAt:      ${report.startedAt}`)
  lines.push(`  tasks:          ${report.taskCount}`)
  lines.push(`  candidates/task: ${report.candidateCount}`)
  lines.push('')
  lines.push('  taskId         pass1  passVote  candidates')
  lines.push('  -------------  -----  --------  ----------')
  for (const r of report.results) {
    const id = r.taskId.length > 13 ? `${r.taskId.slice(0, 12)}…` : r.taskId.padEnd(13)
    const errCount = r.candidates.filter((c) => c.error).length
    const cand = errCount > 0 ? `${r.candidates.length} (${errCount} errored)` : `${r.candidates.length}`
    lines.push(`  ${id}  ${r.pass1 ? 'yes  ' : 'no   '}  ${r.passVote ? 'yes     ' : 'no      '}  ${cand}`)
  }
  lines.push('')
  lines.push(`  pass@1:        ${pct(report.pass1Rate)} (${report.results.filter((r) => r.pass1).length}/${report.taskCount})`)
  lines.push(`  pass@vote:     ${pct(report.passVoteRate)} (${report.results.filter((r) => r.passVote).length}/${report.taskCount})`)
  lines.push(`  total duration: ${report.totalDurationMs} ms`)
  return lines.join('\n')
}

/** Write the report as pretty JSON, creating the parent directory if needed. */
export async function writeJsonReport(report: ArcEvalReport, outPath: string): Promise<void> {
  const dir = dirname(outPath)
  if (dir) await mkdir(dir, { recursive: true })
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}
