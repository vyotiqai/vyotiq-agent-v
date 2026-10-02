import type { TaskScheduleSpec } from './ipc/schemas/schedules'

/**
 * When a scheduled task is next due, in local time. Daily and weekly are
 * written as cron underneath, so there is one calendar walk to get right.
 *
 * The cron dialect is classic five-field (minute hour day-of-month month
 * day-of-week) with `*`, lists, ranges, `/` steps, month and weekday names,
 * 7 as Sunday, and the `@hourly`/`@daily`/`@weekly`/`@monthly`/`@yearly`
 * shorthands. As in Vixie cron, when both day fields are restricted a day
 * matching either one counts.
 *
 * Daylight saving: a local time the clock skips (02:30 on a spring-forward
 * day) runs at the moment it maps to (03:30), once; a local time the clock
 * repeats runs on its first pass only.
 */

export type CronFields = {
  minute: boolean[]
  hour: boolean[]
  /** 1–31. */
  dom: boolean[]
  /** 1–12. */
  month: boolean[]
  /** 0–6, Sunday first. */
  dow: boolean[]
  domStar: boolean
  dowStar: boolean
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const MACROS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *'
}

type FieldSpec = { name: string; min: number; max: number; names?: string[]; namesBase?: number }

const FIELD_SPECS: FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES, namesBase: 1 },
  // 7 is Sunday too; folded onto 0 after parsing.
  { name: 'day of week', min: 0, max: 7, names: DOW_NAMES, namesBase: 0 }
]

function parseValue(raw: string, spec: FieldSpec): number | null {
  if (/^\d+$/.test(raw)) {
    const n = Number(raw)
    return n >= spec.min && n <= spec.max ? n : null
  }
  const index = spec.names?.indexOf(raw.toLowerCase()) ?? -1
  return index >= 0 ? index + (spec.namesBase ?? 0) : null
}

function parseField(source: string, spec: FieldSpec): boolean[] | string {
  const set: boolean[] = new Array(spec.max + 1).fill(false)
  for (const part of source.split(',')) {
    if (!part) return `Empty item in ${spec.name}`
    const pieces = part.split('/')
    if (pieces.length > 2) return `Bad step in ${spec.name}: ${part}`
    const [range, stepText] = pieces as [string, string | undefined]
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) return `Bad step in ${spec.name}: ${part}`
      step = Number(stepText)
    }
    let lo: number
    let hi: number
    if (range === '*') {
      lo = spec.min
      hi = spec.max
    } else if (range.includes('-')) {
      const [a, b, extra] = range.split('-')
      if (extra !== undefined || a === undefined || b === undefined) return `Bad range in ${spec.name}: ${part}`
      const from = parseValue(a, spec)
      const to = parseValue(b, spec)
      if (from === null || to === null) return `Out of range in ${spec.name}: ${part}`
      if (from > to) return `Backwards range in ${spec.name}: ${part}`
      lo = from
      hi = to
    } else {
      const value = parseValue(range, spec)
      if (value === null) return `Out of range in ${spec.name}: ${part}`
      lo = value
      // "5/15" reads as "from 5, every 15".
      hi = stepText !== undefined ? spec.max : value
    }
    for (let v = lo; v <= hi; v += step) set[v] = true
  }
  return set
}

export type CronParse = { ok: true; fields: CronFields } | { ok: false; error: string }

export function parseCron(expression: string): CronParse {
  const trimmed = expression.trim()
  const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed
  const parts = expanded.split(/\s+/).filter(Boolean)
  if (parts.length !== 5) return { ok: false, error: 'Cron needs five fields: minute hour day month weekday' }
  const sets: boolean[][] = []
  for (let i = 0; i < 5; i++) {
    const parsed = parseField(parts[i]!, FIELD_SPECS[i]!)
    if (typeof parsed === 'string') return { ok: false, error: parsed }
    sets.push(parsed)
  }
  const dow = sets[4]!.slice(0, 7)
  if (sets[4]![7]) dow[0] = true
  const fields: CronFields = {
    minute: sets[0]!,
    hour: sets[1]!,
    dom: sets[2]!,
    month: sets[3]!,
    dow,
    domStar: parts[2]!.startsWith('*'),
    dowStar: parts[4]!.startsWith('*')
  }
  if (nextCronTime(fields, new Date(2000, 0, 1)) === null) {
    return { ok: false, error: 'That cron never matches a real date' }
  }
  return { ok: true, fields }
}

function daysInMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate()
}

function dayMatches(fields: CronFields, year: number, month0: number, day: number): boolean {
  const domOk = fields.dom[day] === true
  const dowOk = fields.dow[new Date(year, month0, day).getDay()] === true
  if (fields.domStar || fields.dowStar) return domOk && dowOk
  return domOk || dowOk
}

/** The first matching minute strictly after `after`, or null within ~8 years. */
export function nextCronTime(fields: CronFields, after: Date): Date | null {
  const afterMs = after.getTime()
  let y = after.getFullYear()
  let mo = after.getMonth()
  let d = after.getDate()
  let h = after.getHours()
  let mi = after.getMinutes() + 1
  const lastYear = y + 8
  // Walk the local calendar's fields, not the clock: that is what makes a
  // skipped local time map forward once and a repeated one match once.
  for (let guard = 0; guard < 500_000; guard++) {
    if (mi > 59) {
      mi = 0
      h++
    }
    if (h > 23) {
      h = 0
      d++
    }
    if (mo > 11) {
      mo = 0
      y++
    }
    if (d > daysInMonth(y, mo)) {
      d = 1
      mo++
      if (mo > 11) {
        mo = 0
        y++
      }
    }
    if (y > lastYear) return null
    if (!fields.month[mo + 1]) {
      mo++
      d = 1
      h = 0
      mi = 0
      continue
    }
    if (!dayMatches(fields, y, mo, d)) {
      d++
      h = 0
      mi = 0
      continue
    }
    if (!fields.hour[h]) {
      h++
      mi = 0
      continue
    }
    if (!fields.minute[mi]) {
      mi++
      continue
    }
    const candidate = new Date(y, mo, d, h, mi, 0, 0)
    if (candidate.getTime() > afterMs) return candidate
    mi++
  }
  return null
}

/** Daily and weekly as the cron they are. */
export function scheduleCronExpression(spec: TaskScheduleSpec): string | null {
  if (spec.kind === 'cron') return spec.expr
  if (spec.kind === 'interval') return null
  const [hh, mm] = spec.time.split(':')
  const minute = Number(mm)
  const hour = Number(hh)
  if (spec.kind === 'daily') return `${minute} ${hour} * * *`
  return `${minute} ${hour} * * ${spec.days.join(',')}`
}

/** When `spec` is next due after `after`; null when it never is again. */
export function nextScheduleTime(spec: TaskScheduleSpec, after: Date): Date | null {
  if (spec.kind === 'interval') return new Date(after.getTime() + spec.minutes * 60_000)
  const expr = scheduleCronExpression(spec)
  if (!expr) return null
  const parsed = parseCron(expr)
  return parsed.ok ? nextCronTime(parsed.fields, after) : null
}

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function minutesText(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60
    return hours === 1 ? 'Every hour' : `Every ${hours} hours`
  }
  return `Every ${minutes} min`
}

/** The schedule in a few words: "Daily at 09:00", "Mon, Wed at 18:30", "Every 2 hours", "Cron 0 9 * * 1-5". */
export function describeSchedule(spec: TaskScheduleSpec): string {
  switch (spec.kind) {
    case 'daily':
      return `Daily at ${spec.time}`
    case 'weekly': {
      const days = spec.days
      if (days.length === 7) return `Daily at ${spec.time}`
      if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return `Weekdays at ${spec.time}`
      return `${days.map((d) => DAY_SHORT[d]).join(', ')} at ${spec.time}`
    }
    case 'interval':
      return minutesText(spec.minutes)
    case 'cron':
      return `Cron ${spec.expr}`
  }
}
