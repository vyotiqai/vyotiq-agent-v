import { describe, expect, it } from 'vitest'
import { aggregateRunCost, formatUsdCost, runCostDisplay, windowCostDisplay } from '@shared/utils/costDisplay'

describe('formatUsdCost', () => {
  it('formats zero as $0', () => {
    expect(formatUsdCost(0)).toBe('$0')
  })

  it('keeps 4 decimals for sub-cent values', () => {
    expect(formatUsdCost(0.0012)).toBe('$0.0012')
    expect(formatUsdCost(0.009)).toBe('$0.009')
  })

  it('drops trailing zeros for cent-range values', () => {
    expect(formatUsdCost(0.5)).toBe('$0.5')
    expect(formatUsdCost(0.125)).toBe('$0.125')
  })

  it('uses 2 decimals above $1', () => {
    expect(formatUsdCost(1.5)).toBe('$1.50')
    expect(formatUsdCost(12.345)).toBe('$12.35')
  })

  it('keeps the sign for negative values', () => {
    expect(formatUsdCost(-0.0012)).toBe('-$0.0012')
    expect(formatUsdCost(-1.5)).toBe('-$1.50')
  })
})

describe('runCostDisplay', () => {
  it('returns null when no cost is measurable', () => {
    expect(runCostDisplay(undefined)).toBeNull()
    expect(runCostDisplay(null)).toBeNull()
    expect(runCostDisplay({})).toBeNull()
    expect(runCostDisplay({ billedCost: 0, estimatedCost: 0 })).toBeNull()
  })

  it('shows a provider-reported bill as-is', () => {
    const display = runCostDisplay({ billedCost: 0.012 })
    expect(display).toEqual({
      cost: 0.012,
      text: '$0.012',
      estimated: false,
      title: 'Provider-reported cost for this run'
    })
  })

  it('labels a priced estimate with est.', () => {
    const display = runCostDisplay({ estimatedCost: 0.5 })
    expect(display).toEqual({
      cost: 0.5,
      text: '$0.5 est.',
      estimated: true,
      title: 'Estimated from published model rates — not a provider bill'
    })
  })

  it('labels mixed billed/estimated totals with est.', () => {
    const display = runCostDisplay({ billedCost: 0.012, estimatedCost: 0.5 })
    expect(display).toEqual({
      cost: 0.512,
      text: '$0.512 est.',
      estimated: true,
      title: 'Estimated from published model rates — not a provider bill'
    })
  })
})

describe('aggregateRunCost', () => {
  it('returns null when no run cost is measurable', () => {
    expect(aggregateRunCost([])).toBeNull()
    expect(aggregateRunCost([undefined, {}])).toBeNull()
  })

  it('sums provider-reported bills without an estimate label', () => {
    const total = aggregateRunCost([{ billedCost: 0.012 }, { billedCost: 0.008 }])
    expect(total).toEqual({
      cost: 0.02,
      text: '$0.02',
      estimated: false,
      title: 'Provider-reported cost across sessions'
    })
  })

  it('labels totals that mix billed and estimated runs with est.', () => {
    const total = aggregateRunCost([{ billedCost: 0.012 }, { estimatedCost: 0.5 }])
    expect(total).toEqual({
      cost: 0.512,
      text: '$0.512 est.',
      estimated: true,
      title: 'Estimated from published model rates — not a provider bill'
    })
  })

  it('keeps the estimate label when unpriced sessions contribute nothing', () => {
    const total = aggregateRunCost([{ billedCost: 0.012 }, undefined, {}])
    expect(total).toEqual({
      cost: 0.012,
      text: '$0.012 est.',
      estimated: true,
      title: 'Estimated total — 2 sessions have no measurable cost'
    })
  })

  it('mentions one unpriced session in the singular', () => {
    const total = aggregateRunCost([{ billedCost: 0.012 }, undefined])
    expect(total?.title).toBe('Estimated total — 1 session has no measurable cost')
  })
})

describe('windowCostDisplay', () => {
  it('is a bill across tasks only when every task had one', () => {
    expect(windowCostDisplay({ billedCost: 3, runs: 3, pricedRuns: 3 })).toMatchObject({
      text: '$3.00',
      estimated: false,
      title: 'Provider-reported cost across tasks',
      perTask: 1
    })
  })

  it('is an estimate when some tasks had no cost, and averages over the priced ones', () => {
    expect(windowCostDisplay({ billedCost: 3, runs: 5, pricedRuns: 3 })).toMatchObject({
      text: '$3.00 est.',
      estimated: true,
      title: 'Estimated total — 2 of 5 tasks have no measurable cost',
      perTask: 1
    })
  })

  it('is an estimate when any part was priced from published rates, and nothing without a cost', () => {
    expect(windowCostDisplay({ estimatedCost: 0.5, runs: 1, pricedRuns: 1 })?.title).toBe(
      'Estimated from published model rates — not a provider bill'
    )
    expect(windowCostDisplay({ runs: 4, pricedRuns: 0 })).toBeNull()
  })
})
