import { UNTITLED_TASK, taskTitleFromGoal } from '../../shared/utils/taskTitle'
import type { UsageTaskDay } from './activityStats'

/**
 * The Usage page's CSV: one row per task per local day, with the same
 * numbers the page sums. Written for spreadsheets — RFC 4180 quoting, CRLF
 * rows, and text cells that a spreadsheet would read as a formula defused.
 */

export const USAGE_CSV_COLUMNS = [
  'date',
  'workspace',
  'workspace_path',
  'task',
  'task_id',
  'model',
  'input_tokens',
  'output_tokens',
  'cached_input_tokens',
  'cost_usd',
  'cost_source'
] as const

/**
 * One CSV field. Quoted when it holds a comma, quote, CR or LF, or edge
 * whitespace; quotes doubled. A text cell starting with `=`, `+`, `-`, `@`,
 * tab or CR is prefixed with `'`, so a task named `=HYPERLINK(…)` stays text
 * when the file is opened in a spreadsheet.
 */
export function csvField(value: string | number | null | undefined, text = true): string {
  if (value == null) return ''
  let s = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : value
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** A cost as plain decimal dollars, at most six places, no exponent. */
function costCell(cost: number): string {
  return Number(cost.toFixed(6)).toString()
}

/** Where a row's cost came from: the provider's bill, a price-list estimate, or both. */
function costSource(row: UsageTaskDay): string {
  const billed = (row.billedCost ?? 0) > 0
  const estimated = (row.estimatedCost ?? 0) > 0
  return billed && estimated ? 'billed+estimated' : billed ? 'billed' : estimated ? 'estimated' : ''
}

/** Last path segment of a workspace, as the navigator names it. */
function workspaceName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

export function usageRowsToCsv(
  rows: readonly UsageTaskDay[],
  titleOf: (goal: string | undefined) => string = (goal) => (goal?.trim() ? taskTitleFromGoal(goal) : UNTITLED_TASK)
): string {
  const lines = [USAGE_CSV_COLUMNS.join(',')]
  for (const row of rows) {
    const cost = (row.billedCost ?? 0) + (row.estimatedCost ?? 0)
    lines.push(
      [
        csvField(row.date, false),
        csvField(workspaceName(row.workspacePath)),
        csvField(row.workspacePath),
        csvField(titleOf(row.goal)),
        csvField(row.runId),
        csvField(row.model ?? ''),
        csvField(row.inputTokens, false),
        csvField(row.outputTokens, false),
        csvField(row.cachedInputTokens, false),
        cost > 0 ? costCell(cost) : '',
        costSource(row)
      ].join(',')
    )
  }
  return `${lines.join('\r\n')}\r\n`
}

/** `vyotiq-usage-2026-09-03-to-2026-10-02.csv` */
export function usageCsvFileName(firstDay: string, lastDay: string): string {
  return `vyotiq-usage-${firstDay}-to-${lastDay}.csv`
}
