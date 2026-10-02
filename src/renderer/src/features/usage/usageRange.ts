import { USAGE_MAX_RANGE_DAYS } from '@shared/ipc'
import { localDayKeyOf } from '@shared/utils/localDay'

/** The Usage page's range control: three fixed windows ending today, or two dates. */
export type UsageRangeChoice = '7d' | '30d' | '90d' | 'custom'

export const FIXED_RANGE_DAYS: Record<Exclude<UsageRangeChoice, 'custom'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90
}

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/

/** Local midnight of a YYYY-MM-DD key; null when it is not a real calendar day. */
function dayDate(key: string): Date | null {
  const match = DAY_KEY.exec(key)
  if (!match) return null
  const [, y, m, d] = match
  const date = new Date(Number(y), Number(m) - 1, Number(d))
  return localDayKeyOf(date.toISOString()) === key ? date : null
}

export function todayKey(now = new Date()): string {
  return localDayKeyOf(now.toISOString())
}

/** The day `delta` days from `key` (negative goes back). */
export function shiftDay(key: string, delta: number): string {
  const date = dayDate(key)
  if (!date) return key
  return localDayKeyOf(new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta).toISOString())
}

/** Calendar days from `from` through `to`, both counted (DST-safe). */
export function daysInclusive(from: string, to: string): number {
  const a = dayDate(from)
  const b = dayDate(to)
  if (!a || !b) return 0
  const utc = (d: Date): number => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  return Math.round((utc(b) - utc(a)) / 86_400_000) + 1
}

export type ResolvedRange =
  | { ok: true; windowDays: number; endDay?: string }
  | { ok: false; error: string }

/**
 * Two typed dates as the window main reads: its length and its last day.
 * A range ending today leaves `endDay` out, so it reads like the fixed ones.
 */
export function resolveCustomRange(from: string, to: string, today = todayKey()): ResolvedRange {
  if (!dayDate(from) || !dayDate(to)) return { ok: false, error: 'Pick a start and an end date.' }
  if (from > to) return { ok: false, error: 'The start is after the end.' }
  if (to > today) return { ok: false, error: 'The end is after today.' }
  const windowDays = daysInclusive(from, to)
  if (windowDays > USAGE_MAX_RANGE_DAYS) {
    return { ok: false, error: `A range can span at most ${USAGE_MAX_RANGE_DAYS} days.` }
  }
  return { ok: true, windowDays, ...(to === today ? {} : { endDay: to }) }
}

/** "Sep 3" — "Sep 3, 2025" when it is not this year. */
export function dayLabel(key: string, today = todayKey()): string {
  const date = dayDate(key)
  if (!date) return key
  const sameYear = key.slice(0, 4) === today.slice(0, 4)
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

/** Noon on the range's last day — the `now` the day axis ends on. */
export function rangeEndDate(endDay: string | undefined): Date {
  const date = endDay ? dayDate(endDay) : null
  if (!date) return new Date()
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12)
}
