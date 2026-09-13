/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MessageFooter } from '@renderer/features/chat/components/MessageFooter'
import { emptyStepUsageTotals } from '@shared/utils/runTelemetry'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

beforeEach(() => {
  vi.useFakeTimers()
})

describe('MessageFooter', () => {
  it('shows duration and clock time instead of relative ago', () => {
    const startedAt = Date.parse('2026-08-14T10:14:51.000Z')
    render(
      <MessageFooter
        content="Hello from the assistant"
        at="2026-08-14T10:15:00.000Z"
        startedAt={startedAt}
        endedAt={startedAt + 9000}
      />
    )
    const stamp = screen.getByText('9s')
    expect(screen.queryByText(/ago$|just now/)).toBeNull()
    fireEvent.pointerEnter(stamp)
    act(() => {
      vi.advanceTimersByTime(400)
    })
    const tip = document.body.querySelector('[role="tooltip"]')
    expect(tip?.textContent).toMatch(/\d/)
    expect(tip?.textContent).toMatch(/2026|Aug|10:15|3:45|15:/)
  })

  it('keeps copy working and does not fall back to ago when stats are empty', () => {
    render(<MessageFooter content="Hello from the assistant" />)
    expect(screen.queryByText(/ago$|just now/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeTruthy()
  })

  it('hides copy while streaming', () => {
    render(
      <MessageFooter
        content="Hello from the assistant"
        copyHidden
        usage={{
          ...emptyStepUsageTotals(),
          steps: 1,
          billedInputTokens: 100,
          outputTokens: 10
        }}
      />
    )
    expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull()
    expect(screen.getByText(/tok/)).toBeTruthy()
  })

  it('omits duration while a live turn summary already shows elapsed', () => {
    const startedAt = Date.parse('2026-08-14T10:14:51.000Z')
    render(
      <MessageFooter
        content="Hello from the assistant"
        at="2026-08-14T10:15:00.000Z"
        startedAt={startedAt}
        endedAt={null}
        active
        omitDuration
        usage={{
          ...emptyStepUsageTotals(),
          steps: 1,
          billedInputTokens: 100,
          outputTokens: 10
        }}
      />
    )
    expect(screen.queryByText('9s')).toBeNull()
    expect(screen.getByText(/tok/)).toBeTruthy()
  })

  it('hides the whole receipt while the live summary owns it', () => {
    render(
      <MessageFooter
        content="Hello from the assistant"
        omitReceipt
        usage={{
          ...emptyStepUsageTotals(),
          steps: 1,
          billedInputTokens: 100,
          outputTokens: 10,
          generationMs: 2500
        }}
      />
    )
    expect(screen.queryByText(/tok/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeTruthy()
  })
})
