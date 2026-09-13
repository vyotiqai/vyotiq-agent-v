import { describe, expect, it } from 'vitest'
import { isHeapPressureHigh } from '@main/perf/heapPressure'

describe('isHeapPressureHigh', () => {
  it('is false when the used ratio is below the threshold', () => {
    expect(isHeapPressureHigh(1.1, 0)).toBe(false)
  })

  it('is true when the ratio threshold and absolute floor are both met', () => {
    expect(isHeapPressureHigh(0, 0)).toBe(true)
  })

  it('is false when used bytes are below the absolute floor', () => {
    expect(isHeapPressureHigh(0, Number.MAX_SAFE_INTEGER)).toBe(false)
  })
})
