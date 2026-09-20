/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MessageFooter } from '@renderer/features/chat/components/MessageFooter'
import type { RunFeedbackRating } from '@shared/ipc'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderFooter(
  runFeedback?: { value: RunFeedbackRating | null; onRate: (r: RunFeedbackRating | null) => void }
): void {
  render(<MessageFooter content="the answer" at="2026-09-19T00:00:00.000Z" runFeedback={runFeedback} />)
}

describe('MessageFooter rating control', () => {
  it('renders nothing extra when no run feedback is supplied', () => {
    renderFooter()

    expect(screen.queryByLabelText('Mark helpful')).toBeNull()
    expect(screen.queryByLabelText('Mark unhelpful')).toBeNull()
    // The existing copy action is untouched.
    expect(screen.getByLabelText('Copy message')).toBeTruthy()
  })

  it('reports a new verdict', () => {
    const onRate = vi.fn()
    renderFooter({ value: null, onRate })

    fireEvent.click(screen.getByLabelText('Mark unhelpful'))
    expect(onRate).toHaveBeenCalledWith('down')
  })

  it('clears the verdict when the active thumb is clicked again', () => {
    const onRate = vi.fn()
    renderFooter({ value: 'up', onRate })

    const active = screen.getByLabelText('Marked helpful')
    expect(active.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(active)
    expect(onRate).toHaveBeenCalledWith(null)
  })

  it('marks only the chosen thumb as pressed', () => {
    renderFooter({ value: 'down', onRate: vi.fn() })

    expect(screen.getByLabelText('Marked unhelpful').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText('Mark helpful').getAttribute('aria-pressed')).toBe('false')
  })
})
