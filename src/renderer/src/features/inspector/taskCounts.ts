import type { UiItem } from '@shared/transcript'
import { editStatOf } from '@renderer/features/task/editStat'
import { normalizeRelPath } from '@renderer/features/chat/utils/turnFileDiffs'

/**
 * Per file, what the task's own write calls add up to — the record's count
 * (each replacement diffed old text against new), or null when any write to
 * the file cannot be counted from its arguments.
 *
 * Only for when the task's checkpoints cannot be asked. The checkpoints'
 * answer nets every turn against the file as it is now; this sums the calls.
 */
export function sessionEditTotals(items: readonly UiItem[]): Map<string, { add: number; del: number } | null> {
  const totals = new Map<string, { add: number; del: number } | null>()
  for (const item of items) {
    if (item.kind !== 'tool' || item.tool.status !== 'done') continue
    const stat = editStatOf(item.tool)
    if (!stat) continue
    const key = normalizeRelPath(stat.path)
    const prior = totals.get(key)
    if (!stat.exact || prior === null) {
      totals.set(key, null)
      continue
    }
    totals.set(key, { add: (prior?.add ?? 0) + stat.add, del: (prior?.del ?? 0) + stat.del })
  }
  return totals
}

/** How many write calls have settled — changes only when there is something new to count. */
export function settledWriteCount(items: readonly UiItem[]): number {
  let n = 0
  for (const item of items) {
    if (item.kind !== 'tool' || item.tool.status !== 'done') continue
    const name = item.tool.name
    if (name === 'edit' || name === 'str_replace' || name === 'delete') n += 1
  }
  return n
}
