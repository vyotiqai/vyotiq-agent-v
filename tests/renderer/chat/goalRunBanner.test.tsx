/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { GoalRunBanner } from '@renderer/features/chat/components/GoalRunBanner'
import type { RunGoal, RunLoop } from '@shared/ipc'

const goal: RunGoal = {
  objective: 'Make CI green',
  status: 'active',
  createdAt: 't',
  updatedAt: 't'
}

const loop: RunLoop = {
  prompt: 'check CI',
  intervalMs: 30_000,
  status: 'armed',
  nextAt: new Date(Date.now() + 45_000).toISOString()
}

describe('GoalRunBanner', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows pause, complete, and stop loop for an active goal', () => {
    const onPause = vi.fn()
    const onResume = vi.fn()
    const onComplete = vi.fn()
    const onStopLoop = vi.fn()
    render(
      <GoalRunBanner
        goal={goal}
        loop={loop}
        running={false}
        onPause={onPause}
        onResume={onResume}
        onComplete={onComplete}
        onStopLoop={onStopLoop}
      />
    )
    expect(screen.getByText('Make CI green')).toBeTruthy()
    expect(document.querySelector('[data-goal-banner][data-goal-status="active"]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(onPause).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Mark complete' }))
    expect(onComplete).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Stop loop' }))
    expect(onStopLoop).toHaveBeenCalled()
  })

  it('resumes a paused goal and uses stop while a run is live', () => {
    const onPause = vi.fn()
    const onResume = vi.fn()
    const onStopRun = vi.fn()
    const { rerender } = render(
      <GoalRunBanner
        goal={{ ...goal, status: 'paused' }}
        loop={null}
        running={false}
        onPause={onPause}
        onResume={onResume}
        onComplete={vi.fn()}
        onStopLoop={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(onResume).toHaveBeenCalled()

    rerender(
      <GoalRunBanner
        goal={goal}
        loop={null}
        running
        onPause={onPause}
        onResume={onResume}
        onComplete={vi.fn()}
        onStopLoop={vi.fn()}
        onStopRun={onStopRun}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(onPause).toHaveBeenCalled()
    expect(onStopRun).toHaveBeenCalled()
  })
  it('offers only start and dismiss for a proposed goal', () => {
    const onActivate = vi.fn()
    const onDismiss = vi.fn()
    render(
      <GoalRunBanner
        goal={{ ...goal, status: 'proposed', origin: 'agent' }}
        loop={null}
        running={false}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onComplete={vi.fn()}
        onActivate={onActivate}
        onDismiss={onDismiss}
        onStopLoop={vi.fn()}
      />
    )
    expect(document.querySelector('[data-goal-banner][data-goal-status="proposed"]')).toBeTruthy()
    expect(screen.getByText('Suggested goal')).toBeTruthy()
    // None of the active-goal controls: a proposal is not running, so there is
    // nothing to pause or mark complete.
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Mark complete' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Start goal' }))
    expect(onActivate).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalled()
  })

  it('sits on the record column, its band bleeding onto the composer box edge', () => {
    render(
      <GoalRunBanner
        goal={goal}
        loop={loop}
        running={false}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onComplete={vi.fn()}
        onStopLoop={vi.fn()}
      />
    )
    const gutter = document.querySelector('[data-goal-gutter]') as HTMLElement
    const column = document.querySelector('[data-goal-column]') as HTMLElement
    const banner = document.querySelector('[data-goal-banner]') as HTMLElement
    expect(gutter).toBeTruthy()
    expect(column).toBeTruthy()
    expect(banner).toBeTruthy()
    // Same three constants the composer uses, so both columns centre on one
    // axis and both cards land on the record's card edge.
    expect(gutter.classList.contains('pr-2')).toBe(true)
    expect(column.classList.contains('max-w-[780px]')).toBe(true)
    expect(column.classList.contains('px-4')).toBe(true)
    expect(banner.classList.contains('-mx-2')).toBe(true)
    expect(banner.classList.contains('px-3')).toBe(true)
    expect(banner.classList.contains('px-4')).toBe(false)
    expect(banner.parentElement).toBe(column)
    expect(column.parentElement).toBe(gutter)
    // The queried band stays the visible one: no wrapper steals these.
    expect(banner.getAttribute('data-goal-status')).toBe('active')
    expect(banner.getAttribute('role')).toBe('region')
    expect(banner.getAttribute('aria-label')).toBe('Active goal')
  })
})
