import { describe, expect, it } from 'vitest'
import { formatTokens } from '@renderer/lib/utils/formatTokens'

describe('formatTokens', () => {
  it('formats small counts as-is', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(42)).toBe('42')
    expect(formatTokens(999)).toBe('999')
  })

  it('formats thousands compactly', () => {
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(4500)).toBe('4.5k')
    expect(formatTokens(45000)).toBe('45k')
    expect(formatTokens(896000)).toBe('896k')
  })

  it('formats millions without trailing decimals', () => {
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_500_000)).toBe('1.5M')
    expect(formatTokens(10_000_000)).toBe('10M')
  })

  it('clamps negative values to 0 by default', () => {
    expect(formatTokens(-1500)).toBe('0')
    expect(formatTokens(-42)).toBe('0')
  })

  it('formats negative values when allowed', () => {
    expect(formatTokens(-1500, true)).toBe('-1.5k')
    expect(formatTokens(-42, true)).toBe('-42')
    expect(formatTokens(-1_500_000, true)).toBe('-1.5M')
  })
})
