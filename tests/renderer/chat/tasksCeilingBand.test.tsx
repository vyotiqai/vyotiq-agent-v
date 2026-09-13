/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { TasksCeilingBand } from '@renderer/features/chat/components/TasksCeilingBand'
import { RunSessionProvider } from '@renderer/features/chat/RunSessionContext'
import { todosArtifactHasItems } from '@renderer/features/chat/hooks/useRunTodos'

function renderBand(
  ui: ReactElement,
  session: { workspacePath: string | null; runId: string | null } = {
    workspacePath: '/ws',
    runId: 'run-1'
  }
) {
  return render(<RunSessionProvider value={session}>{ui}</RunSessionProvider>)
}

describe('TasksCeilingBand', () => {
  const readRunArtifact = vi.fn()

  beforeEach(() => {
    readRunArtifact.mockReset()
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: { readRunArtifact }
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('todosArtifactHasItems requires at least one task', () => {
    expect(todosArtifactHasItems(null)).toBe(false)
    expect(todosArtifactHasItems('{"todos":[]}')).toBe(false)
    expect(
      todosArtifactHasItems(
        JSON.stringify({
          todos: [{ id: '1', content: 'Ship', status: 'pending' }]
        })
      )
    ).toBe(true)
  })

  it('renders a one-liner and expands the checklist in place', async () => {
    readRunArtifact.mockResolvedValue({
      ok: true,
      data: {
        name: 'todos.json',
        exists: true,
        content: JSON.stringify({
          updatedAt: '2026-01-01T00:00:00.000Z',
          todos: [
            { id: '1', content: 'Map project', status: 'completed' },
            { id: '2', content: 'Run tests', status: 'in_progress' }
          ]
        })
      }
    })

    renderBand(<TasksCeilingBand running />)

    await waitFor(() => {
      expect(screen.getByText('Run tests')).toBeTruthy()
    })
    expect(screen.getByText('1/2')).toBeTruthy()
    expect(screen.queryByText('Map project')).toBeNull()
    expect(document.querySelector('[data-tasks-ceiling]')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Expand tasks/i }))

    expect(screen.getByText('Map project')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Collapse tasks/i })).toBeTruthy()
    expect(document.querySelector('[data-tasks-ceiling-progress]')).toBeTruthy()
    expect(screen.getByRole('progressbar')).toBeTruthy()
  })

  it('shows a skipped count when cancelled tasks exist', async () => {
    readRunArtifact.mockResolvedValue({
      ok: true,
      data: {
        name: 'todos.json',
        exists: true,
        content: JSON.stringify({
          updatedAt: '2026-01-01T00:00:00.000Z',
          todos: [
            { id: '1', content: 'Map project', status: 'completed' },
            { id: '2', content: 'Abandoned path', status: 'cancelled' },
            { id: '3', content: 'Run tests', status: 'in_progress' }
          ]
        })
      }
    })

    renderBand(<TasksCeilingBand running />)

    await waitFor(() => {
      expect(screen.getByText('Run tests')).toBeTruthy()
    })
    expect(screen.getByText('1 skipped')).toBeTruthy()
    expect(screen.getByText('1/3')).toBeTruthy()
  })

  it('hides when todos.json is missing', async () => {
    readRunArtifact.mockResolvedValue({
      ok: true,
      data: { name: 'todos.json', exists: false, content: null }
    })

    const { container } = renderBand(<TasksCeilingBand running={false} />)

    await waitFor(() => {
      expect(readRunArtifact).toHaveBeenCalled()
    })
    expect(container.querySelector('[data-tasks-ceiling]')).toBeNull()
  })
})
