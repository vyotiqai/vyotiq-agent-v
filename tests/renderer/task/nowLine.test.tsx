/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { NowLine } from '@renderer/features/task/record/WorkItems'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('NowLine', () => {
  it('counts up how long it has been at it, from when the thought started', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-25T10:00:12.000Z'))
    const { container } = render(<NowLine text={'Reading the swap code\nChecking the watcher'} since="2026-09-25T10:00:00.000Z" />)
    expect(container.textContent).toContain('Checking the watcher')
    expect(container.textContent).toContain('12s')
    act(() => {
      vi.advanceTimersByTime(3_000)
    })
    expect(container.textContent).toContain('15s')
  })

  it('shows no time when it does not know when it started', () => {
    const { container } = render(<NowLine text="Thinking" />)
    expect(container.querySelector('.tnum')).toBeNull()
  })
})
