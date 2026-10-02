import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  describeSchedule,
  nextCronTime,
  nextScheduleTime,
  parseCron,
  scheduleCronExpression,
  type CronFields
} from '@shared/scheduleTime'

// Local time is what schedules run in; pin a zone with daylight saving so the
// DST cases mean the same thing on every machine. Restored after, since the
// forks pool can reuse this process for another file.
const previousTz = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'America/New_York'
})
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
})

function fields(expr: string): CronFields {
  const parsed = parseCron(expr)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.fields
}

/** Local wall time, as the schedule reads it. */
function local(y: number, mo: number, d: number, h = 0, mi = 0): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0)
}

function wall(date: Date | null): string {
  if (!date) return 'never'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function nextN(expr: string, from: Date, n: number): string[] {
  const f = fields(expr)
  const out: string[] = []
  let at = from
  for (let i = 0; i < n; i++) {
    const next = nextCronTime(f, at)
    out.push(wall(next))
    if (!next) break
    at = next
  }
  return out
}

describe('the test zone', () => {
  it('is New York (so the DST cases below are real)', () => {
    // EST in January, EDT in July.
    expect(local(2026, 1, 15).getTimezoneOffset()).toBe(300)
    expect(local(2026, 7, 15).getTimezoneOffset()).toBe(240)
  })
})

describe('parseCron', () => {
  it('accepts lists, ranges, steps, names, 7 as Sunday and the @ shorthands', () => {
    for (const expr of [
      '* * * * *',
      '*/15 * * * *',
      '0 9 * * 1-5',
      '0,30 8-18/2 * * *',
      '5/20 * * * *',
      '0 0 1,15 * *',
      '0 12 * jan-mar mon,wed,fri',
      '0 0 * * 7',
      '@daily',
      '@hourly',
      '@weekly',
      '@monthly',
      '@yearly'
    ]) {
      expect(parseCron(expr).ok, expr).toBe(true)
    }
  })

  it('refuses malformed fields with a reason', () => {
    for (const expr of [
      '',
      '* * * *',
      '* * * * * *',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * 32 * *',
      '* * * 13 *',
      '* * * * 8',
      '5-1 * * * *',
      '*/0 * * * *',
      '1-2-3 * * * *',
      ',5 * * * *',
      '* * * foo *',
      '*/x * * * *'
    ]) {
      const parsed = parseCron(expr)
      expect(parsed.ok, expr).toBe(false)
      if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(0)
    }
  })

  it('refuses a date that never exists', () => {
    const parsed = parseCron('0 0 30 2 *')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toMatch(/never/)
  })
})

describe('nextCronTime', () => {
  it('is strictly after the given moment, on the minute', () => {
    expect(nextN('0 9 * * *', local(2026, 3, 2, 9, 0), 2)).toEqual(['2026-03-03 09:00', '2026-03-04 09:00'])
    expect(wall(nextCronTime(fields('0 9 * * *'), local(2026, 3, 2, 8, 59)))).toBe('2026-03-02 09:00')
    const withSeconds = new Date(local(2026, 3, 2, 8, 59).getTime() + 30_000)
    expect(wall(nextCronTime(fields('* * * * *'), withSeconds))).toBe('2026-03-02 09:00')
  })

  it('steps, ranges and lists', () => {
    expect(nextN('*/15 * * * *', local(2026, 3, 2, 10, 7), 4)).toEqual([
      '2026-03-02 10:15',
      '2026-03-02 10:30',
      '2026-03-02 10:45',
      '2026-03-02 11:00'
    ])
    expect(nextN('0,30 8-12/2 * * *', local(2026, 3, 2, 9, 0), 5)).toEqual([
      '2026-03-02 10:00',
      '2026-03-02 10:30',
      '2026-03-02 12:00',
      '2026-03-02 12:30',
      '2026-03-03 08:00'
    ])
    expect(nextN('5/20 * * * *', local(2026, 3, 2, 10, 0), 3)).toEqual([
      '2026-03-02 10:05',
      '2026-03-02 10:25',
      '2026-03-02 10:45'
    ])
  })

  it('weekdays only skips the weekend (2026-03-06 is a Friday)', () => {
    expect(nextN('0 9 * * 1-5', local(2026, 3, 6, 10, 0), 2)).toEqual(['2026-03-09 09:00', '2026-03-10 09:00'])
    expect(nextN('0 9 * * sat,sun', local(2026, 3, 6, 10, 0), 2)).toEqual(['2026-03-07 09:00', '2026-03-08 09:00'])
    expect(nextN('0 9 * * 7', local(2026, 3, 6, 10, 0), 1)).toEqual(['2026-03-08 09:00'])
  })

  it('month ends: the 31st skips short months, Feb 29 waits for a leap year', () => {
    expect(nextN('0 0 31 * *', local(2026, 1, 31, 12, 0), 3)).toEqual([
      '2026-03-31 00:00',
      '2026-05-31 00:00',
      '2026-07-31 00:00'
    ])
    expect(nextN('0 0 29 2 *', local(2026, 1, 1), 2)).toEqual(['2028-02-29 00:00', '2032-02-29 00:00'])
    expect(nextN('59 23 31 12 *', local(2026, 12, 31, 23, 59), 1)).toEqual(['2027-12-31 23:59'])
  })

  it('both day fields restricted: either matches (Vixie cron)', () => {
    // The 13th, or any Friday. 2026-03-13 is itself a Friday.
    expect(nextN('0 0 13 * 5', local(2026, 3, 1), 4)).toEqual([
      '2026-03-06 00:00',
      '2026-03-13 00:00',
      '2026-03-20 00:00',
      '2026-03-27 00:00'
    ])
    // A starred day field means the other one alone decides.
    expect(nextN('0 0 */10 * *', local(2026, 3, 1, 1), 3)).toEqual([
      '2026-03-11 00:00',
      '2026-03-21 00:00',
      '2026-03-31 00:00'
    ])
  })

  it('a local time the clock skips runs once, at the time it maps to', () => {
    // 2026-03-08: 02:00 EST jumps to 03:00 EDT.
    const next = nextCronTime(fields('30 2 * * *'), local(2026, 3, 8, 0, 0))
    expect(wall(next)).toBe('2026-03-08 03:30')
    expect(nextN('30 2 * * *', local(2026, 3, 8, 0, 0), 2)[1]).toBe('2026-03-09 02:30')
    // Every 30 minutes through the gap: no instant twice, never backwards.
    const times = nextN('*/30 * * * *', local(2026, 3, 8, 1, 0), 5)
    expect(times).toEqual([
      '2026-03-08 01:30',
      '2026-03-08 03:00',
      '2026-03-08 03:30',
      '2026-03-08 04:00',
      '2026-03-08 04:30'
    ])
  })

  it('a local time the clock repeats runs on its first pass only', () => {
    // 2026-11-01: 02:00 EDT falls back to 01:00 EST, so 01:30 happens twice.
    const f = fields('30 1 * * *')
    const first = nextCronTime(f, local(2026, 11, 1, 0, 0))!
    expect(wall(first)).toBe('2026-11-01 01:30')
    expect(first.getTimezoneOffset()).toBe(240)
    // Asked again from the second 01:30 (EST), it is tomorrow — not an hour later.
    const secondPass = new Date(first.getTime() + 60 * 60_000)
    expect(wall(secondPass)).toBe('2026-11-01 01:30')
    expect(wall(nextCronTime(f, first))).toBe('2026-11-02 01:30')
    expect(wall(nextCronTime(f, secondPass))).toBe('2026-11-02 01:30')
  })

  it('a daily time keeps its wall-clock hour across a DST change', () => {
    expect(nextN('0 9 * * *', local(2026, 3, 7, 10, 0), 2)).toEqual(['2026-03-08 09:00', '2026-03-09 09:00'])
    const [a, b] = [local(2026, 3, 8, 9, 0), local(2026, 3, 9, 9, 0)]
    // 23 real hours apart on the short day.
    expect(nextCronTime(fields('0 9 * * *'), local(2026, 3, 7, 10))?.getTime()).toBe(a.getTime())
    expect(b.getTime() - local(2026, 3, 7, 9).getTime()).toBe(47 * 3_600_000)
  })
})

describe('nextScheduleTime', () => {
  it('daily and weekly are cron underneath', () => {
    expect(scheduleCronExpression({ kind: 'daily', time: '09:05' })).toBe('5 9 * * *')
    expect(scheduleCronExpression({ kind: 'weekly', days: [1, 3], time: '18:30' })).toBe('30 18 * * 1,3')
    expect(scheduleCronExpression({ kind: 'interval', minutes: 30 })).toBeNull()
    expect(wall(nextScheduleTime({ kind: 'weekly', days: [1, 3], time: '18:30' }, local(2026, 3, 4, 19, 0)))).toBe(
      '2026-03-09 18:30'
    )
  })

  it('an interval counts real minutes from the moment given', () => {
    const from = local(2026, 3, 8, 1, 30)
    const next = nextScheduleTime({ kind: 'interval', minutes: 60 }, from)!
    expect(next.getTime() - from.getTime()).toBe(3_600_000)
    // Across the gap: 01:30 EST + 1h is 03:30 EDT.
    expect(wall(next)).toBe('2026-03-08 03:30')
  })
})

describe('describeSchedule', () => {
  it('says each kind in a few words', () => {
    expect(describeSchedule({ kind: 'daily', time: '09:00' })).toBe('Daily at 09:00')
    expect(describeSchedule({ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' })).toBe('Weekdays at 09:00')
    expect(describeSchedule({ kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '07:15' })).toBe('Daily at 07:15')
    expect(describeSchedule({ kind: 'weekly', days: [1, 3], time: '18:30' })).toBe('Mon, Wed at 18:30')
    expect(describeSchedule({ kind: 'interval', minutes: 15 })).toBe('Every 15 min')
    expect(describeSchedule({ kind: 'interval', minutes: 60 })).toBe('Every hour')
    expect(describeSchedule({ kind: 'interval', minutes: 120 })).toBe('Every 2 hours')
    expect(describeSchedule({ kind: 'cron', expr: '0 9 * * 1-5' })).toBe('Cron 0 9 * * 1-5')
  })
})
