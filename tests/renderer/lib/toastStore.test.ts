import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dismissToast,
  getToasts,
  pauseToast,
  pushToast,
  resetToastStoreForTests,
  resumeToast
} from '@renderer/lib/ui/toastStore'

beforeEach(() => {
  resetToastStoreForTests()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  resetToastStoreForTests()
})

describe('toastStore', () => {
  it('stacks toasts and auto-dismisses after the duration', () => {
    pushToast('one')
    pushToast('two', 'success')
    expect(getToasts().map((t) => t.message)).toEqual(['one', 'two'])
    vi.advanceTimersByTime(6000)
    expect(getToasts()).toEqual([])
  })

  it('replaces an identical visible toast instead of stacking duplicates', () => {
    pushToast('same')
    pushToast('same')
    expect(getToasts()).toHaveLength(1)
  })

  it('caps the stack at the max, keeping the newest', () => {
    for (let i = 1; i <= 6; i++) pushToast(`t${i}`)
    expect(getToasts().map((t) => t.message)).toEqual(['t3', 't4', 't5', 't6'])
  })

  it('dismisses a toast by id and ignores unknown ids', () => {
    const id = pushToast('bye')
    dismissToast(id)
    dismissToast(9999)
    expect(getToasts()).toEqual([])
  })

  it('ignores blank messages', () => {
    expect(pushToast('   ')).toBe(-1)
    expect(getToasts()).toEqual([])
  })

  it('stores an optional click handler', () => {
    const onClick = vi.fn()
    pushToast('Finished: Fix tests', 'info', 6000, onClick)
    expect(getToasts()[0]?.onClick).toBe(onClick)
  })

  it('pauses and resumes the auto-dismiss timer', () => {
    vi.setSystemTime(0)
    const id = pushToast('pause me', 'info', 1000)
    vi.advanceTimersByTime(400)
    pauseToast(id)
    const paused = getToasts()[0]!
    expect(paused.remainingMs).toBe(600)
    expect(paused.expiresAt).toBeNull()
    vi.advanceTimersByTime(400)
    expect(getToasts()).toHaveLength(1)
    resumeToast(id)
    vi.advanceTimersByTime(600)
    expect(getToasts()).toHaveLength(0)
  })

  it('ignores pause and resume for toasts without a duration', () => {
    const id = pushToast('no timeout', 'info', 0)
    pauseToast(id)
    expect(getToasts()).toHaveLength(1)
    resumeToast(id)
    expect(getToasts()).toHaveLength(1)
  })

  it('does nothing when pausing or resuming an unknown toast', () => {
    pauseToast(9999)
    resumeToast(9999)
    expect(getToasts()).toHaveLength(0)
  })
})
