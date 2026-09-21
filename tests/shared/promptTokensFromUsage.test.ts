/**
 * Providers disagree on what `inputTokens` covers. Context sizing needs the
 * whole prompt; billing needs the raw slices. Shapes below are taken verbatim
 * from recorded `step_usage` rows.
 */
import { describe, expect, it } from 'vitest'
import { promptTokensFromUsage } from '../../src/shared/utils/runTelemetry'

describe('promptTokensFromUsage', () => {
  it('adds the cache slices when the provider reports only uncached input', () => {
    // Recorded run e23fcf6b, step 1 (opencode): the meter read 6 tokens against
    // a 13,070-token local estimate because the 15,900 cache-creation tokens
    // were dropped on the floor.
    expect(
      promptTokensFromUsage({
        inputTokens: 6,
        inputTokensIncludesCache: false,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 15_900
      })
    ).toBe(15_906)
  })

  it('counts a warm Anthropic-shaped cache read once, on the input side', () => {
    expect(
      promptTokensFromUsage({
        inputTokens: 1_200,
        inputTokensIncludesCache: false,
        cachedInputTokens: 48_000
      })
    ).toBe(49_200)
  })

  it('does not double-count providers whose input already includes the cache', () => {
    // Recorded run e23fcf6b, step 3 (glm-5.3-flash): inputTokens is the whole
    // prompt and cachedInputTokens is a subset of it.
    expect(
      promptTokensFromUsage({
        inputTokens: 17_052,
        inputTokensIncludesCache: true,
        cachedInputTokens: 12_160
      })
    ).toBe(17_052)
  })

  it('treats an absent flag as "already the whole prompt"', () => {
    // Adding here would inflate the estimate and compact far too early, which is
    // worse than the under-count it would be guarding against.
    expect(
      promptTokensFromUsage({ inputTokens: 9_000, cachedInputTokens: 4_000 })
    ).toBe(9_000)
  })

  it('ignores missing and non-finite fields', () => {
    expect(promptTokensFromUsage({})).toBe(0)
    expect(
      promptTokensFromUsage({
        inputTokens: Number.NaN,
        inputTokensIncludesCache: false,
        cacheCreationInputTokens: 100
      })
    ).toBe(100)
    expect(
      promptTokensFromUsage({ inputTokens: -5, inputTokensIncludesCache: false })
    ).toBe(0)
  })
})
