import { describe, expect, it } from 'vitest'
import type { HomeActivityResult } from '@shared/ipc'
import {
  activityDayBars,
  activityModelMix,
  activityOutcomeSegments,
  activitySpendSeries,
  activityTokenTrend,
  activityToolFailures,
  formatCompactCount
} from '@renderer/features/home/activityView'
import { nextTickLabel } from '@renderer/features/home/homeTime'

const NOW = new Date(2026, 0, 7, 12, 0, 0)

describe('activityDayBars', () => {
  it('fills the whole window and scales bars against the busiest day', () => {
    const bars = activityDayBars(
      [
        { date: '2026-01-05', runs: 2, billedInputTokens: 10, outputTokens: 5 },
        { date: '2026-01-07', runs: 8, billedInputTokens: 40, outputTokens: 20 }
      ],
      7,
      NOW
    )
    expect(bars).toHaveLength(7)
    expect(bars.map((bar) => bar.date)).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
      '2026-01-05',
      '2026-01-06',
      '2026-01-07'
    ])
    // Days the aggregator omitted really had no activity.
    expect(bars.map((bar) => bar.runs)).toEqual([0, 0, 0, 0, 2, 0, 8])
    expect(bars[6]!.ratio).toBe(1)
    expect(bars[4]!.ratio).toBeCloseTo(0.25)
    expect(bars[0]!.ratio).toBe(0)
  })

  it('keeps every ratio at zero when the window is idle', () => {
    expect(activityDayBars([], 7, NOW).every((bar) => bar.ratio === 0)).toBe(true)
  })

  it('labels a 7-day axis by weekday and a 30-day axis by day number', () => {
    expect(activityDayBars([], 7, NOW).at(-1)!.label).toBe('W')
    expect(activityDayBars([], 30, NOW).at(-1)!.label).toBe('7')
  })
})

describe('activityOutcomeSegments', () => {
  it('returns only outcomes that occurred, as shares of the total', () => {
    const segments = activityOutcomeSegments({ done: 6, error: 2, cancelled: 0, running: 0 })
    expect(segments.map((segment) => segment.id)).toEqual(['done', 'error'])
    expect(segments[0]!.ratio).toBeCloseTo(0.75)
    expect(segments[1]!.count).toBe(2)
  })

  it('returns nothing when no session finished in the window', () => {
    expect(activityOutcomeSegments({ done: 0, error: 0, cancelled: 0, running: 0 })).toEqual([])
  })
})

describe('activityTokenTrend', () => {
  const totals = (
    extra: Partial<HomeActivityResult['totals']>
  ): HomeActivityResult['totals'] => ({
    runs: 4,
    billedInputTokens: 800,
    outputTokens: 200,
    ...extra
  })

  it('compares against the previous window when there is a baseline', () => {
    expect(activityTokenTrend(totals({ previousTokens: 500 }))).toEqual({
      deltaPct: 100,
      direction: 'up',
      label: '+100% vs previous'
    })
    expect(activityTokenTrend(totals({ previousTokens: 2000 }))?.label).toBe('-50% vs previous')
    expect(activityTokenTrend(totals({ previousTokens: 1000 }))?.direction).toBe('flat')
  })

  it('reports no trend when the previous window had no usage', () => {
    expect(activityTokenTrend(totals({}))).toBeNull()
    expect(activityTokenTrend(totals({ previousTokens: 0 }))).toBeNull()
  })
})

describe('activityToolFailures', () => {
  it('keeps only tools that failed, worst first, capped', () => {
    expect(
      activityToolFailures(
        [
          { name: 'read_file', ok: 40, failed: 0 },
          { name: 'apply_patch', ok: 10, failed: 6 },
          { name: 'run_terminal', ok: 2, failed: 2 },
          { name: 'web_fetch', ok: 1, failed: 1 }
        ],
        2
      )
    ).toEqual([
      { name: 'apply_patch', failed: 6, total: 16, ratio: 6 / 16 },
      { name: 'run_terminal', failed: 2, total: 4, ratio: 0.5 }
    ])
  })

  it('returns nothing when receipts reported no tool stats', () => {
    expect(activityToolFailures(undefined)).toEqual([])
    expect(activityToolFailures([{ name: 'read_file', ok: 9, failed: 0 }])).toEqual([])
  })
})

