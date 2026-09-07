/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  TasksRailButton,
  TasksRailChip
} from '@renderer/features/chat/components/TasksFloatingList'
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

describe('TasksRailChip', () => {
  it('renders nothing when there are no tasks', async () => {
    readRunArtifact.mockResolvedValue({
      ok: true,
      data: { name: 'todos.json', exists: false, content: null }
    })
    const onOpenPlan = vi.fn()
    const { container } = render(
      <TasksRailChip
        workspacePath="/ws"
        runId="run-1"
        running
        onOpenPlan={onOpenPlan}
      />
    )
    await waitFor(() => {
      expect(readRunArtifact).toHaveBeenCalled()
    })
    expect(container.querySelector('[data-tasks-floating]')).toBeNull()
  })

  it('renders a single count chip and opens Plan on click', async () => {
    readRunArtifact.mockResolvedValue(
      todosPayload([
        { id: '1', content: 'Map project', status: 'completed' },
        { id: '2', content: 'Run tests', status: 'in_progress' }
      ])
    )
    const onOpenPlan = vi.fn()
    render(
      <TasksRailChip
        workspacePath="/ws"
        runId="run-1"
        running
        onOpenPlan={onOpenPlan}
      />
    )
    await waitFor(() => {
      expect(screen.getByText('1/2')).toBeTruthy()
    })
    expect(document.querySelector('[data-tasks-floating-chip]')).toBeTruthy()
    expect(document.querySelectorAll('[data-tasks-floating-chip]')).toHaveLength(1)
    expect(screen.queryByText('Map project')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Tasks 1 of 2/ }))
    expect(onOpenPlan).toHaveBeenCalledTimes(1)
  })

  it('sits on the Plan row of the side rail', async () => {
    readRunArtifact.mockResolvedValue(
      todosPayload([{ id: '1', content: 'Ship', status: 'pending' }])
    )
    const onSelectPanel = vi.fn()
    render(
      <ChatSideRail
        activePanel={null}
        onSelectPanel={onSelectPanel}
        workspacePath="/ws"
        runId="run-1"
        running
      />
    )
    await waitFor(() => {
      expect(screen.getByText('0/1')).toBeTruthy()
    })
    const row = document.querySelector('[data-plan-rail-row]')
    expect(row?.querySelector('[data-tasks-floating-chip]')).toBeTruthy()
    expect(row?.querySelector('[data-tasks-floating-chip]')?.className).not.toMatch(
      /flex-col/
    )
  })

  it('renders nothing when todos.json cannot be read', async () => {
    readRunArtifact.mockResolvedValue({ ok: false, error: 'read failed' })
    const onOpenPlan = vi.fn()
    const { container } = render(
      <TasksRailChip
        workspacePath="/ws"
        runId="run-1"
        running
        onOpenPlan={onOpenPlan}
      />
    )
    await waitFor(() => {
      expect(readRunArtifact).toHaveBeenCalled()
    })
    expect(container.querySelector('[data-tasks-floating]')).toBeNull()
  })
})

