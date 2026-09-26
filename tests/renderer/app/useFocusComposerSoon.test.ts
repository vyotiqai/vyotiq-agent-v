/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useFocusComposerSoon } from '@renderer/app/useFocusComposerSoon'

const focus = vi.hoisted(() => vi.fn(() => false))
vi.mock('@renderer/lib/shortcuts', () => ({ focusComposerMessage: focus }))

describe('useFocusComposerSoon', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    focus.mockReset()
    focus.mockReturnValue(false)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops as soon as the composer takes focus', () => {
    focus.mockReturnValueOnce(false).mockReturnValueOnce(true)
    const { result } = renderHook(() => useFocusComposerSoon())
    result.current()
    vi.runAllTimers()
    expect(focus).toHaveBeenCalledTimes(2)
  })

  it('gives up after ten retries when no composer mounts', () => {
    const { result } = renderHook(() => useFocusComposerSoon())
    result.current()
    vi.runAllTimers()
    expect(focus).toHaveBeenCalledTimes(11)
  })

  it('a second call replaces the running chain instead of adding one', () => {
    const { result } = renderHook(() => useFocusComposerSoon())
    result.current()
    vi.advanceTimersToNextTimer()
    result.current()
    vi.runAllTimers()
    // 1 from the first chain, then 11 from the second; two chains would make 22.
    expect(focus).toHaveBeenCalledTimes(12)
  })

  it('leaves nothing queued once the caller unmounts', () => {
    const { result, unmount } = renderHook(() => useFocusComposerSoon())
    result.current()
    vi.advanceTimersToNextTimer()
    expect(focus).toHaveBeenCalledTimes(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    vi.runAllTimers()
    expect(focus).toHaveBeenCalledTimes(1)
  })
})
