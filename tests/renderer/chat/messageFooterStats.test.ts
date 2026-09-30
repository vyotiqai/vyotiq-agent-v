import { describe, expect, it } from 'vitest'
import { emptyStepUsageTotals, type StepUsageTotals } from '@shared/utils/runTelemetry'
import {
  cacheCaptionPct,
  formatBilledUsd,
  formatTokPerSec,
  freshCaptionTokens,
  outputTokensPerSecond,
  turnCost
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

describe('turnCost', () => {
  it('shows provider-reported cost as actual when every step reported', () => {
    expect(
      turnCost(usage({ steps: 2, stepsWithCostReport: 2, billedCost: 0.012 }))
    ).toEqual({ cost: 0.012, estimated: false })
  })

  it('labels estimated cost when every step is priced from published rates', () => {
    expect(
      turnCost(
        usage({
          steps: 2,
          stepsWithCostReport: 0,
          stepsWithEstimate: 2,
          estimatedCost: 0.0035
        })
      )
    ).toEqual({ cost: 0.0035, estimated: true })
  })

  it('sums mixed reported and estimated steps, labeled as an estimate', () => {
    expect(
      turnCost(
        usage({
          steps: 2,
          stepsWithCostReport: 1,
          billedCost: 0.01,
          stepsWithEstimate: 1,
          estimatedCost: 0.0035
        })
      )
    ).toEqual({ cost: 0.0135, estimated: true })
  })

  it('returns null when any step is unpriceable — no partial estimates', () => {
    expect(
      turnCost(
        usage({
          steps: 2,
          stepsWithCostReport: 0,
          stepsWithEstimate: 1,
          estimatedCost: 0.0035
        })
      )
    ).toBeNull()
    expect(turnCost(usage({ steps: 0 }))).toBeNull()
  })
})

describe('formatBilledUsd', () => {
  it('uses four decimals under a cent and fewer above', () => {
    expect(formatBilledUsd(0.0012)).toBe('$0.0012')
    expect(formatBilledUsd(0.012)).toBe('$0.012')
    expect(formatBilledUsd(1.2)).toBe('$1.20')
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