describe('live plan icon', () => {
  it('shows a static accent status and count while a task is in progress', () => {
    const { container } = render(
      <TasksRailButton
        data={parsedData([
          { id: '1', content: 'Map project', status: 'completed' },
          { id: '2', content: 'Run tests', status: 'in_progress' }
        ])}
        running
        onOpenPlan={vi.fn()}
      />
    )
    const chip = container.querySelector('[data-tasks-floating-chip]') as HTMLElement
    expect(chip).toBeTruthy()
    expect(screen.getByText('1/2')).toBeTruthy()
    expect(chip.querySelector('svg')?.getAttribute('class')).toMatch(/text-accent/)
    expect(chip.querySelector('svg')?.getAttribute('class')).not.toMatch(/animate-spin/)
    expect(chip.getAttribute('aria-haspopup')).toBe('dialog')
    expect(chip.getAttribute('aria-expanded')).toBe('false')
  })

  it('shows a completed status when every task is done', () => {
    const { container } = render(
      <TasksRailButton
        data={parsedData([
          { id: '1', content: 'Map project', status: 'completed' },
          { id: '2', content: 'Run tests', status: 'completed' }
        ])}
        onOpenPlan={vi.fn()}
      />
    )
    const chip = container.querySelector('[data-tasks-floating-chip]') as HTMLElement
    expect(chip.querySelector('svg')?.getAttribute('class')).toMatch(/text-success/)
    expect(chip.querySelector('svg')?.getAttribute('class')).not.toMatch(/animate-spin/)
    expect(screen.getByText('2/2')).toBeTruthy()
  })

  it('shows a completed status once every task is done or skipped', () => {
    const { container } = render(
      <TasksRailButton
        data={parsedData([
          { id: '1', content: 'Map project', status: 'completed' },
          { id: '2', content: 'Run tests', status: 'completed' },
          { id: '3', content: 'Write report', status: 'cancelled' }
        ])}
        onOpenPlan={vi.fn()}
      />
    )
    const chip = container.querySelector('[data-tasks-floating-chip]') as HTMLElement
    expect(chip.querySelector('svg')?.getAttribute('class')).toMatch(/text-success/)
    expect(chip.querySelector('svg')?.getAttribute('class')).not.toMatch(/animate-spin/)
    expect(screen.getByText('2/3')).toBeTruthy()
  })

  it('keeps a neutral status when nothing was completed', () => {
    const { container } = render(
      <TasksRailButton
        data={parsedData([
          { id: '1', content: 'Map project', status: 'cancelled' },
          { id: '2', content: 'Run tests', status: 'cancelled' }
        ])}
        onOpenPlan={vi.fn()}
      />
    )
    const chip = container.querySelector('[data-tasks-floating-chip]') as HTMLElement
    expect(chip.querySelector('svg')?.getAttribute('class')).toMatch(/text-secondary/)
    expect(chip.querySelector('svg')?.getAttribute('class')).not.toMatch(/text-success/)
    expect(screen.getByText('0/2')).toBeTruthy()
  })

  it('announces progress from a live region outside the button', () => {
    const { container } = render(
      <TasksRailButton
        data={parsedData([{ id: '1', content: 'Ship', status: 'in_progress' }])}
        running
        onOpenPlan={vi.fn()}
      />
    )
    const status = container.querySelector('[role="status"]')
    expect(status).toBeTruthy()
    const chip = container.querySelector('[data-tasks-floating-chip]') as HTMLElement
    expect(chip.contains(status as Node)).toBe(false)
    expect(status?.textContent).toContain('Ship')
  })

  it('shows the checklist status when tasks are only pending', () => {
    const { container } = render(
      <TasksRailButton
        data={parsedData([{ id: '1', content: 'Ship', status: 'pending' }])}
        onOpenPlan={vi.fn()}
      />
    )
    const chip = container.querySelector('[data-tasks-floating-chip]') as HTMLElement
    expect(chip.querySelector('svg')?.getAttribute('class')).toMatch(/text-secondary/)
    expect(chip.querySelector('svg')?.getAttribute('class')).not.toMatch(/animate-spin/)
    expect(screen.getByText('0/1')).toBeTruthy()
  })

  it('renders nothing without tasks', () => {
    const { container } = render(
      <TasksRailButton data={null} onOpenPlan={vi.fn()} />
    )
    expect(container.querySelector('[data-tasks-floating]')).toBeNull()
  })
})

