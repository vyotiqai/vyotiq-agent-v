import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForHeapPressureRelief } from '@main/perf/heapPressure'

describe('waitForHeapPressureRelief', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves immediately when pressure is not high', async () => {
    const isHigh = vi.fn(() => false)
    const startedAt = Date.now()
    const ok = await waitForHeapPressureRelief(null, { isHigh, pollMs: 10 })
    expect(ok).toBe(true)
    expect(isHigh).toHaveBeenCalledTimes(1)
    expect(Date.now() - startedAt).toBeLessThan(100)
  })

  it('waits until pressure drops, then proceeds', async () => {
    vi.useFakeTimers()
    let high = true
    const isHigh = vi.fn(() => high)
    const pending = waitForHeapPressureRelief(null, { isHigh, pollMs: 10 })
    const handled = pending.then(
      (ok) => ({ ok }),
      (err) => ({ err })
    )
    await vi.advanceTimersByTimeAsync(50)
    expect(await Promise.race([handled, Promise.resolve(null)])).toBeNull()
    high = false
    await vi.advanceTimersByTimeAsync(50)
    expect(await handled).toMatchObject({ ok: true })
    expect(isHigh.mock.calls.length).toBeGreaterThan(2)
  })

  it('returns false when the signal aborts during the wait', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const isHigh = vi.fn(() => true)
    const handled = waitForHeapPressureRelief(controller.signal, {
      isHigh,
      pollMs: 10
    }).then(
      (ok) => ({ ok }),
      (err) => ({ err })
    )
    await vi.advanceTimersByTimeAsync(30)
    controller.abort()
    await vi.advanceTimersByTimeAsync(30)
    expect(await handled).toMatchObject({ ok: false })
  })

  it('returns false immediately for an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const isHigh = vi.fn(() => true)
    expect(await waitForHeapPressureRelief(controller.signal, { isHigh })).toBe(false)
    expect(isHigh).not.toHaveBeenCalled()
  })

  it('falls through after the bounded max wait instead of hanging forever', async () => {
    vi.useFakeTimers()
    const isHigh = vi.fn(() => true)
    const handled = waitForHeapPressureRelief(null, {
      isHigh,
      pollMs: 10,
      maxWaitMs: 100
    }).then(
      (ok) => ({ ok }),
      (err) => ({ err })
    )
    await vi.advanceTimersByTimeAsync(300)
    expect(await handled).toMatchObject({ ok: true })
    expect(isHigh.mock.calls.length).toBeGreaterThan(1)
  })

  it('treats a max wait below the poll cadence as one poll interval', async () => {
    vi.useFakeTimers()
    const isHigh = vi.fn(() => true)
    const handled = waitForHeapPressureRelief(null, {
      isHigh,
      pollMs: 50,
      maxWaitMs: 1
    }).then(
      (ok) => ({ ok }),
      (err) => ({ err })
    )
    await vi.advanceTimersByTimeAsync(49)
    expect(await Promise.race([handled, Promise.resolve(null)])).toBeNull()
    await vi.advanceTimersByTimeAsync(10)
    expect(await handled).toMatchObject({ ok: true })
  })
})
