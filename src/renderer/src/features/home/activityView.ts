import type { HomeActivityDay, HomeActivityResult } from '@shared/ipc'
import { lastDayKeys, localDayKeyOf } from '@shared/utils/localDay'

/**
 * Presentation transforms for the Activity panel. Every value here comes from
 * a `HomeActivityResult` the main process built out of persisted receipts and
 * usage ledgers — nothing is interpolated or filled in with a guess. Days the
 * aggregator omitted really had no activity, so they render as a zero bar.
 */

/** Thousands separators without locale surprises in the day/count tiles. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

/** Compact token magnitudes — 1.2M / 340K / 1,240. */
export function formatCompactCount(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${m >= 10 ? Math.round(m) : Number(m.toFixed(1))}M`
  }
  if (n >= 10_000) return `${Math.round(n / 1000)}K`
  return formatCount(n)
}

export type ActivityDayBar = {
  date: string
  /** Axis tick — weekday for a 7-day window, day-of-month for longer ones. */
  label: string
  runs: number
  /** Height fraction against the busiest day in the window (0 when all idle). */
  ratio: number
  title: string
}

export function activityDayBars(
  days: readonly HomeActivityDay[],
  windowDays: number,
  now = new Date()
): ActivityDayBar[] {
  const axis = lastDayKeys(localDayKeyOf(now.toISOString()), windowDays)
  const runsByDate = new Map(days.map((day) => [day.date, day.runs]))
  const peak = Math.max(0, ...axis.map((date) => runsByDate.get(date) ?? 0))
  return axis.map((date) => {
    const runs = runsByDate.get(date) ?? 0
    const parsed = new Date(`${date}T00:00:00`)
    const valid = !Number.isNaN(parsed.getTime())
    return {
      date,
      label: valid
        ? windowDays <= 7
          ? parsed.toLocaleDateString('en-US', { weekday: 'narrow' })
          : String(parsed.getDate())
        : date,
      runs,
      ratio: peak > 0 ? runs / peak : 0,
      title: `${valid ? parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : date} — ${runs} ${runs === 1 ? 'task' : 'tasks'}`
    }
  })
}

/** "Mo", "Tu" … — the axis label under a seven-day chart. */
export function weekdayShort(date: string): string {
  const parsed = new Date(`${date}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return date
  return parsed.toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 2)
}

/**
 * The share of tasks that ended and finished — done against done, failed
 * and stopped. A running task has not ended, so it is in neither; with
 * nothing ended there is no share to give.
 */
export function finishedShare(
  outcomes: HomeActivityResult['outcomes']
): { percent: number; done: number; ended: number } | null {
  const ended = outcomes.done + outcomes.error + outcomes.cancelled
  if (ended <= 0) return null
  return { percent: Math.round((outcomes.done / ended) * 100), done: outcomes.done, ended }
}

export type ActivitySpendPoint = {
  date: string
  /** Axis tick — weekday for a 7-day window, day-of-month for longer ones. */
  label: string
  /** "Sep 18" tooltip date, or the raw day key when unparseable. */
  dateLabel: string
  /**
   * Cost reported that day — the provider bill when one exists, the
   * tokens × published-price estimate otherwise. Null means nobody reported
   * a cost: a gap, never a free day.
   */
  cost: number | null
  /** Billed input + output tokens that day; null when the day had no usage. */
  tokens: number | null
}

/**
 * Spend and tokens per local day across the full window axis, same rules as
 * `activityDayBars`: days the aggregator omitted had no usage at all, and a
 * day present in the ledger can still lack a cost when no provider reported
 * one — both render as gaps, not zeros.
 */
export function activitySpendSeries(
  days: readonly HomeActivityDay[],
  windowDays: number,
  now = new Date()
): ActivitySpendPoint[] {
  const axis = lastDayKeys(localDayKeyOf(now.toISOString()), windowDays)
  const byDate = new Map(days.map((day) => [day.date, day]))
  return axis.map((date) => {
    const day = byDate.get(date)
    const parsed = new Date(`${date}T00:00:00`)
    const valid = !Number.isNaN(parsed.getTime())
    return {
      date,
      label: valid
        ? windowDays <= 7
          ? parsed.toLocaleDateString('en-US', { weekday: 'narrow' })
          : String(parsed.getDate())
        : date,
      dateLabel: valid
        ? parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : date,
      cost: day ? (day.billedCost ?? day.estimatedCost ?? null) : null,
      tokens:
        day && day.billedInputTokens + day.outputTokens > 0
          ? day.billedInputTokens + day.outputTokens
          : null
    }
  })
}

export type ActivityModelSlice = {
  model: string
  tokens: number
  /** Share of the window's per-model output tokens. */
  ratio: number
}

/** Output-token share per model across the window, largest first. */
export function activityModelMix(days: readonly HomeActivityDay[]): ActivityModelSlice[] {
  const byModel = new Map<string, number>()
  for (const day of days) {
    for (const [model, tokens] of Object.entries(day.byModel ?? {})) {
      byModel.set(model, (byModel.get(model) ?? 0) + tokens)
    }
  }
  const total = [...byModel.values()].reduce((sum, tokens) => sum + tokens, 0)
  return [...byModel.entries()]
    .filter(([, tokens]) => tokens > 0)
    .sort(([modelA, tokensA], [modelB, tokensB]) => tokensB - tokensA || modelA.localeCompare(modelB))
    .map(([model, tokens]) => ({ model, tokens, ratio: total > 0 ? tokens / total : 0 }))
}