describe('TasksRailChip hover card', () => {
  it('opens a live card on hover listing every task and closes on leave', async () => {
    vi.useFakeTimers()
    readRunArtifact.mockResolvedValue(
      todosPayload([
        { id: '1', content: 'Map project', status: 'completed' },
        { id: '2', content: 'Run tests', status: 'in_progress' },
        { id: '3', content: 'Write report', status: 'pending' }
      ])
    )
    const onOpenPlan = vi.fn()
    render(
      <TasksRailChip workspacePath="/ws" runId="run-1" running onOpenPlan={onOpenPlan} />
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByText('Map project')).toBeNull()

    const chip = screen.getByRole('button', { name: /Tasks 1 of 3/ })
    fireEvent.pointerEnter(chip)
    expect(document.querySelector('[data-tasks-popover-card]')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(150)
    })
    const card = document.querySelector('[data-tasks-popover-card]') as HTMLElement
    expect(card).toBeTruthy()
    expect(card.getAttribute('role')).toBe('dialog')
    const list = card.querySelector('[data-tasks-popover-list]') as HTMLElement
    expect(list.textContent).toContain('Map project')
    expect(list.textContent).toContain('Run tests')
    expect(list.textContent).toContain('Write report')
    expect(list.querySelectorAll('li')).toHaveLength(3)
    expect(screen.getByRole('progressbar')).toBeTruthy()
    expect(card.querySelector('[data-tasks-popover-live]')).toBeTruthy()
    expect(chip.getAttribute('aria-expanded')).toBe('true')

    // Moving onto the card keeps it open past the close grace.
    fireEvent.pointerLeave(chip)
    fireEvent.pointerEnter(card)
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(document.querySelector('[data-tasks-popover-card]')).toBeTruthy()

    // Leaving both closes after the grace period.
    fireEvent.pointerLeave(card)
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(document.querySelector('[data-tasks-popover-card]')).toBeNull()
  })

  it('keeps the card open while scrolling its own task list', async () => {
    vi.useFakeTimers()
    const many = Array.from({ length: 14 }, (_, i) => ({
      id: String(i + 1),
      content: `Task ${i + 1}`,
      status: i === 13 ? 'in_progress' : 'pending'
    }))
    readRunArtifact.mockResolvedValue(todosPayload(many))
    render(
      <TasksRailChip workspacePath="/ws" runId="run-1" running onOpenPlan={vi.fn()} />
    )
    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.pointerEnter(screen.getByRole('button', { name: /Tasks 0 of 14/ }))
    act(() => {
      vi.advanceTimersByTime(150)
    })
    const card = document.querySelector('[data-tasks-popover-card]') as HTMLElement
    expect(card).toBeTruthy()
    const list = card.querySelector('[data-tasks-popover-list]') as HTMLElement

    // Scrolling INSIDE the card must not dismiss it.
    fireEvent.scroll(list)
    expect(document.querySelector('[data-tasks-popover-card]')).toBeTruthy()

    // Scrolling the page/transcript outside the card still dismisses it.
    fireEvent.scroll(window)
    expect(document.querySelector('[data-tasks-popover-card]')).toBeNull()
  })

  it('closes the card on Escape and on outside click', async () => {
    vi.useFakeTimers()
    readRunArtifact.mockResolvedValue(
      todosPayload([{ id: '1', content: 'Ship', status: 'in_progress' }])
    )
    render(
      <TasksRailChip workspacePath="/ws" runId="run-1" running onOpenPlan={vi.fn()} />
    )
    await act(async () => {
      await Promise.resolve()
    })

    const chip = screen.getByRole('button', { name: /Tasks 0 of 1/ })
    fireEvent.pointerEnter(chip)
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(document.querySelector('[data-tasks-popover-card]')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('[data-tasks-popover-card]')).toBeNull()

    fireEvent.pointerEnter(chip)
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(document.querySelector('[data-tasks-popover-card]')).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(document.querySelector('[data-tasks-popover-card]')).toBeNull()
  })

  it('opens the plan panel from the card footer button', async () => {
    vi.useFakeTimers()
    readRunArtifact.mockResolvedValue(
      todosPayload([{ id: '1', content: 'Ship', status: 'pending' }])
    )
    const onOpenPlan = vi.fn()
    render(
      <TasksRailChip workspacePath="/ws" runId="run-1" running onOpenPlan={onOpenPlan} />
    )
    await act(async () => {
      await Promise.resolve()
    })

    fireEvent.pointerEnter(screen.getByRole('button', { name: /Tasks 0 of 1/ }))
    act(() => {
      vi.advanceTimersByTime(150)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Open plan panel' }))
    expect(onOpenPlan).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-tasks-popover-card]')).toBeNull()
  })

  it('streams todo updates into the badge and the open card', async () => {
    vi.useFakeTimers()
    readRunArtifact.mockResolvedValue(
      todosPayload([
        { id: '1', content: 'Map project', status: 'pending' },
        { id: '2', content: 'Run tests', status: 'pending' }
      ])
    )
    render(
      <TasksRailChip workspacePath="/ws" runId="run-1" running onOpenPlan={vi.fn()} />
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText('0/2')).toBeTruthy()

    fireEvent.pointerEnter(screen.getByRole('button', { name: /Tasks 0 of 2/ }))
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(document.querySelector('[data-tasks-popover-card]')).toBeTruthy()

    readRunArtifact.mockResolvedValue(
      todosPayload([
        { id: '1', content: 'Map project', status: 'completed' },
        { id: '2', content: 'Run tests', status: 'in_progress' }
      ])
    )
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })
    expect(
      document.querySelector('[data-tasks-floating-count]')?.textContent
    ).toBe('1/2')
    const card = document.querySelector('[data-tasks-popover-card]') as HTMLElement
    expect(card).toBeTruthy()
    expect(card.querySelector('[data-tasks-popover-list]')?.textContent).toContain(
      'Run tests'
    )
  })
})

describe('ChatSideRail plan row', () => {
  it('replaces the doc icon with the single live button when tasks exist', async () => {
    readRunArtifact.mockResolvedValue(
      todosPayload([
        { id: '1', content: 'Map project', status: 'in_progress' },
        { id: '2', content: 'Run tests', status: 'pending' }
      ])
    )
    const onSelectPanel = vi.fn()
    render(
      <ChatSideRail
        activePanel={null}
        onSelectPanel={onSelectPanel}
        workspacePath="/ws"
        runId="run-1"
        running
      />
    )
    await waitFor(() => {
      expect(screen.getByText('0/2')).toBeTruthy()
    })
    const row = document.querySelector('[data-plan-rail-row]')
    expect(row?.querySelectorAll('button')).toHaveLength(1)
    expect(row?.querySelector('[data-tasks-floating-chip]')).toBeTruthy()
    fireEvent.click(row!.querySelector('button')!)
    expect(onSelectPanel).toHaveBeenCalledWith('plan')
  })

  it('keeps the standard doc icon button when the run has no tasks', async () => {
    readRunArtifact.mockResolvedValue({
      ok: true,
      data: { name: 'todos.json', exists: false, content: null }
    })
    render(
      <ChatSideRail
        activePanel={null}
        onSelectPanel={vi.fn()}
        workspacePath="/ws"
        runId="run-1"
        running
      />
    )
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Show plan panel/ })).toBeTruthy()
    })
    const row = document.querySelector('[data-plan-rail-row]')
    expect(row?.querySelector('[data-tasks-floating-chip]')).toBeNull()
  })

  it('falls back to the doc icon when todos.json cannot be read', async () => {
    readRunArtifact.mockResolvedValue({ ok: false, error: 'read failed' })
    render(
      <ChatSideRail
        activePanel={null}
        onSelectPanel={vi.fn()}
        workspacePath="/ws"
        runId="run-1"
        running
      />
    )
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Show plan panel/ })).toBeTruthy()
    })
    expect(document.querySelector('[data-tasks-floating-chip]')).toBeNull()
  })
})