describe('formatCompactCount', () => {
  it('shortens only magnitudes that need it', () => {
    expect(formatCompactCount(940)).toBe('940')
    expect(formatCompactCount(9_400)).toBe('9,400')
    expect(formatCompactCount(94_000)).toBe('94K')
    expect(formatCompactCount(1_240_000)).toBe('1.2M')
    expect(formatCompactCount(12_400_000)).toBe('12M')
  })
})

describe('activitySpendSeries', () => {
  const day = (date: string, extra: Partial<HomeActivityResult['days'][number]> = {}) => ({
    date,
    runs: 1,
    billedInputTokens: 100,
    outputTokens: 50,
    ...extra
  })

  it('fills the window and gaps the days the aggregator omitted', () => {
    const series = activitySpendSeries([day('2026-01-07', { billedCost: 1.5 })], 7, NOW)
    expect(series).toHaveLength(7)
    expect(series.map((point) => point.date)).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
      '2026-01-05',
      '2026-01-06',
      '2026-01-07'
    ])
    expect(series.at(-1)!.cost).toBe(1.5)
    expect(series.at(-1)!.tokens).toBe(150)
    // A day with no usage is a gap in both metrics, never a fake zero.
    expect(series[0]!.cost).toBeNull()
    expect(series[0]!.tokens).toBeNull()
  })

  it('prefers the provider bill over the estimate, and gaps when neither exists', () => {
    const series = activitySpendSeries(
      [
        day('2026-01-06', { billedCost: 0.5, estimatedCost: 9 }),
        day('2026-01-07', { estimatedCost: 0.75 })
      ],
      7,
      NOW
    )
    expect(series[5]!.cost).toBe(0.5)
    expect(series[6]!.cost).toBe(0.75)
  })

  it('reads a zero-usage day as a token gap', () => {
    const series = activitySpendSeries(
      [day('2026-01-07', { billedInputTokens: 0, outputTokens: 0 })],
      7,
      NOW
    )
    expect(series.at(-1)!.tokens).toBeNull()
  })

  it('labels ticks like the sessions chart', () => {
    expect(activitySpendSeries([], 7, NOW).at(-1)!.label).toBe('W')
    expect(activitySpendSeries([], 30, NOW).at(-1)!.label).toBe('7')
  })
})

describe('activityModelMix', () => {
  it('sums per-model output across days, largest first with shares', () => {
    const mix = activityModelMix([
      {
        date: '2026-01-06',
        runs: 1,
        billedInputTokens: 0,
        outputTokens: 0,
        byModel: { 'claude-sonnet-4': 300, 'claude-opus-5': 100 }
      },
      {
        date: '2026-01-07',
        runs: 1,
        billedInputTokens: 0,
        outputTokens: 0,
        byModel: { 'claude-sonnet-4': 200, 'claude-haiku-4-5': 100 }
      }
    ])
    expect(mix.map((slice) => slice.model)).toEqual([
      'claude-sonnet-4',
      'claude-haiku-4-5',
      'claude-opus-5'
    ])
    expect(mix[0]).toMatchObject({ tokens: 500 })
    expect(mix[0]!.ratio).toBeCloseTo(500 / 700)
    expect(mix[1]).toMatchObject({ tokens: 100 })
    expect(mix[1]!.ratio).toBeCloseTo(100 / 700)
  })

  it('returns nothing when receipts recorded no per-model usage', () => {
    expect(
      activityModelMix([{ date: '2026-01-07', runs: 1, billedInputTokens: 10, outputTokens: 5 }])
    ).toEqual([])
    expect(activityModelMix([])).toEqual([])
  })
})

describe('nextTickLabel', () => {
  const now = Date.parse('2026-01-07T12:00:00Z')

  it('counts down to the scheduled tick', () => {
    expect(nextTickLabel('2026-01-07T12:20:00Z', now)).toBe('in 20m')
    expect(nextTickLabel('2026-01-07T16:00:00Z', now)).toBe('in 4h')
    expect(nextTickLabel('2026-01-10T12:00:00Z', now)).toBe('in 3d')
  })

  it('reads a past or imminent tick as due rather than negative', () => {
    expect(nextTickLabel('2026-01-07T11:00:00Z', now)).toBe('due now')
    expect(nextTickLabel('2026-01-07T12:00:30Z', now)).toBe('due now')
  })

  it('omits the label for an unparseable timestamp', () => {
    expect(nextTickLabel('not-a-date', now)).toBeNull()
  })
})
