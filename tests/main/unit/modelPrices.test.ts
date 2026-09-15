import { describe, expect, it } from 'vitest'
import { estimateStepCost, resolveModelPrice } from '../../../src/shared/pricing/modelPrices'

describe('resolveModelPrice', () => {
  it('resolves opencode GLM flash at z.ai rates', () => {
    const resolved = resolveModelPrice('opencode', 'glm-5.3-flash')
    expect(resolved).not.toBeNull()
    expect(resolved?.price.input).toBe(0.15)
    expect(resolved?.price.cachedInput).toBe(0.03)
    expect(resolved?.price.output).toBe(0.5)
  })

  it('prefers the flash rule over the family rule (longest prefix)', () => {
    const flash = resolveModelPrice('opencode', 'glm-5.3-flash')
    const pro = resolveModelPrice('opencode', 'glm-5.3')
    expect(flash?.price.output).toBe(0.5)
    expect(pro?.price.output).toBe(4.4)
  })

  it('resolves GLM-5.2 at z.ai rates', () => {
    const resolved = resolveModelPrice('opencode', 'glm-5.2')
    expect(resolved?.price.input).toBe(1.4)
    expect(resolved?.price.cachedInput).toBe(0.26)
    expect(resolved?.price.output).toBe(4.4)
  })

  it('keeps unknown models null (never invents cost)', () => {
    expect(resolveModelPrice('opencode', 'totally-unknown-model')).toBeNull()
    expect(resolveModelPrice('custom', 'glm-5.3-flash')).toBeNull()
    expect(resolveModelPrice('opencode', '')).toBeNull()
  })
})

describe('estimateStepCost with opencode GLM flash', () => {
  const flash = resolveModelPrice('opencode', 'glm-5.3-flash')!

  it('prices a cached step (input includes cached tokens)', () => {
    const cost = estimateStepCost(
      {
        inputTokens: 100_000,
        inputTokensIncludesCache: true,
        outputTokens: 1_000,
        cachedInputTokens: 66_000
      },
      flash
    )
    // 34k fresh in × $0.15/1M + 66k cached × $0.03/1M + 1k out × $0.5/1M
    expect(cost).toBeCloseTo(0.0051 + 0.00198 + 0.0005, 8)
  })

  it('prices an uncached step at the plain rate', () => {
    const cost = estimateStepCost(
      { inputTokens: 50_000, outputTokens: 2_000 },
      flash
    )
    // 50k × $0.15/1M + 2k × $0.5/1M
    expect(cost).toBeCloseTo(0.0075 + 0.001, 8)
  })
})
