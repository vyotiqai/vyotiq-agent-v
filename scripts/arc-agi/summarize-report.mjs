/**
 * ARC-AGI report summarizer (read-only; no source edits).
 *
 * Usage: node scripts/arc-agi/summarize-report.mjs <report.json> [report2.json ...]
 * Prints per-task pass1/passVote counts, candidate diagnostics, and totals.
 */
import { readFileSync } from 'node:fs'

const EXHAUSTION_IDS = new Set(['00d62c1b', '045e512c', '06df4c85', '09629e4f', '0e206a2e', '10fcaaa3'])

function diag(candidate) {
  if (candidate.prediction != null) {
    const rows = candidate.prediction.length
    const cols = candidate.prediction[0]?.length ?? 0
    return `ok ${candidate.durationMs}ms grid=${rows}x${cols}`
  }
  const err = String(candidate.error ?? '')
  return `FAIL ${candidate.durationMs}ms :: ${err.slice(0, 220)}`
}

let firstTotals = null
for (const path of process.argv.slice(2)) {
  const report = JSON.parse(readFileSync(path, 'utf8'))
  let p1 = 0
  let pv = 0
  console.log(`\n=== ${path} ===`)
  console.log(`model=${report.model} tasks=${report.taskCount} candidates=${report.candidateCount} startedAt=${report.startedAt}`)
  for (const task of report.results) {
    if (task.pass1) p1++
    if (task.passVote) pv++
    const mark = EXHAUSTION_IDS.has(task.taskId) ? ' [EXHAUSTION-TARGET]' : ''
    console.log(`${task.taskId} pass1=${task.pass1 ? 1 : 0} vote=${task.passVote ? 1 : 0}${mark}`)
    for (const c of task.candidates) {
      console.log(`   cand[${c.index}] ${diag(c)}`)
    }
  }
  const totals = { p1, pv, n: report.results.length }
  console.log(`TOTAL pass@1=${p1}/${totals.n} (${((p1 / totals.n) * 100).toFixed(1)}%)  pass@vote=${pv}/${totals.n} (${((pv / totals.n) * 100).toFixed(1)}%)`)
  if (firstTotals === null) firstTotals = totals
  else {
    console.log(`DELTA vs first report: pass@1 ${p1 - firstTotals.p1 >= 0 ? '+' : ''}${p1 - firstTotals.p1}, pass@vote ${pv - firstTotals.pv >= 0 ? '+' : ''}${pv - firstTotals.pv}`)
  }
}
