/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { NotificationItem, RunSummary } from '@shared/ipc'
import { SESSION_DRAG_MIME } from '@renderer/lib/chat/chatPaneLayout'

const updater = vi.hoisted(() => ({
  state: { info: null as null | { version: string }, status: 'idle', progress: null as null | { percent: number }, autoOpen: false }
}))
vi.mock('@renderer/features/updates/updaterStore', () => ({
  useUpdateAnnouncement: () => updater.state,
  markAnnounced: vi.fn()
}))
vi.mock('@renderer/features/updates/UpdatePanel', () => ({
  UpdatePanel: () => <div data-testid="update-panel" />
}))

import { Navigator, type NavigatorProps } from '@renderer/app/navigator/Navigator'

const WS = 'C:\\work\\alpha'
const OTHER = 'C:\\work\\beta'

function run(runId: string, over: Partial<RunSummary> = {}): RunSummary {
  return { runId, status: 'done', updatedAt: new Date().toISOString(), goal: `Task ${runId}`, ...over }
}

function props(over: Partial<NavigatorProps> = {}): NavigatorProps {
  return {
    place: 'task',
    selected: null,
    openPaths: [WS],
    activePath: WS,
    runsByWorkspacePath: { [WS]: { runs: [run('r1')] } },
    activeRuns: [],
    activeRunsLoaded: true,
    scopePath: null,
    onScopeChange: vi.fn(),
    onNewTask: vi.fn(),
    onOpenHome: vi.fn(),
    onOpenExtensions: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenShortcuts: vi.fn(),
    onAddWorkspace: vi.fn(),
    onCloseWorkspace: vi.fn(),
    onLoadOlderRuns: vi.fn(),
    onDismissRunsError: vi.fn(),
    rowActions: { onSelect: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onExport: vi.fn(), onCopyLink: vi.fn() },
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

beforeEach(() => {
  updater.state = { info: null, status: 'idle', progress: null, autoOpen: false }
})
afterEach(cleanup)

const row = (name: string): HTMLElement => screen.getByRole('button', { name: new RegExp(`^${name}`) })

describe('Navigator', () => {
  it('groups tasks by what they want from you, with a count per group', () => {
    render(
      <Navigator
        {...props({
          runsByWorkspacePath: {
            [WS]: { runs: [run('waiting', { status: 'running' }), run('rv', { review: { files: 2, add: 5, del: 1 } }), run('d')] }
          },
          activeRuns: [
            {
              runId: 'waiting',
              workspacePath: WS,
              invokeId: 1,
              pendingFollowUps: [],
              waiting: { kind: 'approval', since: new Date().toISOString() }
            }
          ]
        })}
      />
    )
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    expect(headings).toEqual(['Needs you1', 'Ready for review1', 'Done1'])
    expect(within(row('Task rv')).getByText('+5')).toBeTruthy()
    expect(within(row('Task rv')).getByText('−1')).toBeTruthy()
  })

  it('marks the open task and opens a task on click', () => {
    const p = props({ selected: { workspacePath: WS, runId: 'r1' } })
    render(<Navigator {...p} />)
    expect(row('Task r1').getAttribute('aria-current')).toBe('page')
    fireEvent.click(row('Task r1'))
    expect(p.rowActions.onSelect).toHaveBeenCalledWith(WS, 'r1')
  })

  it('drags a task into a pane with the session payload', () => {
    render(<Navigator {...props()} />)
    const setData = vi.fn()
    fireEvent.dragStart(row('Task r1'), { dataTransfer: { types: [], setData, effectAllowed: 'copy' } })
    expect(setData).toHaveBeenCalledWith(SESSION_DRAG_MIME, JSON.stringify({ workspacePath: WS, runId: 'r1' }))
  })

  it('asks before deleting, and Esc keeps the task', () => {
    const p = props()
    render(<Navigator {...p} />)
    fireEvent.keyDown(row('Task r1'), { key: 'Delete' })
    const keep = screen.getByRole('button', { name: 'Keep it' })
    fireEvent.keyDown(keep, { key: 'Escape' })
    expect(p.rowActions.onDelete).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Keep it' })).toBeNull()

    fireEvent.keyDown(row('Task r1'), { key: 'Delete' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete Task r1' }))
    expect(p.rowActions.onDelete).toHaveBeenCalledWith(WS, 'r1')
  })

  it('renames in place with F2', () => {
    const p = props()
    render(<Navigator {...p} />)
    fireEvent.keyDown(row('Task r1'), { key: 'F2' })
    const input = screen.getByRole('textbox', { name: 'Rename task' })
    fireEvent.change(input, { target: { value: 'Fix the updater' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(p.rowActions.onRename).toHaveBeenCalledWith(WS, 'r1', 'Fix the updater')
  })

  it('shows five finished tasks, then "N more"', () => {
    const runs = Array.from({ length: 7 }, (_, i) => run(`d${i}`))
    render(<Navigator {...props({ runsByWorkspacePath: { [WS]: { runs } } })} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
    fireEvent.click(screen.getByRole('button', { name: /2 more/ }))
    expect(screen.getAllByRole('listitem')).toHaveLength(7)
  })

  it('offers older tasks once every loaded one is showing and the list was capped', () => {
    const p = props({ runsByWorkspacePath: { [WS]: { runs: [run('d')], runsCapped: true } } })
    render(<Navigator {...p} />)
    fireEvent.click(screen.getByRole('button', { name: /Show older tasks/ }))
    expect(p.onLoadOlderRuns).toHaveBeenCalledWith(WS)
  })

  it('filters by workspace from its menu, and adds workspaces there', () => {
    const p = props({ openPaths: [WS, OTHER], runsByWorkspacePath: { [WS]: { runs: [] }, [OTHER]: { runs: [] } } })
    render(<Navigator {...p} />)
    fireEvent.click(screen.getByRole('button', { name: /All workspaces/ }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'beta' }))
    expect(p.onScopeChange).toHaveBeenCalledWith(OTHER)
  })

  it('names the foreign workspace in a row from outside the active one', () => {
    render(
      <Navigator
        {...props({ openPaths: [WS, OTHER], runsByWorkspacePath: { [WS]: { runs: [] }, [OTHER]: { runs: [run('b1')] } } })}
      />
    )
    expect(within(row('Task b1')).getByText(/beta ·/)).toBeTruthy()
  })

  it('says when a workspace’s tasks could not load, and lets you dismiss it', () => {
    const p = props({ runsByWorkspacePath: { [WS]: { runs: [], runsError: 'EACCES' } } })
    render(<Navigator {...p} />)
    expect(screen.getByRole('alert').textContent).toContain('alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(p.onDismissRunsError).toHaveBeenCalledWith(WS)
  })

  it('dots the bell while something is unread and opens a notification', () => {
    const item: NotificationItem = {
      id: 'n1',
      createdAt: new Date().toISOString(),
      read: false,
      source: 'agent',
      kind: 'run_done',
      title: 'Task finished',
      body: '',
      dedupeKey: 'k',
      action: { type: 'open_run', workspacePath: WS, runId: 'r1' }
    } as NotificationItem
    const p = props({ notifications: { ...props().notifications, items: [item], unreadCount: 1 } })
    render(<Navigator {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications, 1 unread' }))
    fireEvent.click(screen.getByRole('button', { name: /^Task finished/ }))
    expect(p.notifications.onOpenItem).toHaveBeenCalledWith(item)
    // Its finish is unread, so the task's title is bold until it is seen.
    expect(row('Task r1').querySelector('.font-semibold')).toBeTruthy()
  })

  it('says exactly where an update is — never "ready" before it has downloaded', () => {
    updater.state = { info: { version: '1.1.0' }, status: 'available', progress: null, autoOpen: false }
    const { rerender } = render(<Navigator {...props()} />)
    expect(screen.getByRole('button', { name: 'Version 1.1.0 is available' }).textContent).toBe('1.1.0 available')

    updater.state = { info: { version: '1.1.0' }, status: 'downloading', progress: { percent: 41.6 }, autoOpen: false }
    rerender(<Navigator {...props()} />)
    expect(screen.getByRole('button', { name: /Downloading version 1.1.0, 42%/ }).textContent).toBe('1.1.0 · 42%')

    updater.state = { info: { version: '1.1.0' }, status: 'downloaded', progress: null, autoOpen: false }
    rerender(<Navigator {...props()} />)
    expect(screen.getByRole('button', { name: 'Version 1.1.0 is ready to install' }).textContent).toBe('1.1.0 ready')
  })

  it('shows no update chip while the install is current', () => {
    render(<Navigator {...props()} />)
    expect(document.querySelector('[data-update-chip]')).toBeNull()
  })
})
