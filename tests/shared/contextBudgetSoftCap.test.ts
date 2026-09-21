import { describe, expect, it } from 'vitest'
import {
  contentWindowFromRaw,
  proactiveCompactThresholdTokens,
  remainingContentTokens
} from '../../src/shared/domain/contextBudget'

describe('proactiveCompactThresholdTokens', () => {
  it('defaults to 55% of content window', () => {
    expect(proactiveCompactThresholdTokens(100_000)).toBe(55_000)
  })

  it('clamps custom ratios', () => {
    expect(proactiveCompactThresholdTokens(100_000, 0.01)).toBe(5_000)
    expect(proactiveCompactThresholdTokens(100_000, 0.99)).toBe(95_000)
  })
})

describe('remainingContentTokens', () => {
  it('returns spare capacity in the content budget', () => {
    expect(remainingContentTokens(85_000, 10_000)).toBe(75_000)
    expect(remainingContentTokens(85_000, 90_000)).toBe(0)
  })
})

describe('contentWindowFromRaw', () => {
  it('is the sum of the non-buffer shares', () => {
    expect(contentWindowFromRaw(1_000_000)).toBe(850_000)
    expect(contentWindowFromRaw(64_000)).toBe(54_400)
  })
})
