/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { RunSearchResult, RunSummary } from '@shared/ipc'

vi.mock('@renderer/features/updates/updaterStore', () => ({
  useUpdateAnnouncement: () => ({ info: null, status: 'idle', progress: null, autoOpen: false }),
  markAnnounced: vi.fn()
}))

import { Navigator, type NavigatorProps } from '@renderer/app/navigator/Navigator'
import { pinnedRunKey } from '@renderer/features/home/pinnedRuns'

const WS = 'C:\\work\\alpha'

// One clock for the file, each run a minute older than the last one made, so
// newest-first order is the order a test lists them in (never the scheduler's).
const NOW = Date.now()
let made = 0
function run(runId: string, over: Partial<RunSummary> = {}): RunSummary {
  made += 1
  return { runId, status: 'done', updatedAt: new Date(NOW - made * 60_000).toISOString(), goal: `Task ${runId}`, ...over }
}

function props(over: Partial<NavigatorProps> = {}): NavigatorProps {
  return {
    place: 'task',
    selected: null,
    openPaths: [WS],
    activePath: WS,
    runsByWorkspacePath: {
      [WS]: { runs: [run('r1', { goal: 'Fix the parser' }), run('r2', { goal: 'Write docs' }), run('r3', { goal: 'Ship release' })] }
    },
    activeRuns: [],
    activeRunsLoaded: true,
    scopePath: null,
    onScopeChange: vi.fn(),
    onNewTask: vi.fn(),
    onOpenHome: vi.fn(),
    onOpenExtensions: vi.fn(),
    onOpenUsage: vi.fn(),
    onOpenSettings: vi.fn(),
    onAddWorkspace: vi.fn(),
    onCloseWorkspace: vi.fn(),
    onLoadOlderRuns: vi.fn(),
    onDismissRunsError: vi.fn(),
    rowActions: { onSelect: vi.fn(), onRename: vi.fn(), onDelete: vi.fn() },
    notifications: {
      items: [],
      unreadCount: 0,
      onMarkRead: vi.fn(),
      onDismiss: vi.fn(),
      onOpenItem: vi.fn(),
      onOpenSettings: vi.fn()
    },
    widthPx: 264,
    ...over
  }
}

afterEach(cleanup)

const rows = (): string[] => [...document.querySelectorAll('[data-nav-row]')].map((el) => el.getAttribute('aria-label') ?? '')

describe('navigator search', () => {
  it('filters titles at once, adds tasks main found words in, shows the line, and lists older matches', async () => {
    const result: RunSearchResult = {
      hits: [
        { workspacePath: WS, runId: 'r2', title: 'Write docs', updatedAt: '', status: 'done', where: 'agent', snippet: 'I rewrote the parser section', matchStart: 14, matchLength: 6 },
        { workspacePath: WS, runId: 'old9', title: 'Ancient parser work', updatedAt: '', status: 'done', where: 'you', snippet: 'parser crash again', matchStart: 0, matchLength: 6 }
      ],
      truncated: false,
      scannedRuns: 4
    }
    const searchRuns = vi.fn(async () => result)
    const p = props({ searchRuns })
    render(<Navigator {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Search tasks' }))
    const box = screen.getByRole('textbox', { name: 'Search tasks' })
    fireEvent.change(box, { target: { value: 'parser' } })

    // Titles match before main answers.
    expect(rows()).toEqual(['Fix the parser'])
    // The query waits out a 200ms debounce first.
    await waitFor(() => expect(searchRuns).toHaveBeenCalledWith([WS], 'parser'), { timeout: 5000 })
    await waitFor(() => expect(rows()).toEqual(['Fix the parser', 'Write docs']), { timeout: 5000 })
    const snippet = document.querySelector('[data-nav-snippet]')!
    expect(snippet.textContent).toBe('Agent: I rewrote the parser section')
    expect(snippet.querySelector('mark')?.textContent).toBe('parser')
    expect(screen.getByText('3 tasks match')).toBeTruthy()

    // A task past the loaded list opens from the Older tasks group.
    const older = screen.getByRole('button', { name: /Ancient parser work/ })
    fireEvent.click(older)
    expect(p.rowActions.onSelect).toHaveBeenCalledWith(WS, 'old9')

    // Escape closes search and brings the whole list back.
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Search tasks' })).toBeNull()
    expect(rows()).toEqual(['Fix the parser', 'Write docs', 'Ship release'])
  })
})

describe('navigator selection and bulk actions', () => {
  it('Ctrl-click and Shift-click select without opening; the bar archives or deletes the settled ones', () => {
    const onArchiveMany = vi.fn()
    const onDeleteMany = vi.fn()
    const p = props({
      onArchiveMany,
      onDeleteMany,
      runsByWorkspacePath: {
        [WS]: { runs: [run('r1', { goal: 'Fix the parser' }), run('live', { goal: 'Still going', status: 'running' }), run('r2', { goal: 'Write docs' }), run('r3', { goal: 'Ship release' })] }
      },
      activeRuns: [{ runId: 'live', workspacePath: WS, invokeId: 1, pendingFollowUps: [] }]
    })
    render(<Navigator {...p} />)
    const byName = (name: string): HTMLElement => screen.getByRole('button', { name })

    fireEvent.click(byName('Write docs'), { ctrlKey: true })
    expect(p.rowActions.onSelect).not.toHaveBeenCalled()
    expect(byName('Write docs').getAttribute('data-nav-checked')).toBe('1')
    fireEvent.click(byName('Ship release'), { shiftKey: true })
    fireEvent.click(byName('Still going'), { ctrlKey: true })
    const bar = screen.getByRole('group', { name: 'Selected tasks' })
    expect(bar.textContent).toContain('3 selected · 1 running left out')

    fireEvent.click(within(bar).getByRole('button', { name: 'Archive' }))
    expect(onArchiveMany).toHaveBeenCalledWith([pinnedRunKey(WS, 'r2'), pinnedRunKey(WS, 'r3')])
    expect(screen.queryByRole('group', { name: 'Selected tasks' })).toBeNull()

    // Keyboard: Ctrl Space on a focused row, and Escape clears.
    const docs = byName('Write docs')
    docs.focus()
    fireEvent.keyDown(docs, { key: ' ', ctrlKey: true })
    expect(docs.getAttribute('data-nav-checked')).toBe('1')
    fireEvent.click(within(screen.getByRole('group', { name: 'Selected tasks' })).getByRole('button', { name: 'Delete…' }))
    expect(onDeleteMany).toHaveBeenCalledWith([{ workspacePath: WS, runId: 'r2' }])

    fireEvent.click(byName('Fix the parser'), { ctrlKey: true })
    fireEvent.keyDown(byName('Fix the parser'), { key: 'Escape' })
    expect(screen.queryByRole('group', { name: 'Selected tasks' })).toBeNull()
  })

  it('offers Archive all done in the View menu for finished, unpinned, unarchived tasks', async () => {
    const onArchiveMany = vi.fn()
    render(
      <Navigator
        {...props({
          onArchiveMany,
          pinnedKeys: new Set([pinnedRunKey(WS, 'r1')])
        })}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    const item = await screen.findByRole('menuitem', { name: /Archive all done \(2\)/ })
    act(() => {
      fireEvent.click(item)
    })
    expect(onArchiveMany).toHaveBeenCalledWith([pinnedRunKey(WS, 'r2'), pinnedRunKey(WS, 'r3')])
  })
})
