/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { NotificationItem, RunSummary } from '@shared/ipc'
import { RUN_INTERRUPTED_ERROR } from '@shared/runInterrupt'
import { SESSION_DRAG_MIME } from '@renderer/lib/chat/chatPaneLayout'

const updater = vi.hoisted(() => ({
  state: { info: null as null | { version: string }, status: 'idle', progress: null as null | { percent: number }, autoOpen: false }
}))
vi.mock('@renderer/features/updates/updaterStore', () => ({
  useUpdateAnnouncement: () => updater.state,
  markAnnounced: vi.fn()
}))
vi.mock('@renderer/features/updates/UpdatePanel', () => ({
  UpdatePanel: (p: { runningCount?: number }) => <div data-testid="update-panel" data-running={p.runningCount} />
}))

import { FirstRunNavigator, Navigator, type NavigatorProps } from '@renderer/app/navigator/Navigator'
import { requestUpdatePanel } from '@renderer/app/navigator/UpdateChip'
import { act } from '@testing-library/react'

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
    onOpenUsage: vi.fn(),
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

  it('offers what a run can be told from its menu, only when it applies', () => {
    const actions = {
      onSelect: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
      onStop: vi.fn(),
      onResume: vi.fn(),
      onPauseGoal: vi.fn(),
      onStopLoop: vi.fn(),
      onTogglePin: vi.fn()
    }
    render(
      <Navigator
        {...props({
          runsByWorkspacePath: {
            [WS]: {
              runs: [
                run('live', { status: 'running', goal: 'Task live', goalStatus: 'active' }),
                run('cut', { status: 'cancelled', resumable: true, error: RUN_INTERRUPTED_ERROR }),
                run('loop', { loopArmed: true, loopNextAt: new Date(Date.now() + 3_600_000).toISOString() })
              ]
            }
          },
          activeRuns: [{ runId: 'live', workspacePath: WS, invokeId: 1, pendingFollowUps: [] }],
          rowActions: actions
        })}
      />
    )
    const menuFor = (name: string): string[] => {
      fireEvent.contextMenu(row(name))
      const items = screen.getAllByRole('menuitem').map((item) => item.textContent ?? '')
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
      return items
    }

    const liveItems = menuFor('Task live')
    expect(liveItems.slice(0, 3)).toEqual(['Stop', 'Pause goal', 'Pin'])
    expect(liveItems).not.toContain('Resume')
    fireEvent.contextMenu(row('Task live'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pause goal' }))
    expect(actions.onPauseGoal).toHaveBeenCalledWith(WS, 'live', true)

    expect(menuFor('Task cut').slice(0, 2)).toEqual(['Resume', 'Pin'])
    fireEvent.contextMenu(row('Task cut'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resume' }))
    expect(actions.onResume).toHaveBeenCalledWith(WS, 'cut')

    expect(menuFor('Task loop').slice(0, 2)).toEqual(['Stop loop', 'Pin'])
    fireEvent.contextMenu(row('Task loop'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin' }))
    expect(actions.onTogglePin).toHaveBeenCalledWith(WS, 'loop')
  })

  it('lists pinned tasks in their own group, and offers to unpin them', () => {
    const p = props({
      runsByWorkspacePath: { [WS]: { runs: [run('keep'), run('other')] } },
      rowActions: { onSelect: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onTogglePin: vi.fn() },
      pinnedKeys: new Set([`${WS}\u0000keep`])
    })
    render(<Navigator {...p} />)
    const pinned = document.querySelector('[data-nav-section="pinned"]') as HTMLElement
    expect(within(pinned).getByRole('heading').textContent).toBe('Pinned1')
    fireEvent.contextMenu(within(pinned).getByRole('button', { name: /^Task keep/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unpin' }))
    expect(p.rowActions.onTogglePin).toHaveBeenCalledWith(WS, 'keep')
  })

  it('lists Usage among the places', () => {
    const p = props({ place: 'usage' })
    render(<Navigator {...p} />)
    const usage = screen.getByRole('button', { name: 'Usage' })
    expect(usage.getAttribute('aria-current')).toBe('page')
    fireEvent.click(usage)
    expect(p.onOpenUsage).toHaveBeenCalledTimes(1)
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

  it('tells the update panel how many tasks a restart would interrupt, in every workspace', () => {
    updater.state = { info: { version: '1.1.0' }, status: 'downloaded', progress: null, autoOpen: true }
    const p = props({
      openPaths: [WS, OTHER],
      scopePath: WS,
      runsByWorkspacePath: {
        [WS]: { runs: [run('r1', { status: 'running' }), run('r2'), run('i1', { inlineInstance: true, parentRunId: 'r1' })] },
        [OTHER]: { runs: [run('r3', { status: 'running' })] }
      },
      activeRuns: [
        { runId: 'r1', workspacePath: WS, invokeId: 1, pendingFollowUps: [] },
        { runId: 'i1', workspacePath: WS, invokeId: 1, pendingFollowUps: [] },
        { runId: 'r3', workspacePath: OTHER, invokeId: 1, pendingFollowUps: [] }
      ]
    })
    render(<Navigator {...p} />)
    // r1 and r3 are live tasks; the instance belongs to r1 and the switcher's scope hides nothing here.
    expect(screen.getByTestId('update-panel').getAttribute('data-running')).toBe('2')
  })

  it('opens itself for a new version without taking focus from what you were typing in', async () => {
    updater.state = { info: { version: '1.1.0' }, status: 'available', progress: null, autoOpen: true }
    const field = document.createElement('textarea')
    document.body.appendChild(field)
    field.focus()
    render(<Navigator {...props()} />)
    const panel = await screen.findByRole('dialog', { name: 'Version 1.1.0 is available' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(document.activeElement).toBe(field)
    // Escape closes it and leaves focus where it was.
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Version 1.1.0 is available' })).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(document.activeElement).toBe(field)
    field.remove()
    expect(panel).toBeTruthy()
  })

  it('takes focus into the panel when you open it yourself', async () => {
    updater.state = { info: { version: '1.1.0' }, status: 'available', progress: null, autoOpen: false }
    render(<Navigator {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Version 1.1.0 is available' }))
    const panel = await screen.findByRole('dialog', { name: 'Version 1.1.0 is available' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(panel.contains(document.activeElement)).toBe(true)
  })

  it('opens the update panel when the inbox row asks, and takes focus there', async () => {
    updater.state = { info: { version: '1.1.0' }, status: 'downloaded', progress: null, autoOpen: false }
    render(<Navigator {...props()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => requestUpdatePanel())
    const panel = await screen.findByRole('dialog', { name: 'Version 1.1.0 is ready to install' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(panel.contains(document.activeElement)).toBe(true)
  })

  it('draws an update-ready row with the download mark, not a task state', () => {
    const item: NotificationItem = {
      id: 'u1',
      createdAt: new Date().toISOString(),
      read: false,
      source: 'system',
      kind: 'update_ready',
      title: 'Agent V 1.1.0 is ready',
      body: 'Restart to install',
      dedupeKey: 'update_ready',
      action: { type: 'open_update' }
    }
    render(<Navigator {...props({ notifications: { ...props().notifications, items: [item], unreadCount: 1 } })} />)
    fireEvent.click(screen.getByRole('button', { name: /^Notifications/ }))
    const rowEl = document.querySelector('[data-notification-kind="update_ready"]') as HTMLElement
    expect(rowEl.textContent).toContain('Agent V 1.1.0 is ready')
    expect(rowEl.textContent).toContain('Restart to install')
    expect(rowEl.querySelector('svg')).toBeTruthy()
  })

  it('is the mockup\'s first-run column while Set up is on screen', () => {
    const { rerender } = render(<FirstRunNavigator workspaceName={null} widthPx={264} />)
    const nav = screen.getByRole('navigation', { name: 'Tasks' })
    expect(nav.textContent).toBe('No workspace yetTasks you start show up here, grouped by what they need from you.')
    expect(within(nav).queryAllByRole('button')).toHaveLength(0)
    rerender(<FirstRunNavigator workspaceName="site" widthPx={264} />)
    expect(nav.textContent?.startsWith('site')).toBe(true)
  })

  it('lists drafts just above Done, and opens or deletes one', () => {
    const draft = (id: string, brief: string, doneWhen: string[] = []) => ({
      id,
      brief,
      doneWhen,
      createdAt: new Date().toISOString(),
      updatedAt: new Date(Date.now() - 5 * 60_000).toISOString()
    })
    const onOpen = vi.fn()
    const onDelete = vi.fn()
    const items = [
      { workspacePath: WS, draft: draft('d0000000-0000-4000-8000-00000000000a', 'Fix the **updater** swap') },
      { workspacePath: WS, draft: draft('d0000000-0000-4000-8000-00000000000b', '', ['Suite passes']) },
      { workspacePath: 'C:\elsewhere', draft: draft('d0000000-0000-4000-8000-00000000000c', 'Not open here') }
    ]
    render(<Navigator {...props({ drafts: { items, actions: { onOpen, onDelete } } })} />)
    const order = Array.from(document.querySelectorAll('[data-nav-section]')).map((el) => el.getAttribute('data-nav-section'))
    expect(order).toEqual(['drafts', 'done'])
    const group = screen.getByRole('region', { name: /^Drafts/ })
    const rows = within(group).getAllByRole('button', { name: /^(?!Actions)/ })
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual(['Fix the updater swap', 'Suite passes'])
    expect(group.textContent).toContain('5m')
    fireEvent.click(rows[0]!)
    expect(onOpen).toHaveBeenCalledWith(WS, items[0]!.draft)
    fireEvent.keyDown(rows[1]!, { key: 'Delete' })
    expect(onDelete).toHaveBeenCalledWith(WS, items[1]!.draft)
    expect(rows.every((r) => !r.hasAttribute('aria-current'))).toBe(true)
  })

  it('marks the draft New task is continuing', () => {
    const item = {
      workspacePath: WS,
      draft: { id: 'd0000000-0000-4000-8000-00000000000e', brief: 'Being continued', doneWhen: [], createdAt: '2026-09-24T10:00:00Z', updatedAt: '2026-09-24T10:00:00Z' }
    }
    render(
      <Navigator
        {...props({
          drafts: {
            items: [item],
            actions: { onOpen: vi.fn(), onDelete: vi.fn() },
            open: { workspacePath: WS, draftId: item.draft.id }
          }
        })}
      />
    )
    const rowEl = screen.getByRole('button', { name: 'Being continued' })
    expect(rowEl.getAttribute('aria-current')).toBe('page')
    expect(rowEl.classList.contains('bg-surface-2')).toBe(true)
    expect(rowEl.classList.contains('hover:bg-surface')).toBe(false)
  })

  it('shows drafts, not the empty line, in a workspace with no tasks yet', () => {
    const item = {
      workspacePath: WS,
      draft: { id: 'd0000000-0000-4000-8000-00000000000d', brief: 'Only a draft', doneWhen: [], createdAt: '2026-09-24T10:00:00Z', updatedAt: '2026-09-24T10:00:00Z' }
    }
    render(
      <Navigator
        {...props({ runsByWorkspacePath: { [WS]: { runs: [] } }, drafts: { items: [item], actions: { onOpen: vi.fn(), onDelete: vi.fn() } } })}
      />
    )
    expect(screen.queryByText('Tasks you start show up here, grouped by what they need from you.')).toBeNull()
    expect(screen.getByRole('button', { name: 'Only a draft' })).toBeTruthy()
  })

  it('shows no update chip while the install is current', () => {
    render(<Navigator {...props()} />)
    expect(document.querySelector('[data-update-chip]')).toBeNull()
  })
})
