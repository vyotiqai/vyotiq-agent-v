/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  CONTINUE_STRIP_HEADING_ID,
  ContinueStrip
} from '@renderer/features/home/ContinueStrip'
import type { RunSummary } from '@shared/ipc'

afterEach(cleanup)

function makeRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'run-1',
    status: 'done',
    updatedAt: '2026-09-08T00:00:00.000Z',
    goal: 'Ship the release checklist',
    ...overrides
  }
}

function makeEntry(
  workspacePath: string,
  run: RunSummary
): { workspacePath: string; run: RunSummary } {
  return { workspacePath, run }
}

describe('ContinueStrip', () => {
  it('renders nothing for empty entries', () => {
    const onSelect = vi.fn()
    const { container } = render(<ContinueStrip entries={[]} onSelect={onSelect} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders heading and at most maxCards cards', () => {
    const entries = [
      makeEntry('C:/repos/alpha', makeRun({ runId: 'run-a', goal: 'Alpha task' })),
      makeEntry('C:/repos/beta', makeRun({ runId: 'run-b', goal: 'Beta task' })),
      makeEntry('C:/repos/gamma', makeRun({ runId: 'run-c', goal: 'Gamma task' }))
    ]
    render(<ContinueStrip entries={entries} maxCards={2} onSelect={vi.fn()} />)

    const heading = screen.getByRole('heading', { name: 'Continue where you left off' })
    expect(heading.id).toBe(CONTINUE_STRIP_HEADING_ID)

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /Gamma task/ })).toBeNull()
  })

  it('calls onSelect with workspacePath and runId on click', () => {
    const onSelect = vi.fn()
    const entries = [
      makeEntry('C:/repos/alpha', makeRun({ runId: 'run-a', goal: 'Alpha task' }))
    ]
    render(<ContinueStrip entries={entries} onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: /Alpha task/ }))
    expect(onSelect).toHaveBeenCalledWith('C:/repos/alpha', 'run-a')
  })

  it('marks running runs via runningRunIds with a spinning indicator', () => {
    const entries = [
      makeEntry('C:/repos/alpha', makeRun({ runId: 'run-a', goal: 'Alpha task' })),
      makeEntry('C:/repos/beta', makeRun({ runId: 'run-b', goal: 'Beta task' }))
    ]
    render(
      <ContinueStrip entries={entries} runningRunIds={new Set(['run-a'])} onSelect={vi.fn()} />
    )

    const running = screen.getByRole('button', { name: /Alpha task.*alpha.*running/i })
    expect(running.getAttribute('data-continue-running')).toBe('1')
    expect(running.querySelector('.animate-spin')).not.toBeNull()

    const idle = screen.getByRole('button', { name: /Beta task.*beta/i })
    expect(idle.getAttribute('data-continue-running')).toBeNull()
    expect(idle.querySelector('.animate-spin')).toBeNull()
  })

  it('marks runs with status running even when absent from runningRunIds', () => {
    const entries = [
      makeEntry('C:/repos/alpha', makeRun({ runId: 'run-a', status: 'running' }))
    ]
    render(<ContinueStrip entries={entries} runningRunIds={new Set()} onSelect={vi.fn()} />)

    const button = screen.getByRole('button', { name: /running/i })
    expect(button.getAttribute('data-continue-running')).toBe('1')
  })
})
