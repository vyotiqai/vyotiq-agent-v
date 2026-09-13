import { describe, expect, it } from 'vitest'
import { emptyStepUsageTotals, type StepUsageTotals } from '@shared/utils/runTelemetry'
import {
  buildFooterStats,
  cacheCaptionPct,
  formatBilledUsd,
  formatTokPerSec,
  freshCaptionTokens,
  outputTokensPerSecond,
  reportedBilledCost,
  reportedSavedCost
} from '@renderer/features/chat/utils/messageFooterStats'

function usage(partial: Partial<StepUsageTotals>): StepUsageTotals {
  return { ...emptyStepUsageTotals(), ...partial }
}

describe('freshCaptionTokens', () => {
  it('subtracts cache from OpenAI-shaped input that includes it', () => {
    expect(
      freshCaptionTokens(
        usage({
          billedInputTokens: 1000,
          billedCachedInputTokens: 900,
          outputTokens: 50,
          steps: 1,
          stepsWithCacheReport: 1
        })
      )
    ).toBe(150)
  })

  it('does not subtract cache from Anthropic-shaped input that excludes it', () => {
    expect(
      freshCaptionTokens(
        usage({
          billedInputTokens: 100,
          billedCachedInputTokens: 900,
          outputTokens: 40,
          steps: 1,
          stepsWithCacheReport: 1
        })
      )
    ).toBe(140)
  })

  it('uses explicit Anthropic accounting when cache is smaller than input', () => {
    expect(
      freshCaptionTokens(
        usage({
          billedInputTokens: 1200,
          billedCachedInputTokens: 900,
          outputTokens: 40,
          inputTokensIncludesCache: false,
          steps: 1,
          stepsWithCacheReport: 1
        })
      )
    ).toBe(1240)
  })
})

describe('cacheCaptionPct', () => {
  it('uses billed cache over billed input for OpenAI-shaped usage', () => {
    expect(
      cacheCaptionPct(
        usage({
          billedInputTokens: 1000,
          billedCachedInputTokens: 850,
          steps: 1,
          stepsWithCacheReport: 1
        })
      )
    ).toBe(85)
  })

  it('uses the full Anthropic prompt denominator for cache percentage', () => {
    expect(
      cacheCaptionPct(
        usage({
          billedInputTokens: 1200,
          billedCachedInputTokens: 900,
          cacheCreationInputTokens: 10,
          inputTokensIncludesCache: false,
          steps: 1,
          stepsWithCacheReport: 1
        })
      )
    ).toBe(43)
  })
})

describe('reported costs', () => {
  it('requires every step to report cost before showing $', () => {
    expect(
      reportedBilledCost(
        usage({ steps: 2, stepsWithCostReport: 1, billedCost: 0.01 })
      )
    ).toBeNull()
    expect(
      reportedBilledCost(
        usage({ steps: 2, stepsWithCostReport: 2, billedCost: 0.012 })
      )
    ).toBe(0.012)
  })

  it('omits saved dollars when cache_discount sums to zero or less', () => {
    expect(reportedSavedCost(usage({ billedCostSaved: -0.002 }))).toBeNull()
    expect(reportedSavedCost(usage({ billedCostSaved: 0 }))).toBeNull()
    expect(reportedSavedCost(usage({ billedCostSaved: 0.004 }))).toBe(0.004)
  })
})

describe('formatBilledUsd', () => {
  it('uses four decimals under a cent and fewer above', () => {
    expect(formatBilledUsd(0.0012)).toBe('$0.0012')
    expect(formatBilledUsd(0.012)).toBe('$0.012')
    expect(formatBilledUsd(1.2)).toBe('$1.20')
  })
})

describe('buildFooterStats', () => {
  it('builds a compact caption and omits missing parts', () => {
    const startedAt = Date.parse('2026-08-18T10:00:00.000Z')
    const stats = buildFooterStats({
      startedAt,
      endedAt: startedAt + 9000,
      active: false,
      nowMs: startedAt + 9000,
      at: '2026-08-18T10:00:09.000Z',
      usage: usage({
        steps: 1,
        stepsWithCostReport: 1,
        billedCost: 0.012,
        billedCostSaved: 0.004,
        billedInputTokens: 2000,
        billedCachedInputTokens: 1700,
        outputTokens: 80,
        stepsWithCacheReport: 1,
        generationMs: 2500
      })
    })
    expect(stats.caption).toMatch(/9s/)
    expect(stats.caption).toContain('$0.012')
    expect(stats.caption).toMatch(/380 tok|0\.4k tok/)
    expect(stats.caption).toContain('32 output tok/s')
    expect(stats.caption).toContain('85% cache')
    expect(stats.caption).not.toContain('cached')
    expect(stats.tooltip).not.toMatch(/9s/)
    expect(stats.tooltip).not.toContain('$0.012')
    expect(stats.tooltip).toMatch(/In /)
    expect(stats.tooltip).toMatch(/Out /)
    expect(stats.tooltip).toMatch(/Cache read /)
    expect(stats.tooltip).toContain('Saved $0.004')
    expect(stats.ariaLabel).toMatch(/In /)
  })

  it('omits duration from the caption when TurnSummary already shows it', () => {
    const startedAt = Date.parse('2026-08-18T10:00:00.000Z')
    const stats = buildFooterStats({
      startedAt,
      endedAt: startedAt + 9000,
      active: true,
      nowMs: startedAt + 9000,
      omitDuration: true,
      usage: usage({
        steps: 1,
        billedInputTokens: 200,
        outputTokens: 40
      })
    })
    expect(stats.caption).not.toMatch(/9s/)
    expect(stats.caption).toMatch(/tok/)
  })

  it('omits the whole receipt when the live summary already shows it', () => {
    const startedAt = Date.parse('2026-08-18T10:00:00.000Z')
    const stats = buildFooterStats({
      startedAt,
      endedAt: startedAt + 9000,
      active: true,
      nowMs: startedAt + 9000,
      omitReceipt: true,
      usage: usage({
        steps: 1,
        billedInputTokens: 200,
        outputTokens: 40,
        generationMs: 2500
      })
    })
    expect(stats.caption).toBe('')
  })

  it('omits tok/s without generationMs and omits $ without a reported cost', () => {
    const stats = buildFooterStats({
      startedAt: null,
      endedAt: null,
      active: false,
      nowMs: 0,
      omitDuration: true,
      usage: usage({
        steps: 1,
        billedInputTokens: 200,
        outputTokens: 40
      })
    })
    expect(stats.caption).toMatch(/tok/)
    expect(stats.caption).not.toMatch(/tok\/s/)
    expect(stats.caption).not.toContain('$')
  })
})

describe('outputTokensPerSecond', () => {
  it('divides provider output tokens by stream wall-clock', () => {
    expect(
      outputTokensPerSecond(
        usage({ outputTokens: 80, generationMs: 2500 })
      )
    ).toBe(32)
    expect(outputTokensPerSecond(usage({ outputTokens: 80, generationMs: 0 }))).toBeNull()
    expect(outputTokensPerSecond(usage({ outputTokens: 0, generationMs: 2500 }))).toBeNull()
  })
})

describe('formatTokPerSec', () => {
  it('rounds whole numbers at 10+ and keeps one decimal below', () => {
    expect(formatTokPerSec(32)).toBe('32 output tok/s')
    expect(formatTokPerSec(8.9)).toBe('8.9 output tok/s')
  })
})
