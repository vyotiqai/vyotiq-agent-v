import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  iterateNetworkWait,
  probeNetworkOnline,
  resolveOfflineWaitMs
} from '@main/agent/networkMonitor'

describe('probeNetworkOnline', () => {
  const savedVitest = process.env.VITEST

  afterEach(() => {
    process.env.VITEST = savedVitest
    vi.restoreAllMocks()
  })

  it('probes with GET because HEAD returns 404 on the Cloudflare trace endpoint', async () => {
    process.env.VITEST = 'false'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 })
    )

    await expect(probeNetworkOnline()).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://1.1.1.1/cdn-cgi/trace',
      expect.objectContaining({ method: 'GET' })
    )
  })
})

describe('iterateNetworkWait', () => {
  const savedVitest = process.env.VITEST

  afterEach(() => {
    process.env.VITEST = savedVitest
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('yields retry intervals before each offline sleep', async () => {
    process.env.VITEST = 'false'
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
    vi.useFakeTimers()

    const intervals: number[] = []
    const pending = (async () => {
      for await (const retryInMs of iterateNetworkWait({ maxWaitMs: 10_000 })) {
        intervals.push(retryInMs)
      }
    })()

    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(2000)
    await pending

    expect(intervals).toEqual([2000, 2000])
  })
})

describe('resolveOfflineWaitMs', () => {
  it('waits indefinitely offline regardless of mode (cap removed)', () => {
    expect(resolveOfflineWaitMs({ offlineWaitMode: 'default' })).toBe(Number.POSITIVE_INFINITY)
    expect(resolveOfflineWaitMs({ offlineWaitMode: 'extended' })).toBe(Number.POSITIVE_INFINITY)
    expect(resolveOfflineWaitMs({ offlineWaitMode: 'wait_forever', autonomousMode: false })).toBe(
      Number.POSITIVE_INFINITY
    )
    expect(resolveOfflineWaitMs({ offlineWaitMode: 'wait_forever', autonomousMode: true })).toBe(
      Number.POSITIVE_INFINITY
    )
  })
})
