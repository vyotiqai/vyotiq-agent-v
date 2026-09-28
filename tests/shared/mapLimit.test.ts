import { describe, expect, it } from 'vitest'
import { mapLimit } from '@shared/utils/mapLimit'

describe('mapLimit', () => {
  it('keeps input order with at most `limit` calls in flight', async () => {
    let inFlight = 0
    let peak = 0
    const out = await mapLimit([30, 5, 20, 1, 10, 2], 2, async (ms, i) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, ms))
      inFlight--
      return i * 10
    })
    expect(out).toEqual([0, 10, 20, 30, 40, 50])
    expect(peak).toBe(2)
  })

  it('starts no further calls once one rejects', async () => {
    const started: number[] = []
    await expect(
      mapLimit([0, 1, 2, 3, 4], 1, async (n) => {
        started.push(n)
        if (n === 1) throw new Error('boom')
        return n
      })
    ).rejects.toThrow('boom')
    expect(started).toEqual([0, 1])
  })

  it('maps an empty list to an empty list', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([])
  })
})
