/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    // Earlier is told by day: everything here finished today.
    expect(headings).toEqual(['Needs you1', 'Ready for review1', 'Today1'])
    // A review row's second line says what it changed; its column keeps to
    // one kind of number, how long ago it moved.
    const review = row('Task rv').querySelector('[data-nav-review]')
    expect(review?.textContent).toContain('+5')
    expect(review?.textContent).toContain('−1')
    expect(row('Task rv').textContent).not.toContain('2 files')
    const described = document.getElementById(row('Task rv').getAttribute('aria-describedby')!)
    expect(described?.textContent).toContain('5 lines added, 1 removed')
  })

  it('says a group’s state once, on its heading, and marks only the rows that ended otherwise', () => {
    render(
      <Navigator
        {...props({
          runsByWorkspacePath: {
            [WS]: {
              runs: [
                run('clean', { review: { files: 1, add: 1, del: 0 } }),
                run('broken', { status: 'error', review: { files: 1 } }),
                run('ok'),
                run('bad', { status: 'error' })
              ]
            }
          }
        })}
      />
    )
    const glyphOf = (el: Element | null): string | null =>
      el?.querySelector('[data-state]')?.getAttribute('data-state') ?? null
    const review = document.querySelector('[data-nav-section="review"]') as HTMLElement
    const earlier = document.querySelector('[data-nav-section="done"]') as HTMLElement
    expect(glyphOf(within(review).getByRole('heading'))).toBe('review')
    expect(glyphOf(within(earlier).getByRole('heading'))).toBeNull()
    expect(glyphOf(row('Task clean').querySelector('[data-row-glyph]'))).toBeNull()
    expect(glyphOf(row('Task broken').querySelector('[data-row-glyph]'))).toBe('failed')
    expect(glyphOf(row('Task ok').querySelector('[data-row-glyph]'))).toBeNull()
    expect(glyphOf(row('Task bad').querySelector('[data-row-glyph]'))).toBe('failed')
  })

  it('starts a new task from the labelled button in its head, once there is a workspace', () => {
    const p = props()
    render(<Navigator {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    expect(p.onNewTask).toHaveBeenCalledTimes(1)
    cleanup()
    render(<Navigator {...props({ openPaths: [], runsByWorkspacePath: {} })} />)
    expect((screen.getByRole('button', { name: 'New task' }) as HTMLButtonElement).disabled).toBe(true)
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

  it('offers Resume on a task you stopped that has edits to review, and counts one check as one', () => {
    // A task you stopped carries on through Retry's path, as the record's Resume does.
    const actions = { onSelect: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn() }
    render(
      <Navigator
        {...props({
          runsByWorkspacePath: {
            [WS]: { runs: [run('cut', { status: 'cancelled', review: { files: 2, add: 3, del: 1 }, checks: { met: 1, total: 1 } })] }
          },
          rowActions: actions
        })}
      />
    )
    // "Stopped · edits to review" was read as not stopped, and Resume went missing.
    fireEvent.contextMenu(row('Task cut'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resume' }))
    expect(actions.onRetry).toHaveBeenCalledWith(WS, 'cut')
    expect(document.body.textContent).toContain('1 of 1 check met')
    expect(document.body.textContent).not.toContain('1 of 1 checks')
  })

  it('retries a failed task and forks a settled one from its menu; a live one has neither', () => {
    const actions = { onSelect: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn(), onFork: vi.fn(), onExport: vi.fn() }
    render(
      <Navigator
        {...props({
          runsByWorkspacePath: {
            [WS]: {
              runs: [
                run('bad', { status: 'error', retryable: true }),
                run('broken', { status: 'error' }),
                run('ok'),
                run('live', { status: 'running' })
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

    const failed = menuFor('Task bad')
    expect(failed[0]).toBe('Retry')
    // Where the task header has it: after Export, before Copy link.
    expect(failed.indexOf('Fork')).toBe(failed.indexOf('Export as Markdown') + 1)
    fireEvent.contextMenu(row('Task bad'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Retry' }))
    expect(actions.onRetry).toHaveBeenCalledWith(WS, 'bad')

    // A failure Retry cannot get past gets none, as in its task view.
    expect(menuFor('Task broken')).not.toContain('Retry')

    const done = menuFor('Task ok')
    expect(done).not.toContain('Retry')
    fireEvent.contextMenu(row('Task ok'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fork' }))
    expect(actions.onFork).toHaveBeenCalledWith(WS, 'ok')

    // Main forks only a task that has stopped.
    const live = menuFor('Task live')
    expect(live).not.toContain('Fork')
    expect(live).not.toContain('Retry')
  })

  it('resumes a task you stopped with the Retry path’s continue, and an interrupted one with Resume', () => {
    const actions = { onSelect: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onResume: vi.fn(), onRetry: vi.fn() }
    render(
      <Navigator
        {...props({
          runsByWorkspacePath: {
            [WS]: {
              runs: [
                run('stopped', { status: 'cancelled' }),
                run('cut', { status: 'cancelled', resumable: true, error: RUN_INTERRUPTED_ERROR }),
                run('ok')
              ]
            }
          },
          rowActions: actions
        })}
      />
    )
    fireEvent.contextMenu(row('Task stopped'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resume' }))
    expect(actions.onRetry).toHaveBeenCalledWith(WS, 'stopped')
    expect(actions.onResume).not.toHaveBeenCalled()

    fireEvent.contextMenu(row('Task cut'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resume' }))
    expect(actions.onResume).toHaveBeenCalledWith(WS, 'cut')
    expect(actions.onRetry).toHaveBeenCalledTimes(1)

    // A finished task has nothing to carry on.
    fireEvent.contextMenu(row('Task ok'))
    expect(screen.queryByRole('menuitem', { name: 'Resume' })).toBeNull()
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

  it('keeps the places in one row of icons below the tasks, named by their labels', () => {
    const p = props({ place: 'usage' })
    render(<Navigator {...p} />)
    const zone = document.querySelector('[data-navigator-places]') as HTMLElement
    const buttons = within(zone).getAllByRole('button')
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Home',
      'Inbox',
      'Extensions',
      'Usage',
      expect.stringMatching(/^Settings/)
    ])
    // Icons only: no visible words, each one a glyph, all in one 40px row.
    expect(buttons.every((b) => b.textContent === '' && b.querySelector('svg') != null)).toBe(true)
    expect(within(zone).getByRole('group', { name: 'Places' }).className.split(' ')).toContain('h-10')
    const usage = within(zone).getByRole('button', { name: 'Usage' })
    expect(usage.getAttribute('aria-current')).toBe('page')
    fireEvent.click(usage)
    expect(p.onOpenUsage).toHaveBeenCalledTimes(1)
    fireEvent.click(within(zone).getByRole('button', { name: /^Settings/ }))
    expect(p.onOpenSettings).toHaveBeenCalledTimes(1)
    fireEvent.click(within(zone).getByRole('button', { name: 'Home' }))
    expect(p.onOpenHome).toHaveBeenCalledTimes(1)
    fireEvent.click(within(zone).getByRole('button', { name: 'Extensions' }))
    expect(p.onOpenExtensions).toHaveBeenCalledTimes(1)
  })

  it('lists every finished task it has, without a fold', () => {
    const runs = Array.from({ length: 7 }, (_, i) => run(`d${i}`))
    render(<Navigator {...props({ runsByWorkspacePath: { [WS]: { runs } } })} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(7)
    expect(screen.queryByRole('button', { name: /more/ })).toBeNull()
  })

  it('keeps the meta beside the ⋯, and draws its menu without icons', () => {
    render(<Navigator {...props()} />)
    // The meta stays in the row; hover only makes room for the ⋯ after it.
    expect(row('Task r1').textContent).toContain('now')
    expect(row('Task r1').className).toContain('group-hover:pr-7')
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Task r1' }))
    expect(screen.getByRole('menu').querySelector('svg')).toBeNull()
    // Menu open: one padding class, never a base and an override together.
    expect(row('Task r1').className.split(' ')).toContain('pr-7')
    expect(row('Task r1').className.split(' ')).not.toContain('pr-2')
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
    // Showing every workspace, there is no one workspace to close.
    expect(screen.queryByRole('menuitem', { name: /^Close/ })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Add workspace…' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'beta' }))
    expect(p.onScopeChange).toHaveBeenCalledWith(OTHER)
  })

  it('closes the workspace it is showing, by name', () => {
    const p = props({
      openPaths: [WS, OTHER],
      scopePath: OTHER,
      runsByWorkspacePath: { [WS]: { runs: [] }, [OTHER]: { runs: [] } }
    })
    render(<Navigator {...p} />)
    fireEvent.click(screen.getByRole('button', { name: /^beta/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close beta' }))
    expect(p.onCloseWorkspace).toHaveBeenCalledWith(OTHER)
  })

  it('names the one open workspace instead of "All workspaces"', () => {
    const p = props()
    render(<Navigator {...p} />)
    fireEvent.click(screen.getByRole('button', { name: /^alpha/ }))
    expect(screen.queryByRole('menuitemcheckbox', { name: 'All workspaces' })).toBeNull()
    expect(screen.getByRole('menuitemcheckbox', { name: 'alpha' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close alpha' }))
    expect(p.onCloseWorkspace).toHaveBeenCalledWith(WS)
  })

  it('lists every workspace as its own block, the one that needs you first', () => {
    render(
      <Navigator
        {...props({
          openPaths: [WS, OTHER],
          runsByWorkspacePath: { [WS]: { runs: [run('a1')] }, [OTHER]: { runs: [run('b1', { status: 'running' })] } },
          activeRuns: [
            {
              runId: 'b1',
              workspacePath: OTHER,
              invokeId: 1,
              pendingFollowUps: [],
              waiting: { kind: 'question', since: new Date().toISOString() }
            }
          ]
        })}
      />
    )
    const blocks = Array.from(document.querySelectorAll('[data-nav-workspace]')).map((el) => el.getAttribute('data-nav-workspace'))
    expect(blocks).toEqual(['beta', 'alpha'])
    const beta = screen.getByRole('region', { name: 'beta' })
    expect(within(beta).getByRole('button', { name: /^Task b1/ })).toBeTruthy()
    expect(within(beta).queryByRole('button', { name: /^Task a1/ })).toBeNull()
    // The heading names the workspace, so the row's meta doesn't.
    expect(row('Task b1').textContent).not.toContain('beta')
  })

  it('shows one workspace without a workspace heading', () => {
    render(<Navigator {...props()} />)
    expect(document.querySelector('[data-nav-workspace]')).toBeNull()
  })

  it('tells Earlier by day, newest first', () => {
    const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString()
    render(
      <Navigator
        {...props({
          runsByWorkspacePath: {
            [WS]: { runs: [run('t', { updatedAt: new Date().toISOString() }), run('w', { updatedAt: hoursAgo(24 * 4) }), run('o', { updatedAt: hoursAgo(24 * 30) })] }
          }
        })}
      />
    )
    const days = Array.from(document.querySelectorAll('[data-nav-date]')).map((el) => el.getAttribute('data-nav-date'))
    expect(days).toEqual(['today', 'week', 'older'])
    expect(document.querySelectorAll('[data-nav-section="done"]')).toHaveLength(1)
  })

  it('puts a row\'s glyph on the right, beside its number, and titles on the one left edge', () => {
    render(<Navigator {...props({ runsByWorkspacePath: { [WS]: { runs: [run('bad', { status: 'error' })] } } })} />)
    const button = row('Task bad')
    // The row's first line; a second line (activity, ask, changes) sits under it.
    const children = Array.from(button.firstElementChild!.children)
    const glyphAt = children.findIndex((el) => el.hasAttribute('data-row-glyph'))
    const titleAt = children.findIndex((el) => el.textContent === 'Task bad')
    expect(titleAt).toBe(0)
    expect(glyphAt).toBe(1)
  })

  it('says when a workspace’s tasks could not load, and lets you dismiss it', () => {
    const p = props({ runsByWorkspacePath: { [WS]: { runs: [], runsError: 'EACCES' } } })
    render(<Navigator {...p} />)
    expect(screen.getByRole('alert').textContent).toContain('alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(p.onDismissRunsError).toHaveBeenCalledWith(WS)
  })

  it('counts unread notifications on their row and opens one', () => {
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
    // Unread shows as a dot on the icon; the count is in its name.
    expect(document.querySelector('[data-unread-dot]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Inbox, 1 unread' }))
    fireEvent.click(screen.getByRole('button', { name: /^Task finished/ }))
    expect(p.notifications.onOpenItem).toHaveBeenCalledWith(item)
    // Its finish is unread, so the title is at full strength until it is seen —
    // brighter, never bolder.
    expect(row('Task r1').querySelector('.text-fg-strong')).toBeTruthy()
    expect(row('Task r1').querySelector('.font-semibold')).toBeNull()
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

  it('keeps the update entry when its download failed, and says so', async () => {
    updater.state = { info: { version: '1.1.0' }, status: 'error', progress: null, autoOpen: false, error: 'disk full' } as typeof updater.state
    render(<Navigator {...props()} />)
    const chip = screen.getByRole('button', { name: 'Updating to version 1.1.0 failed' })
    expect(chip.textContent).toBe('1.1.0 failed')
    expect(chip.classList.contains('text-danger')).toBe(true)
    expect(chip.classList.contains('text-accent')).toBe(false)
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
    fireEvent.click(screen.getByRole('button', { name: /^Inbox/ }))
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

  it('carries the update chip during Set up, so an "is ready" notice opens its panel', async () => {
    updater.state = { info: { version: '1.1.0' }, status: 'downloaded', progress: null, autoOpen: false }
    render(<FirstRunNavigator workspaceName={null} widthPx={264} />)
    act(() => requestUpdatePanel())
    expect(await screen.findByRole('dialog', { name: 'Version 1.1.0 is ready to install' })).toBeTruthy()
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
      { workspacePath: '/elsewhere', draft: draft('d0000000-0000-4000-8000-00000000000c', 'Not open here') }
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

describe('Navigator — View menu, workspace headings, archive, hover card, recents', () => {
  const two = (): Partial<NavigatorProps> => ({
    openPaths: [WS, OTHER],
    runsByWorkspacePath: { [WS]: { runs: [run('a1'), run('a2')] }, [OTHER]: { runs: [run('b1')] } }
  })

  it('filters from the View menu, says what it hides, and shows everything again', () => {
    render(<Navigator {...props({ runsByWorkspacePath: { [WS]: { runs: [run('d1'), run('f1', { status: 'error' })] } } })} />)
    const view = screen.getByRole('button', { name: 'View' })
    expect(document.querySelector('[data-filter-dot]')).toBeNull()
    fireEvent.click(view)
    // A checklist: toggling one keeps the menu open for the next.
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Done' }))
    expect(screen.getByRole('menuitemcheckbox', { name: 'Done' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByRole('button', { name: /^Task d1/ })).toBeNull()
    expect(row('Task f1')).toBeTruthy()
    expect(document.querySelector('[data-filter-dot]')).toBeTruthy()
    expect(document.querySelector('[data-nav-filter-notice]')?.textContent).toContain('1 hidden by the filter')
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Failed' }))
    expect(screen.getByText('No tasks match the filter.')).toBeTruthy()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(row('Task d1')).toBeTruthy()
    expect(document.querySelector('[data-nav-filter-notice]')).toBeNull()
  })

  it('offers Collapse all only while every workspace is listed', () => {
    const { unmount } = render(<Navigator {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    expect(screen.getByRole('menuitem', { name: 'Collapse all' }).hasAttribute('disabled')).toBe(true)
    unmount()
    render(<Navigator {...props(two())} />)
    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Collapse all' }))
    expect(document.querySelectorAll('[data-nav-workspace][data-collapsed]')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /^Task a1/ })).toBeNull()
  })

  it('folds a workspace from its heading, keeping its count, and starts a task there', () => {
    const p = props({ ...two(), onNewTaskIn: vi.fn() })
    render(<Navigator {...p} />)
    const alpha = screen.getByRole('button', { name: 'alpha' })
    expect(alpha.getAttribute('aria-expanded')).toBe('true')
    // At rest the chevron is hidden by its wrapper, never by a class Icon's own inline-block outranks.
    const chevron = alpha.querySelector('[data-heading-chevron]') as HTMLElement
    expect(chevron.classList.contains('hidden')).toBe(true)
    expect(chevron.querySelector('svg')?.classList.contains('hidden')).toBe(false)
    fireEvent.click(alpha)
    expect(alpha.getAttribute('aria-expanded')).toBe('false')
    expect(alpha.textContent).toBe('alpha2')
    expect(screen.queryByRole('button', { name: /^Task a1/ })).toBeNull()
    expect(row('Task b1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'New task in beta' }))
    expect(p.onNewTaskIn).toHaveBeenCalledWith(OTHER)
    fireEvent.click(alpha)
    expect(row('Task a1')).toBeTruthy()
  })

  it('keeps what needs you in sight on a folded workspace', () => {
    render(
      <Navigator
        {...props({
          openPaths: [WS, OTHER],
          runsByWorkspacePath: { [WS]: { runs: [run('w1', { status: 'running' })] }, [OTHER]: { runs: [run('b1')] } },
          activeRuns: [
            { runId: 'w1', workspacePath: WS, invokeId: 1, pendingFollowUps: [], waiting: { kind: 'approval', since: new Date().toISOString() } }
          ]
        })}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^alpha/ }))
    fireEvent.click(screen.getByRole('button', { name: /^beta/ }))
    expect(document.querySelector('[data-nav-workspace="alpha"] [data-heading-urgent]')?.getAttribute('data-heading-urgent')).toBe('needs')
    expect(document.querySelector('[data-nav-workspace="beta"] [data-heading-urgent]')).toBeNull()
  })

  it('archives a finished task from its menu, never a live one, and lists archived tasks on request', () => {
    const onToggleArchive = vi.fn()
    const p = props({
      runsByWorkspacePath: { [WS]: { runs: [run('old'), run('gone'), run('go', { status: 'running' })] } },
      activeRuns: [{ runId: 'go', workspacePath: WS, invokeId: 1, pendingFollowUps: [] }],
      rowActions: { onSelect: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onToggleArchive },
      archivedKeys: new Set([`${WS}\u0000gone`])
    })
    render(<Navigator {...p} />)
    expect(screen.queryByRole('button', { name: /^Task gone/ })).toBeNull()
    fireEvent.contextMenu(row('Task old'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    expect(onToggleArchive).toHaveBeenCalledWith(WS, 'old')
    // A live task's Archive is there, greyed out with why — never choosable.
    fireEvent.contextMenu(row('Task go'))
    const live = screen.getByRole('menuitem', { name: 'Archive' }) as HTMLButtonElement
    expect(live.disabled).toBe(true)
    expect(live.getAttribute('title')).toBe('Stop it or let it finish first')
    fireEvent.click(live)
    expect(onToggleArchive).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })

    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Show archived' }))
    const archived = document.querySelector('[data-nav-section="archived"]') as HTMLElement
    expect(within(archived).getByRole('heading').textContent).toBe('Archived1')
    fireEvent.contextMenu(within(archived).getByRole('button', { name: /^Task gone/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unarchive' }))
    expect(onToggleArchive).toHaveBeenCalledWith(WS, 'gone')
  })

  it('shows a task’s card when the pointer rests on it, and only the lines it has', () => {
    vi.useFakeTimers()
    try {
      render(
        <Navigator
          {...props({
            runsByWorkspacePath: {
              [WS]: { runs: [run('wt', { worktreePath: 'C:\\wt', worktreeBranch: 'task/fix-login', billedCost: 0.42 })] }
            }
          })}
        />
      )
      const target = row('Task wt')
      // Not a native tooltip as well.
      expect(target.hasAttribute('title')).toBe(false)
      fireEvent.pointerEnter(target, { pointerType: 'mouse' })
      expect(document.querySelector('[data-task-hover-card]')).toBeNull()
      act(() => {
        vi.advanceTimersByTime(600)
      })
      const card = document.querySelector('[data-task-hover-card]') as HTMLElement
      expect(card.getAttribute('aria-hidden')).toBe('true')
      expect(card.textContent).toContain('task/fix-login')
      expect(card.textContent).toContain('$0.42')
      expect(card.textContent).not.toContain('to review')
      fireEvent.pointerLeave(target, { pointerType: 'mouse' })
      expect(document.querySelector('[data-task-hover-card]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('draws a working task’s plan and checks on its card, and a reviewed task’s checks', () => {
    vi.useFakeTimers()
    try {
      render(
        <Navigator
          {...props({
            runsByWorkspacePath: {
              [WS]: {
                runs: [
                  run('live', { status: 'running', checks: { met: 1, total: 3 } }),
                  run('rv', { review: { files: 2, add: 5, del: 1 }, checks: { met: 2, total: 3 } })
                ]
              }
            },
            activeRuns: [{ runId: 'live', workspacePath: WS, invokeId: 1, pendingFollowUps: [], steps: { completed: 1, total: 4 } }]
          })}
        />
      )
      const cardFor = (name: string): HTMLElement => {
        fireEvent.pointerEnter(row(name), { pointerType: 'mouse' })
        act(() => {
          vi.advanceTimersByTime(600)
        })
        return document.querySelector('[data-task-hover-card]') as HTMLElement
      }

      const live = cardFor('Task live')
      const segments = [...live.querySelectorAll('[data-plan-step]')].map((s) => s.getAttribute('data-plan-step'))
      expect(segments).toEqual(['done', 'running', 'queued', 'queued'])
      expect(live.querySelector('[data-hover-plan]')?.textContent).toBe('2/4')
      const working = live.querySelector('[data-hover-checks]') as HTMLElement
      expect(working.textContent).toBe('1 of 3 checks met')
      // Unmet while it works is the plan, not news: no warning colour yet.
      expect(working.className).toContain('text-muted')
      expect(working.className).not.toContain('text-warning')
      fireEvent.pointerLeave(row('Task live'), { pointerType: 'mouse' })

      const review = cardFor('Task rv')
      expect(review.querySelector('[data-hover-plan]')).toBeNull()
      const checks = review.querySelector('[data-hover-checks]') as HTMLElement
      expect(checks.textContent).toBe('2 of 3 checks met')
      // One still open: the count is not the only sign, the words say it too.
      expect(checks.className).toContain('text-warning')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reopens a recent workspace from the workspace menu', () => {
    const p = props({ recentPaths: ['C:\\work\\gamma'], onOpenRecentWorkspace: vi.fn() })
    render(<Navigator {...p} />)
    fireEvent.click(screen.getByRole('button', { name: /^alpha/ }))
    expect(screen.getByText('Recent')).toBeTruthy()
    // Where it lives, so two folders of one name can be told apart: seen, and heard as its description.
    const recent = screen.getByRole('menuitem', { name: 'gamma' })
    expect(recent.querySelector('[data-menu-item-detail]')?.textContent).toBe('C:\\work\\gamma')
    expect(document.getElementById(recent.getAttribute('aria-describedby')!)?.textContent).toBe('C:\\work\\gamma')
    fireEvent.click(recent)
    expect(p.onOpenRecentWorkspace).toHaveBeenCalledWith('C:\\work\\gamma')
  })
})

describe('Navigator row lines', () => {
  const live = (runId: string, over: Partial<NavigatorProps['activeRuns'][number]> = {}): NavigatorProps['activeRuns'][number] => ({
    runId,
    workspacePath: WS,
    invokeId: 1,
    pendingFollowUps: [],
    ...over
  })
  const setBridge = (bridge: unknown): void => {
    ;(window as unknown as { vyotiq?: unknown }).vyotiq = bridge
  }
  afterEach(() => setBridge(undefined))

  it('says what a running task is doing, under its title', () => {
    render(
      <Navigator
        {...props({
          runsByWorkspacePath: { [WS]: { runs: [run('go', { status: 'running' })] } },
          activeRuns: [live('go', { activity: 'Editing src/app.ts' })]
        })}
      />
    )
    expect(row('Task go').querySelector('[data-nav-activity]')?.textContent).toBe('Editing src/app.ts')
  })

  it('shows a waiting task’s command and answers it from the row', async () => {
    const request = {
      requestId: 'req-1',
      runId: 'waiting',
      toolCallId: 'call-1',
      name: 'terminal',
      summary: 'pnpm test',
      argsPreview: JSON.stringify({ command: 'pnpm   test' }),
      mutating: true
    }
    setBridge({ listPendingToolApprovals: vi.fn(async () => ({ ok: true, data: [request] })) })
    const onRespondApproval = vi.fn(async () => {})
    const p = props({
      runsByWorkspacePath: { [WS]: { runs: [run('waiting', { status: 'running' })] } },
      activeRuns: [live('waiting', { waiting: { kind: 'approval', since: new Date().toISOString() } })]
    })
    render(<Navigator {...p} rowActions={{ ...p.rowActions, onRespondApproval }} />)
    await waitFor(() => expect(row('Task waiting').querySelector('[data-nav-ask]')?.textContent).toBe('$pnpm test'))
    const decision = screen.getByRole('group', { name: 'Answer Task waiting' })
    fireEvent.click(within(decision).getByRole('button', { name: 'Allow once' }))
    expect(onRespondApproval).toHaveBeenCalledWith(WS, 'waiting', 'req-1', 'once')
    // One decision per ask: both buttons wait on the one in flight.
    expect(within(decision).getByRole('button', { name: 'Sending…' })).toHaveProperty('disabled', true)
    expect(within(decision).getByRole('button', { name: 'Deny' })).toHaveProperty('disabled', true)
  })

  it('gives the next ask its buttons once one is answered, even two made in the same millisecond', async () => {
    const ask = (requestId: string, command: string) => ({
      requestId,
      runId: 'waiting',
      toolCallId: `call-${requestId}`,
      name: 'terminal',
      summary: command,
      argsPreview: JSON.stringify({ command }),
      mutating: true
    })
    let pending = [ask('req-1', 'pnpm lint'), ask('req-2', 'pnpm test')]
    setBridge({ listPendingToolApprovals: vi.fn(async () => ({ ok: true, data: pending })) })
    const onRespondApproval = vi.fn(async (_ws: string, _run: string, requestId: string) => {
      pending = pending.filter((r) => r.requestId !== requestId)
    })
    // One `since` throughout: main's oldest ask moved to one stamped the same.
    const p = props({
      runsByWorkspacePath: { [WS]: { runs: [run('waiting', { status: 'running' })] } },
      activeRuns: [live('waiting', { waiting: { kind: 'approval', since: '2026-09-30T10:00:00.000Z' } })]
    })
    render(<Navigator {...p} rowActions={{ ...p.rowActions, onRespondApproval }} />)
    await waitFor(() => expect(row('Task waiting').querySelector('[data-nav-ask]')?.textContent).toBe('$pnpm lint'))
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(row('Task waiting').querySelector('[data-nav-ask]')?.textContent).toBe('$pnpm test'))
    const allow = screen.getByRole('button', { name: 'Allow once' })
    expect(allow).toHaveProperty('disabled', false)
    fireEvent.click(allow)
    expect(onRespondApproval).toHaveBeenLastCalledWith(WS, 'waiting', 'req-2', 'once')
  })

  it('says why a decision did not go, and lets you try again', async () => {
    const request = {
      requestId: 'req-2',
      runId: 'waiting',
      toolCallId: 'call-2',
      name: 'write',
      summary: 'src/a.ts',
      argsPreview: '{}',
      mutating: true
    }
    setBridge({ listPendingToolApprovals: vi.fn(async () => ({ ok: true, data: [request] })) })
    const onRespondApproval = vi.fn(async () => {
      throw new Error('The task has stopped.')
    })
    const p = props({
      runsByWorkspacePath: { [WS]: { runs: [run('waiting', { status: 'running' })] } },
      activeRuns: [live('waiting', { waiting: { kind: 'approval', since: new Date().toISOString() } })]
    })
    render(<Navigator {...p} rowActions={{ ...p.rowActions, onRespondApproval }} />)
    const deny = await screen.findByRole('button', { name: 'Deny' })
    fireEvent.click(deny)
    expect(onRespondApproval).toHaveBeenCalledWith(WS, 'waiting', 'req-2', 'deny')
    expect((await screen.findByRole('alert')).textContent).toBe('The task has stopped.')
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveProperty('disabled', false)
  })

  it('offers no decision for a question, which is answered in the task', async () => {
    setBridge({
      listPendingAgentQuestions: vi.fn(async () => ({
        ok: true,
        data: [{ requestId: 'q-1', runId: 'asking', questions: [{ question: 'Which port?', options: [] }] }]
      }))
    })
    const p = props({
      runsByWorkspacePath: { [WS]: { runs: [run('asking', { status: 'running' })] } },
      activeRuns: [live('asking', { waiting: { kind: 'question', since: new Date().toISOString() } })]
    })
    render(<Navigator {...p} rowActions={{ ...p.rowActions, onRespondApproval: vi.fn(async () => {}) }} />)
    await waitFor(() => expect(row('Task asking').querySelector('[data-nav-ask]')).not.toBeNull())
    expect(screen.queryByRole('group', { name: /^Answer/ })).toBeNull()
  })

  it('lists a live task’s instances under it, going first, and opens one in place', () => {
    const p = props({
      runsByWorkspacePath: {
        [WS]: {
          runs: [run('parent', { status: 'running' })],
          instanceRuns: [
            run('a-done', { parentRunId: 'parent', goal: 'Read the docs' }),
            run('b-live', { parentRunId: 'parent', status: 'running', goal: 'Write the tests' })
          ]
        }
      },
      activeRuns: [live('parent'), live('b-live', { activity: 'Running pnpm test' })]
    })
    render(<Navigator {...p} />)
    const fold = screen.getByRole('button', { name: /^2 instances/ })
    expect(fold.textContent).toBe('2 instances · 1 going')
    const list = document.querySelector('[data-nav-instances] ul')!
    const titles = Array.from(list.querySelectorAll('button')).map((b) => b.getAttribute('title'))
    expect(titles).toEqual(['Write the tests', 'Read the docs'])
    expect(within(list as HTMLElement).getByText('Running pnpm test')).toBeTruthy()
    // Each says its state in words too, not in its glyph alone.
    expect(within(list as HTMLElement).getAllByRole('img').map((g) => g.getAttribute('aria-label'))).toEqual(['Running', 'Done'])
    fireEvent.click(within(list as HTMLElement).getByTitle('Write the tests'))
    expect(p.rowActions.onSelect).toHaveBeenCalledWith(WS, 'b-live')
    fireEvent.click(fold)
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[data-nav-instances] ul')).toBeNull()
  })

  it('marks the instance open in place of its task’s record, and keeps the task selected', () => {
    const p = props({
      runsByWorkspacePath: {
        [WS]: {
          runs: [run('parent', { status: 'running' })],
          instanceRuns: [
            run('a-live', { parentRunId: 'parent', status: 'running', goal: 'Read the docs' }),
            run('b-live', { parentRunId: 'parent', status: 'running', goal: 'Write the tests' })
          ]
        }
      },
      activeRuns: [live('parent'), live('a-live'), live('b-live')],
      selected: { workspacePath: WS, runId: 'parent', instanceRunId: 'b-live' }
    })
    render(<Navigator {...p} />)
    expect(row('Task parent').getAttribute('aria-current')).toBe('page')
    const list = document.querySelector('[data-nav-instances] ul') as HTMLElement
    const open = within(list).getByTitle('Write the tests')
    expect(open.getAttribute('aria-current')).toBe('true')
    expect(within(list).getByTitle('Read the docs').getAttribute('aria-current')).toBeNull()
  })

  it('drops a task’s instances once it has settled', () => {
    render(
      <Navigator
        {...props({
          runsByWorkspacePath: {
            [WS]: { runs: [run('parent')], instanceRuns: [run('kid', { parentRunId: 'parent' })] }
          }
        })}
      />
    )
    expect(document.querySelector('[data-nav-instances]')).toBeNull()
  })

  it('says how a review task’s checks stand, and marks the unmet ones', () => {
    render(
      <Navigator
        {...props({
          runsByWorkspacePath: {
            [WS]: {
              runs: [
                run('some', { review: { files: 1, add: 2, del: 0 }, checks: { met: 1, total: 3 } }),
                run('all', { review: { files: 3 }, checks: { met: 2, total: 2 } })
              ]
            }
          }
        })}
      />
    )
    const some = row('Task some').querySelector('[data-nav-review]')!
    expect(some.textContent).toBe('+2· 1/3 checks')
    expect(some.querySelector('.text-warning')).not.toBeNull()
    const all = row('Task all').querySelector('[data-nav-review]')!
    expect(all.textContent).toBe('3 files· 2/2 checks')
    expect(all.querySelector('.text-warning')).toBeNull()
  })
})
