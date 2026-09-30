import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FATAL_FLUSH_MS, exitAfterFatal, resetFatalExitForTests, setFatalFlush } from '@main/logging/fatalExit'

describe('exit after a fatal error', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetFatalExitForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetFatalExitForTests()
  })

  it('saves queued writes before exiting', async () => {
    const order: string[] = []
    setFatalFlush(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      order.push('saved')
    })
    const exit = vi.fn(() => order.push('exit'))
    const outcomes: string[] = []
    exitAfterFatal(exit, (outcome) => outcomes.push(outcome))

    await vi.advanceTimersByTimeAsync(499)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1 + 250)
    expect(order).toEqual(['saved', 'exit'])
    expect(exit).toHaveBeenCalledWith(1)
    expect(outcomes).toEqual(['saved'])
    // The hard bound was cleared: no second exit.
    await vi.advanceTimersByTimeAsync(FATAL_FLUSH_MS)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('exits at the bound when a write never settles', async () => {
    setFatalFlush(() => new Promise(() => {}))
    const exit = vi.fn()
    exitAfterFatal(exit)
    await vi.advanceTimersByTimeAsync(FATAL_FLUSH_MS - 1)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('still exits when saving fails, and says so', async () => {
    setFatalFlush(async () => {
      throw new Error('disk full')
    })
    const exit = vi.fn()
    const outcomes: string[] = []
    exitAfterFatal(exit, (outcome) => outcomes.push(outcome))
    await vi.advanceTimersByTimeAsync(250)
    expect(outcomes).toEqual(['failed'])
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('ignores a second fatal error while the first is saving', async () => {
    const flush = vi.fn(async () => {})
    setFatalFlush(flush)
    const exit = vi.fn()
    exitAfterFatal(exit)
    exitAfterFatal(exit)
    await vi.advanceTimersByTimeAsync(FATAL_FLUSH_MS)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('exits after the log tick when nothing is wired', async () => {
    const exit = vi.fn()
    exitAfterFatal(exit)
    await vi.advanceTimersByTimeAsync(249)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(exit).toHaveBeenCalledWith(1)
  })
})
