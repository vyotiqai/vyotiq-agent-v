import { describe, expect, it } from 'vitest'
import { formatElapsed } from '@shared/utils/timeFormat'

describe('formatElapsed', () => {
  it('returns empty for non-finite or negative input', () => {
    expect(formatElapsed(Number.NaN)).toBe('')
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe('')
    expect(formatElapsed(-1)).toBe('')
  })

  it('formats sub-second durations in milliseconds', () => {
    expect(formatElapsed(0)).toBe('1ms')
    expect(formatElapsed(1)).toBe('1ms')
    expect(formatElapsed(999)).toBe('999ms')
  })

  it('formats seconds under a minute', () => {
    expect(formatElapsed(1000)).toBe('1s')
    expect(formatElapsed(59_400)).toBe('59s')
  })

  it('formats minutes without overflowing to hours', () => {
    expect(formatElapsed(60_000)).toBe('1m')
    expect(formatElapsed(9 * 60_000 + 41_000)).toBe('9m 41s')
    expect(formatElapsed(59 * 60_000)).toBe('59m')
  })

  it('formats hours and omits zero units', () => {
    expect(formatElapsed(3600_000)).toBe('1h')
    expect(formatElapsed(5 * 3600_000)).toBe('5h')
    expect(formatElapsed(5 * 3600_000 + 5 * 60_000)).toBe('5h 5m')
    expect(formatElapsed(5 * 3600_000 + 5 * 60_000 + 49_000)).toBe('5h 5m 49s')
    expect(formatElapsed(5 * 3600_000 + 49_000)).toBe('5h 49s')
    expect(formatElapsed(305 * 60_000 + 49_000)).toBe('5h 5m 49s')
  })
})
