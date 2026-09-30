import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PausableCallTimer } from '@main/agent/mcp/callTimer'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function timer(idleMs = 100, totalMs = 1000) {
  const fired: string[] = []
  const t = new PausableCallTimer({ idleMs, totalMs, onTimeout: (limit) => fired.push(limit), now: () => Date.now() })
  return { t, fired }
}

describe('MCP call time limits', () => {
  it('times out when the server goes quiet, and progress keeps it alive', () => {
    const { t, fired } = timer()
    t.start()
    vi.advanceTimersByTime(90)
    t.progress()
    vi.advanceTimersByTime(90)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(20)
    expect(fired).toEqual(['idle'])
  })

  it('caps working time even when progress never stops', () => {
    const { t, fired } = timer(100, 250)
    t.start()
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(60)
      t.progress()
    }
    expect(fired).toEqual(['total'])
  })

  it('stops both clocks while the person answers, and gives the server a fresh idle window after', () => {
    const { t, fired } = timer(100, 300)
    t.start()
    vi.advanceTimersByTime(80)
    t.pause()
    vi.advanceTimersByTime(10_000)
    expect(fired).toEqual([])
    t.resume()
    vi.advanceTimersByTime(99)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(1)
    expect(fired).toEqual(['idle'])
  })

  it('counts only working time toward the cap, and pauses nest', () => {
    const { t, fired } = timer(1000, 300)
    t.start()
    vi.advanceTimersByTime(200)
    t.pause()
    t.pause()
    vi.advanceTimersByTime(5_000)
    t.resume()
    vi.advanceTimersByTime(5_000)
    expect(fired).toEqual([])
    t.resume()
    vi.advanceTimersByTime(99)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(1)
    expect(fired).toEqual(['total'])
  })

  it('never fires after stop', () => {
    const { t, fired } = timer()
    t.start()
    t.stop()
    vi.advanceTimersByTime(5_000)
    t.progress()
    t.resume()
    vi.advanceTimersByTime(5_000)
    expect(fired).toEqual([])
  })
})
