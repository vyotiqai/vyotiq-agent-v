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
})
