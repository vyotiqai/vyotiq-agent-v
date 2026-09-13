import type { RunSummary } from '@shared/ipc'

export type RunRecencyGroup = {
  id: 'today' | 'yesterday' | 'week' | 'older'
  label: string
  runs: RunSummary[]
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Bucket runs into Today / Yesterday / Previous 7 days / Older by updatedAt. */
export function groupRunsByRecency(runs: RunSummary[], now = new Date()): RunRecencyGroup[] {
  const today = startOfDay(now)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const weekAgo = new Date(today)
  weekAgo.setDate(weekAgo.getDate() - 7)

  const buckets: Record<RunRecencyGroup['id'], RunSummary[]> = {
    today: [],
    yesterday: [],
    week: [],
    older: []
  }

  for (const run of runs) {
    const t = new Date(run.updatedAt)
    if (Number.isNaN(t.getTime())) {
      buckets.older.push(run)
      continue
    }
    if (t >= today) buckets.today.push(run)
    else if (t >= yesterday) buckets.yesterday.push(run)
    else if (t >= weekAgo) buckets.week.push(run)
    else buckets.older.push(run)
  }

  const order: Array<{ id: RunRecencyGroup['id']; label: string }> = [
    { id: 'today', label: 'Today' },
    { id: 'yesterday', label: 'Yesterday' },
    { id: 'week', label: 'Previous 7 days' },
    { id: 'older', label: 'Older' }
  ]

  return order
    .filter((g) => buckets[g.id].length > 0)
    .map((g) => ({ id: g.id, label: g.label, runs: buckets[g.id] }))
}
