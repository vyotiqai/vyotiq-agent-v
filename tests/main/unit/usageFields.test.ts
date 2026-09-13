import { describe, expect, it } from 'vitest'
import {
  billedCostFromUsage,
  cacheWriteTokensFromDetails,
  readFiniteNumber
} from '@main/agent/providers/usageFields'

describe('readFiniteNumber', () => {
  it('accepts finite numbers only', () => {
    expect(readFiniteNumber(1.5)).toBe(1.5)
    expect(readFiniteNumber(0)).toBe(0)
    expect(readFiniteNumber(-3)).toBe(-3)
    expect(readFiniteNumber(Number.NaN)).toBeUndefined()
    expect(readFiniteNumber(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(readFiniteNumber('1')).toBeUndefined()
    expect(readFiniteNumber(null)).toBeUndefined()
    expect(readFiniteNumber(undefined)).toBeUndefined()
  })
})

describe('billedCostFromUsage', () => {
  it('reads OpenRouter-shaped cost fields', () => {
    expect(billedCostFromUsage({ cost: 0.12, cache_discount: 0.01 })).toEqual({
      billedCost: 0.12,
      billedCostSaved: 0.01
    })
  })

  it('falls back to total_cost for OpenAI-compat shapes', () => {
    expect(billedCostFromUsage({ total_cost: 2 })).toEqual({ billedCost: 2 })
  })

  it('omits absent fields rather than defaulting to zero', () => {
    expect(billedCostFromUsage({})).toEqual({})
    expect(billedCostFromUsage({ cost: 0.5 })).toEqual({ billedCost: 0.5 })
    expect(billedCostFromUsage({ cache_discount: 0.25 })).toEqual({ billedCostSaved: 0.25 })
  })

  it('rejects non-finite cost values', () => {
    expect(billedCostFromUsage({ cost: Number.NaN, total_cost: '0.1' })).toEqual({})
  })
})

describe('cacheWriteTokensFromDetails', () => {
  it('prefers details.cache_write_tokens', () => {
    expect(cacheWriteTokensFromDetails({ cache_write_tokens: 10 }, 5)).toBe(10)
  })

  it('falls back to the raw fallback value', () => {
    expect(cacheWriteTokensFromDetails(undefined, 7)).toBe(7)
    expect(cacheWriteTokensFromDetails(null, 0)).toBe(0)
    expect(cacheWriteTokensFromDetails('nope', 3)).toBe(3)
  })

  it('returns undefined when neither source has a finite number', () => {
    expect(cacheWriteTokensFromDetails({ cache_write_tokens: 'x' }, 'y')).toBeUndefined()
    expect(cacheWriteTokensFromDetails({ other: 1 }, undefined)).toBeUndefined()
  })
})
