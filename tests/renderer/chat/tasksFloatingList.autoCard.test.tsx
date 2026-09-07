/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TasksRailButton } from '@renderer/features/chat/components/TasksFloatingList'
import { ChatSideRail } from '@renderer/features/chat/components/ChatSideRail'
import type { TodoParsed } from '@renderer/features/chat/toolUi/parsers/todo'

type SeedTodo = { id: string; content: string; status: string }

function todosPayload(todos: SeedTodo[]) {
  return {
    ok: true as const,
    data: {
      name: 'todos.json',
      exists: true,
      content: JSON.stringify({
        updatedAt: '2026-01-01T00:00:00.000Z',
        todos
      })
    }
  }
}

function parsedData(todos: SeedTodo[]): TodoParsed {
  return {
    done: todos.filter((t) => t.status === 'completed').length,
    total: todos.length,
    items: todos as TodoParsed['items']
  }
}

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
  vi.useRealTimers()
})

describe('auto task card', () => {
  const EMPTY = {
    ok: true as const,
    data: { name: 'todos.json', exists: false, content: null }
  }

  it('opens the card automatically when the agent creates todos mid-run', async () => {
    vi.useFakeTimers()
    readRunArtifact.mockResolvedValue(EMPTY)
    render(
      <ChatSideRail
        activePanel={null}
        onSelectPanel={vi.fn()}
        workspacePath="/ws"
        runId="run-1"
        running
      />
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(document.querySelector('[data-tasks-popover-card]')).toBeNull()

    readRunArtifact.mockResolvedValue(
      todosPayload([
        { id: '1', content: 'Map project', status: 'pending' },
        { id: '2', content: 'Run tests', status: 'in_progress' }
      ])
    )
    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })
    const chip = screen.getByRole('button', { name: /Tasks 0 of 2/ })
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    const card = document.querySelector('[data-tasks-popover-card]') as HTMLElement
    expect(card).toBeTruthy()
    const list = card.querySelector('[data-tasks-popover-list]') as HTMLElement
    expect(list.textContent).toContain('Map project')
    // The in-progress row is highlighted inside the list itself — no
    // separate "current task" block.
    expect(list.textContent).toContain('Run tests')
  })

  it('does not auto-open when the rail mounts onto an existing run with todos', async () => {
    vi.useFakeTimers()
    readRunArtifact.mockResolvedValue(
      todosPayload([{ id: '1', content: 'Ship', status: 'pending' }])
    )
    render(
      <ChatSideRail
        activePanel={null}
        onSelectPanel={vi.fn()}
        workspacePath="/ws"
        runId="run-1"
        running
      />
    )
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      vi.advanceTimersByTime(2500)
      await Promise.resolve()
    })
    expect(document.querySelector('[data-tasks-popover-card]')).toBeNull()
    expect(screen.getByText('0/1')).toBeTruthy()
  })

  it('stays quiet after dismissal and opens again for a fresh batch', async () => {
    vi.useFakeTimers()
    readRunArtifact.mockResolvedValue(EMPTY)
    render(
      <ChatSideRail
        activePanel={null}
        onSelectPanel={vi.fn()}
        workspacePath="/ws"
        runId="run-1"
        running
      />
    )
    await act(async () => {
      await Promise.resolve()
    })

    readRunArtifact.mockResolvedValue(
      todosPayload([{ id: '1', content: 'Ship', status: 'pending' }])
    )
    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })
    expect(document.querySelector('[data-tasks-popover-card]')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('[data-tasks-popover-card]')).toBeNull()

    // Same batch: further updates stay dismissed (no re-pop on every poll).
    readRunArtifact.mockResolvedValue(
      todosPayload([{ id: '1', content: 'Ship', status: 'completed' }])
    )
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })
    expect(document.querySelector('[data-tasks-popover-card]')).toBeNull()

    // Batch clears, then a new batch auto-opens again.
    readRunArtifact.mockResolvedValue(EMPTY)
    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })
    readRunArtifact.mockResolvedValue(
      todosPayload([{ id: '2', content: 'Next', status: 'pending' }])
    )
    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })
    expect(document.querySelector('[data-tasks-popover-card]')).toBeTruthy()
  })

  it('renders nothing without todos and never auto-opens', () => {
    const { container } = render(
      <TasksRailButton data={null} onOpenPlan={vi.fn()} />
    )
    expect(container.querySelector('[data-tasks-floating]')).toBeNull()
    expect(document.querySelector('[data-tasks-popover-card]')).toBeNull()
  })
})
