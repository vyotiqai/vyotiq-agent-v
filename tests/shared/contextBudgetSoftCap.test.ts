import { describe, expect, it } from 'vitest'
import {
  compactionTriggerFromRaw,
  contentWindowFromRaw,
  proactiveCompactThresholdTokens,
  remainingContentTokens,
  remainingWindowTokens,
  toolsBudgetFromRaw
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

describe('remainingWindowTokens', () => {
  it('returns spare capacity on the raw window', () => {
    expect(remainingWindowTokens(100_000, 70_000)).toBe(30_000)
    expect(remainingWindowTokens(100_000, 120_000)).toBe(0)
  })
})

describe('remainingContentTokens', () => {
  it('returns spare capacity in the content budget', () => {
    expect(remainingContentTokens(85_000, 10_000)).toBe(75_000)
    expect(remainingContentTokens(85_000, 90_000)).toBe(0)
  })
})

describe('compactionTriggerFromRaw', () => {
  it('equals the hard content window on huge models', () => {
    const trigger = compactionTriggerFromRaw(1_000_000)
    expect(trigger).toBe(contentWindowFromRaw(1_000_000))
    expect(trigger).toBe(850_000)
  })

  it('matches content window on smaller models', () => {
    const trigger = compactionTriggerFromRaw(64_000)
    expect(trigger).toBe(contentWindowFromRaw(64_000))
  })
})

describe('toolsBudgetFromRaw', () => {
  it('uses the raw window share on huge models', () => {
    const budget = toolsBudgetFromRaw(1_000_000)
    expect(budget).toBe(Math.floor(1_000_000 * 0.18))
  })

  it('uses the share budget on smaller windows', () => {
    const budget = toolsBudgetFromRaw(32_000)
    expect(budget).toBe(Math.floor(32_000 * 0.18))
  })
})
