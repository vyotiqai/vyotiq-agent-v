/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ToastHost } from '@renderer/lib/ui/ToastHost'
import { getToasts, pushToast, resetToastStoreForTests } from '@renderer/lib/ui/toastStore'

beforeEach(() => {
  vi.useFakeTimers()
  resetToastStoreForTests()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  resetToastStoreForTests()
})

describe('ToastHost', () => {
  it('runs onClick from the toast body and not from dismiss', () => {
    const onClick = vi.fn()
    pushToast('Finished: Fix tests', 'info', 0, onClick)
    render(<ToastHost />)
    fireEvent.click(screen.getByRole('button', { name: 'Finished: Fix tests' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    fireEvent.animationEnd(screen.getByRole('status'), { animationName: 'vy-toast-out' })
    expect(screen.queryByText('Finished: Fix tests')).toBeNull()
  })

  it('dismiss does not run onClick', () => {
    const onClick = vi.fn()
    pushToast('Agent finished', 'info', 0, onClick)
    render(<ToastHost />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(onClick).not.toHaveBeenCalled()
    fireEvent.animationEnd(screen.getByRole('status'), { animationName: 'vy-toast-out' })
    expect(screen.queryByText('Agent finished')).toBeNull()
  })

  it('pauses auto-dismiss while hovered', () => {
    vi.setSystemTime(0)
    pushToast('hover me', 'info', 100)
    render(<ToastHost />)
    const toast = screen.getByText('hover me').closest('[role="status"]') as HTMLElement
    fireEvent.pointerEnter(toast)
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(getToasts()).toHaveLength(1)
    expect(getToasts()[0]?.expiresAt).toBeNull()
    fireEvent.pointerLeave(toast)
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(getToasts()).toHaveLength(0)
  })

  it('does not drive toast progress with requestAnimationFrame', () => {
    const src = readFileSync(join(__dirname, '../../../src/renderer/src/lib/ui/ToastHost.tsx'), 'utf8')
    expect(src).not.toMatch(/requestAnimationFrame/)
    expect(src).toMatch(/vy-toast-progress/)
  })

  it('still auto-dismisses timed toasts without rAF', () => {
    pushToast('timed out', 'info', 100)
    render(<ToastHost />)
    expect(screen.getByText('timed out')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(getToasts()).toHaveLength(0)
  })
})


describe('ToastHost cards', () => {
  it('draws a toast with a detail and an action as a card that counts down', () => {
    const onClick = vi.fn()
    pushToast('Ready for review', {
      state: 'review',
      detail: 'Fade rows under the pinned prompt · 3 files',
      action: { label: 'Review', onClick }
    })
    render(<ToastHost />)
    const card = screen.getByRole('status')
    expect(card.getAttribute('data-toast')).toBe('card')
    expect(card.querySelector('[data-state="review"]')).toBeTruthy()
    expect(screen.getByText('Fade rows under the pinned prompt · 3 files')).toBeTruthy()
    const timer = card.querySelector('.bg-muted') as HTMLElement
    expect(timer.style.animation).toContain('vy-toast-progress 6000ms')
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    fireEvent.animationEnd(card, { animationName: 'vy-toast-out' })
    expect(getToasts()).toHaveLength(0)
  })

  it('stops the countdown bar while hovered, where it stops the timer', () => {
    vi.setSystemTime(0)
    pushToast('Finished', { state: 'done', detail: 'Bump electron', durationMs: 1000, action: { label: 'Open', onClick: vi.fn() } })
    render(<ToastHost />)
    const card = screen.getByRole('status')
    act(() => {
      vi.advanceTimersByTime(400)
    })
    fireEvent.pointerEnter(card)
    const timer = card.querySelector('.bg-muted') as HTMLElement
    // The snapshot changed, so the bar redraws paused at what is left.
    expect(timer.style.animation).toBe('')
    expect(timer.style.transform).toBe('scaleX(0.6)')
    fireEvent.pointerLeave(card)
    expect(timer.style.animation).toContain('vy-toast-progress 600ms')
  })

  it('keeps a plain notice to one line with no countdown bar', () => {
    pushToast('Link copied', 'success')
    render(<ToastHost />)
    const line = screen.getByRole('status')
    expect(line.getAttribute('data-toast')).toBe('line')
    expect(line.querySelector('.bg-muted')).toBeNull()
  })
})
