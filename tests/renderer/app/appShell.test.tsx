/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { AppShell } from '@renderer/app/AppShell'
import { getToasts, resetToastStoreForTests } from '@renderer/lib/ui/toastStore'
import type { NotificationItem, NotificationList } from '@shared/ipc'

const baseProps = {
  view: 'chat' as const,
  workspacePath: '/ws/demo',
  openWorkspaces: ['/ws/demo'],
  activeRuns: [] as NonNullable<ComponentProps<typeof AppShell>['activeRuns']>,
  runsByWorkspacePath: {
    '/ws/demo': {
      runs: [
        {
          runId: 'run-abc',
          goal: 'Fix tests',
          status: 'done' as const,
          updatedAt: new Date().toISOString()
        }
      ],
      runsCapped: false,
      runsError: null,
      activeRunId: null
    }
  },
  onOpenSettings: vi.fn(),
  onOpenMarketplace: vi.fn(),
  onOpenHome: vi.fn(),
  onOpenUsage: vi.fn(),
  onOpenChat: vi.fn(),
  onNewChat: vi.fn(),
  onNewChatInWorkspace: vi.fn(),
  onSelectRunInWorkspace: vi.fn(),
  onRenameRunInWorkspace: vi.fn(),
  onDeleteRunInWorkspace: vi.fn(),
  onSwitchWorkspace: vi.fn(),
  onCloseWorkspace: vi.fn(),
  onAddWorkspace: vi.fn()
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: query.includes('1024px'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    })
  })
  const store = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, String(value))
      },
      removeItem: (key: string) => {
        store.delete(key)
      },
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size
      }
    }
  })
  // @ts-expect-error test bridge
  window.vyotiq = {
    platform: 'win32',
    windowIsMaximized: vi.fn(async () => ({ ok: true as const, data: false }))
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('AppShell', () => {
  it('opens and closes the mobile drawer with escape', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: () => ({
        matches: false,
        media: '',
        addEventListener: () => {},
        removeEventListener: () => {}
      })
    })

    render(
      <AppShell {...baseProps}>
        <p>Main content</p>
      </AppShell>
    )

    fireEvent.click(screen.getByRole('button', { name: /show navigator/i }))
    expect(screen.getByRole('dialog', { name: /^navigator$/i })).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: /^navigator$/i })).toBeNull()
  })

  it('keeps a rail of live tasks and the places below the desktop breakpoint', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: () => ({ matches: false, media: '', addEventListener: () => {}, removeEventListener: () => {} })
    })
    const onSelectRunInWorkspace = vi.fn()
    const onOpenHome = vi.fn()
    render(
      <AppShell
        {...baseProps}
        onSelectRunInWorkspace={onSelectRunInWorkspace}
        onOpenHome={onOpenHome}
        runsByWorkspacePath={{
          '/ws/demo': {
            ...baseProps.runsByWorkspacePath['/ws/demo'],
            runs: [
              ...baseProps.runsByWorkspacePath['/ws/demo'].runs,
              { runId: 'run-live', goal: 'Ship it', status: 'running' as const, updatedAt: new Date().toISOString() }
            ]
          }
        }}
        activeRuns={[{ runId: 'run-live', workspacePath: '/ws/demo', invokeId: 1, pendingFollowUps: [], activity: 'Editing a.ts' }]}
        activeRunsLoaded
      >
        <p>Main content</p>
      </AppShell>
    )
    const rail = document.querySelector('[data-navigator-rail]') as HTMLElement
    expect(rail).not.toBeNull()
    // Only the task still in play: the finished one is the drawer's.
    const task = within(rail).getByRole('button', { name: 'Ship it, Editing a.ts' })
    expect(within(rail).queryByRole('button', { name: /^Fix tests/ })).toBeNull()
    fireEvent.click(task)
    expect(onSelectRunInWorkspace).toHaveBeenCalledWith('/ws/demo', 'run-live')
    fireEvent.click(within(rail).getByRole('button', { name: 'Home' }))
    expect(onOpenHome).toHaveBeenCalled()
    expect(within(rail).getByRole('button', { name: /^New task/ })).toBeTruthy()
    // The full list is still the drawer.
    fireEvent.click(screen.getByRole('button', { name: /show navigator/i }))
    expect(screen.getByRole('dialog', { name: /^navigator$/i })).toBeTruthy()
  })

  it('hides from the rail what the list hides, and finds the open task whatever case its path is in', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: () => ({ matches: false, media: '', addEventListener: () => {}, removeEventListener: () => {} })
    })
    const WS = 'C:\\work\\demo'
    const at = new Date().toISOString()
    render(
      <AppShell
        {...baseProps}
        workspacePath={WS}
        openWorkspaces={[WS]}
        runsByWorkspacePath={{
          [WS]: {
            runs: [
              { runId: 'run-kept', goal: 'Kept review', status: 'done' as const, updatedAt: at, review: { files: 1, add: 1, del: 0 } },
              { runId: 'run-gone', goal: 'Archived review', status: 'done' as const, updatedAt: at, review: { files: 1, add: 2, del: 0 } }
            ],
            runsCapped: false,
            runsError: null,
            activeRunId: null
          }
        }}
        archivedRunKeys={[`${WS}\u0000run-gone`]}
        // The focused run's path with its drive letter as another part of the app writes it.
        focusedRun={{ workspacePath: 'c:\\work\\demo', runId: 'run-kept' }}
        activeRunsLoaded
      >
        <p>Main content</p>
      </AppShell>
    )
    const rail = document.querySelector('[data-navigator-rail]') as HTMLElement
    const kept = within(rail).getByRole('button', { name: /^Kept review/ })
    expect(within(rail).queryByRole('button', { name: /^Archived review/ })).toBeNull()
    expect(kept.getAttribute('aria-current')).toBe('page')
  })

  it('tells same-state tasks apart in the rail and keeps the open task there when it is done', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: () => ({ matches: false, media: '', addEventListener: () => {}, removeEventListener: () => {} })
    })
    const WS = '/ws/demo'
    const at = new Date().toISOString()
    render(
      <AppShell
        {...baseProps}
        workspacePath={WS}
        openWorkspaces={[WS]}
        runsByWorkspacePath={{
          [WS]: {
            runs: [
              { runId: 'run-a', goal: 'Update the docs', status: 'done' as const, updatedAt: at, review: { files: 1, add: 1, del: 0 } },
              { runId: 'run-b', goal: 'Bump deps', status: 'done' as const, updatedAt: at, review: { files: 1, add: 2, del: 0 } },
              { runId: 'run-open', goal: 'Hey What can we do?', status: 'done' as const, updatedAt: at }
            ],
            runsCapped: false,
            runsError: null,
            activeRunId: null
          }
        }}
        focusedRun={{ workspacePath: WS, runId: 'run-open' }}
        activeRunsLoaded
      >
        <p>Main content</p>
      </AppShell>
    )
    const rail = document.querySelector('[data-navigator-rail]') as HTMLElement
    const initials = (name: RegExp): string | null =>
      within(rail).getByRole('button', { name }).querySelector('[data-rail-initials]')?.textContent ?? null
    expect(initials(/^Update the docs/)).toBe('UD')
    expect(initials(/^Bump deps/)).toBe('BD')
    // Done tasks are the drawer's, except the one you are on.
    const open = rail.querySelector('[data-rail-section="open"]') as HTMLElement
    const current = within(open).getByRole('button', { name: /^Hey What can we do\?/ })
    expect(current.getAttribute('aria-current')).toBe('page')
    expect(current.classList.contains('bg-surface-2')).toBe(true)
    expect(current.classList.contains('hover:bg-surface')).toBe(false)
  })

  it('keeps no rail beside the full navigator', () => {
    render(
      <AppShell {...baseProps}>
        <p>Main content</p>
      </AppShell>
    )
    expect(document.querySelector('[data-navigator-rail]')).toBeNull()
  })

  it('selects a chat from the sidebar', () => {
    const onSelectRunInWorkspace = vi.fn()
    const onOpenChat = vi.fn()
    render(
      <AppShell
        {...baseProps}
        onSelectRunInWorkspace={onSelectRunInWorkspace}
        onOpenChat={onOpenChat}
      >
        <p>Main content</p>
      </AppShell>
    )

    fireEvent.click(screen.getAllByRole('button', { name: /fix tests/i })[0])
    expect(onSelectRunInWorkspace).toHaveBeenCalledWith('/ws/demo', 'run-abc')
    expect(onOpenChat).toHaveBeenCalled()
  })

  it('frames the window: the band, the navigator and the main pane', () => {
    render(
      <AppShell {...baseProps}>
        <p>Main content</p>
      </AppShell>
    )
    const nav = screen.getByRole('navigation', { name: 'Tasks' })
    expect(within(nav).getByRole('button', { name: /new task/i })).toBeTruthy()
    expect(within(nav).getByRole('button', { name: /^home$/i })).toBeTruthy()
    expect(within(nav).getByRole('button', { name: /^extensions$/i })).toBeTruthy()
    expect(within(nav).getByRole('button', { name: /^settings/i })).toBeTruthy()
    expect(within(nav).getByRole('button', { name: /^inbox/i })).toBeTruthy()
    expect(within(nav).getByRole('button', { name: /^usage$/i })).toBeTruthy()
    expect(within(nav).getByRole('button', { name: /^fix tests/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /hide navigator/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /search tasks, files and commands/i })).toBeTruthy()
    expect(screen.getByRole('main').textContent).toContain('Main content')
  })

  it('shows a sidebar resize handle on desktop when expanded', () => {
    render(
      <AppShell {...baseProps}>
        <p>Main content</p>
      </AppShell>
    )
    expect(screen.getByRole('separator', { name: /Resize navigator/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /hide navigator/i }))
    expect(screen.queryByRole('separator', { name: /Resize navigator/i })).toBeNull()
  })

  it('hides the navigator entirely and remembers it', () => {
    render(
      <AppShell {...baseProps}>
        <p>Main content</p>
      </AppShell>
    )

    fireEvent.click(screen.getByRole('button', { name: /hide navigator/i }))
    expect(screen.queryByRole('navigation', { name: 'Tasks' })).toBeNull()
    expect(localStorage.getItem('vyotiq.sidebarCollapsed')).toBe('1')

    fireEvent.click(screen.getByRole('button', { name: /show navigator/i }))
    expect(screen.getByRole('navigation', { name: 'Tasks' })).toBeTruthy()
  })

  it('offers no new task until a workspace is open', () => {
    render(
      <AppShell {...baseProps} workspacePath={null} openWorkspaces={[]} runsByWorkspacePath={{}}>
        <p>Main content</p>
      </AppShell>
    )

    expect((screen.getByRole('button', { name: /new task/i }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /^settings/i }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByText('Tasks you start show up here, grouped by what they need from you.')).toBeTruthy()
  })

  it('toggles the desktop sidebar with Ctrl/Cmd+B', () => {
    render(
      <AppShell {...baseProps}>
        <p>Main content</p>
      </AppShell>
    )

    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(screen.queryByRole('navigation', { name: 'Tasks' })).toBeNull()
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(screen.getByRole('navigation', { name: 'Tasks' })).toBeTruthy()
  })

  it('opens search and commands with Ctrl/Cmd+K, even from the instruction line', async () => {
    render(
      <AppShell {...baseProps}>
        <div role="textbox" aria-label="Message" data-composer-input contentEditable tabIndex={0} />
      </AppShell>
    )
    const composer = screen.getByRole('textbox', { name: /^message$/i })
    composer.focus()
    fireEvent.keyDown(composer, { key: 'k', ctrlKey: true })
    const search = await screen.findByRole('textbox', { name: /search tasks, files and commands/i })
    await waitFor(() => expect(document.activeElement).toBe(search))
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: /search and commands/i })).toBeNull()
  })

  it('offers the open task’s changed files in search before anything is typed', async () => {
    const taskFileStats = vi.fn(async () => ({
      ok: true as const,
      data: {
        files: [
          { path: 'src/kept.ts', action: 'modified' as const, add: 2, del: 1 },
          { path: 'src/gone.ts', action: 'deleted' as const }
        ]
      }
    }))
    Object.assign(window.vyotiq, { taskFileStats })
    const onOpenWorkspaceFile = vi.fn()
    render(
      <AppShell {...baseProps} focusedRun={{ workspacePath: '/ws/demo', runId: 'run-abc' }} onOpenWorkspaceFile={onOpenWorkspaceFile}>
        <p>Task</p>
      </AppShell>
    )
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })
    const files = await screen.findByRole('group', { name: 'Files' })
    expect(taskFileStats).toHaveBeenCalledWith({ workspacePath: '/ws/demo', runId: 'run-abc' })
    // A deleted file has nothing to open.
    expect(within(files).getAllByRole('option').map((o) => o.textContent)).toEqual(['src/kept.ts'])
    fireEvent.click(within(files).getByRole('option', { name: 'src/kept.ts' }))
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith('/ws/demo', 'src/kept.ts')
  })

  it('retries and forks a task from its row menu', () => {
    const onRetryRunInWorkspace = vi.fn()
    const onForkRunInWorkspace = vi.fn()
    render(
      <AppShell
        {...baseProps}
        runsByWorkspacePath={{
          '/ws/demo': {
            ...baseProps.runsByWorkspacePath['/ws/demo'],
            runs: [{ ...baseProps.runsByWorkspacePath['/ws/demo'].runs[0]!, status: 'error' as const, retryable: true as const }]
          }
        }}
        onRetryRunInWorkspace={onRetryRunInWorkspace}
        onForkRunInWorkspace={onForkRunInWorkspace}
      >
        <p>Task</p>
      </AppShell>
    )
    fireEvent.contextMenu(screen.getByRole('button', { name: /^fix tests/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Retry' }))
    expect(onRetryRunInWorkspace).toHaveBeenCalledWith('/ws/demo', 'run-abc')
    fireEvent.contextMenu(screen.getByRole('button', { name: /^fix tests/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fork' }))
    expect(onForkRunInWorkspace).toHaveBeenCalledWith('/ws/demo', 'run-abc')
  })

  it('opens the task that waits on you with Ctrl/Cmd+J', () => {
    const onSelectRunInWorkspace = vi.fn()
    render(
      <AppShell
        {...baseProps}
        activeRuns={[
          {
            runId: 'run-abc',
            workspacePath: '/ws/demo',
            invokeId: 1,
            pendingFollowUps: [],
            waiting: { kind: 'approval', since: new Date().toISOString() }
          }
        ]}
        activeRunsLoaded
        onSelectRunInWorkspace={onSelectRunInWorkspace}
      >
        <p>Main content</p>
      </AppShell>
    )
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true })
    expect(onSelectRunInWorkspace).toHaveBeenCalledWith('/ws/demo', 'run-abc')
  })

  it('creates a new chat with Ctrl/Cmd+N', () => {
    const onNewChat = vi.fn()
    render(
      <AppShell {...baseProps} onNewChat={onNewChat}>
        <p>Main content</p>
      </AppShell>
    )
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    expect(onNewChat).toHaveBeenCalledTimes(1)
  })

  it('opens settings with Ctrl/Cmd+,', () => {
    const onOpenSettings = vi.fn()
    render(
      <AppShell {...baseProps} onOpenSettings={onOpenSettings}>
        <p>Main content</p>
      </AppShell>
    )
    fireEvent.keyDown(window, { key: ',', ctrlKey: true })
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('focuses the composer with Ctrl/Cmd+L when chat view is active', () => {
    render(
      <AppShell {...baseProps}>
        <div
          role="textbox"
          aria-label="Message"
          data-composer-input
          contentEditable
          tabIndex={0}
        />
      </AppShell>
    )
    const composer = screen.getByRole('textbox', { name: /^message$/i })
    fireEvent.keyDown(window, { key: 'l', ctrlKey: true })
    expect(document.activeElement).toBe(composer)
  })

  it('focuses the browser URL with Ctrl/Cmd+L when that dock is visible', () => {
    render(
      <AppShell {...baseProps}>
        <div>
          <div role="textbox" aria-label="Message" data-composer-input contentEditable tabIndex={0} />
          <input data-browser-url placeholder="Search or enter URL" />
        </div>
      </AppShell>
    )
    fireEvent.keyDown(window, { key: 'l', ctrlKey: true })
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Search or enter URL'))
  })

  it('focuses the composer with Ctrl/Cmd+L when the browser dock is inert', () => {
    render(
      <AppShell {...baseProps}>
        <div>
          <div role="textbox" aria-label="Message" data-composer-input contentEditable tabIndex={0} />
          <div inert>
            <input data-browser-url placeholder="Search or enter URL" />
          </div>
        </div>
      </AppShell>
    )
    const composer = screen.getByRole('textbox', { name: /^message$/i })
    fireEvent.keyDown(window, { key: 'l', ctrlKey: true })
    expect(document.activeElement).toBe(composer)
  })

  it('does not focus composer with Ctrl/Cmd+L outside chat view', () => {
    render(
      <AppShell {...baseProps} view="settings">
        <div
          role="textbox"
          aria-label="Message"
          data-composer-input
          contentEditable
          tabIndex={0}
        />
      </AppShell>
    )
    const composer = screen.getByRole('textbox', { name: /^message$/i })
    composer.blur()
    fireEvent.keyDown(window, { key: 'l', ctrlKey: true })
    expect(document.activeElement).not.toBe(composer)
  })

  it('stops a running chat with Escape', () => {
    const onChatStop = vi.fn()
    render(
      <AppShell {...baseProps} running onChatStop={onChatStop}>
        <p>Main content</p>
      </AppShell>
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onChatStop).toHaveBeenCalledTimes(1)
  })

  it('does not stop on Escape outside chat view', () => {
    const onChatStop = vi.fn()
    render(
      <AppShell {...baseProps} view="settings" running onChatStop={onChatStop}>
        <p>Main content</p>
      </AppShell>
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onChatStop).not.toHaveBeenCalled()
  })

  it('does not stop on Escape when not running', () => {
    const onChatStop = vi.fn()
    render(
      <AppShell {...baseProps} running={false} onChatStop={onChatStop}>
        <p>Main content</p>
      </AppShell>
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onChatStop).not.toHaveBeenCalled()
  })

  it('does not stop on Escape when an aria-expanded menu is open', () => {
    const onChatStop = vi.fn()
    render(
      <AppShell {...baseProps} running onChatStop={onChatStop}>
        <button type="button" aria-expanded="true" aria-haspopup="menu">
          Menu
        </button>
      </AppShell>
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onChatStop).not.toHaveBeenCalled()
  })

  it('does not stop on Escape when a focus-opened tooltip is visible', () => {
    const onChatStop = vi.fn()
    render(
      <AppShell {...baseProps} running onChatStop={onChatStop}>
        <div role="tooltip" data-opened-by="focus">
          Settings (Ctrl+,)
        </div>
      </AppShell>
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onChatStop).not.toHaveBeenCalled()
  })

  it('stops on Escape when only a hover tooltip is visible', () => {
    const onChatStop = vi.fn()
    render(
      <AppShell {...baseProps} running onChatStop={onChatStop}>
        <div role="tooltip" data-opened-by="hover">
          Settings
        </div>
      </AppShell>
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onChatStop).toHaveBeenCalledTimes(1)
  })

  it('does not stop on Escape when Mentions menu is open', () => {
    const onChatStop = vi.fn()
    render(
      <AppShell {...baseProps} running onChatStop={onChatStop}>
        <div role="listbox" aria-label="Mentions" />
      </AppShell>
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onChatStop).not.toHaveBeenCalled()
  })

  it('does not stop on Escape when drawer is open while running', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: () => ({
        matches: false,
        media: '',
        addEventListener: () => {},
        removeEventListener: () => {}
      })
    })
    const onChatStop = vi.fn()
    render(
      <AppShell {...baseProps} running onChatStop={onChatStop}>
        <p>Main content</p>
      </AppShell>
    )
    fireEvent.click(screen.getByRole('button', { name: /show navigator/i }))
    expect(screen.getByRole('dialog', { name: /^navigator$/i })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onChatStop).not.toHaveBeenCalled()
  })

  it('does not stop on Escape while search and commands is open', () => {
    const onChatStop = vi.fn()
    render(
      <AppShell {...baseProps} running onChatStop={onChatStop}>
        <p>Main content</p>
      </AppShell>
    )
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onChatStop).not.toHaveBeenCalled()
  })

  it('does not fire new-chat chord while typing in an input', () => {
    const onNewChat = vi.fn()
    render(
      <AppShell {...baseProps} onNewChat={onNewChat}>
        <input aria-label="Draft" />
      </AppShell>
    )
    const input = screen.getByRole('textbox', { name: /draft/i })
    input.focus()
    fireEvent.keyDown(input, { key: 'n', ctrlKey: true })
    expect(onNewChat).not.toHaveBeenCalled()
  })

  it('fires new-chat and settings chords from the main composer', () => {
    const onNewChat = vi.fn()
    const onOpenSettings = vi.fn()
    render(
      <AppShell {...baseProps} onNewChat={onNewChat} onOpenSettings={onOpenSettings}>
        <div role="textbox" aria-label="Message" data-composer-input contentEditable tabIndex={0} />
      </AppShell>
    )
    const composer = screen.getByRole('textbox', { name: /^message$/i })
    composer.focus()
    fireEvent.keyDown(composer, { key: 'n', ctrlKey: true })
    fireEvent.keyDown(composer, { key: ',', ctrlKey: true })
    expect(onNewChat).toHaveBeenCalledTimes(1)
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('closes the current chat tab with Ctrl+W from the composer', () => {
    const onCloseChat = vi.fn()
    render(
      <AppShell {...baseProps} onCloseChat={onCloseChat}>
        <div role="textbox" aria-label="Message" data-composer-input contentEditable tabIndex={0} />
      </AppShell>
    )
    fireEvent.keyDown(window, { key: 'w', ctrlKey: true })
    expect(onCloseChat).toHaveBeenCalledTimes(1)

    const composer = screen.getByRole('textbox', { name: /^message$/i })
    composer.focus()
    fireEvent.keyDown(composer, { key: 'w', ctrlKey: true })
    expect(onCloseChat).toHaveBeenCalledTimes(2)
  })

  it('does not close the chat tab from a non-composer input', () => {
    const onCloseChat = vi.fn()
    render(
      <AppShell {...baseProps} onCloseChat={onCloseChat}>
        <input aria-label="Draft" />
      </AppShell>
    )
    const input = screen.getByRole('textbox', { name: /draft/i })
    input.focus()
    fireEvent.keyDown(input, { key: 'w', ctrlKey: true })
    expect(onCloseChat).not.toHaveBeenCalled()
  })

  it('keeps the task list visible when runsError is set', () => {
    render(
      <AppShell
        {...baseProps}
        runsByWorkspacePath={{
          '/ws/demo': {
            ...baseProps.runsByWorkspacePath['/ws/demo'],
            runsError: 'Failed to load chats'
          }
        }}
      >
        <p>Main content</p>
      </AppShell>
    )

    expect(screen.getByRole('alert').textContent).toContain('Failed to load chats')
    expect(screen.getByRole('button', { name: /^fix tests/i })).toBeTruthy()
  })

  it('opens settings from the navigator footer', () => {
    const onOpenSettings = vi.fn()
    render(
      <AppShell {...baseProps} onOpenSettings={onOpenSettings}>
        <p>Main content</p>
      </AppShell>
    )

    fireEvent.click(screen.getByRole('button', { name: /^settings/i }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('opens a task from another workspace in that workspace', () => {
    const onSelectRunInWorkspace = vi.fn()
    render(
      <AppShell
        {...baseProps}
        openWorkspaces={['/ws/demo', '/ws/other']}
        runsByWorkspacePath={{
          '/ws/demo': baseProps.runsByWorkspacePath['/ws/demo'],
          '/ws/other': {
            runs: [
              {
                runId: 'run-xyz',
                goal: 'Other workspace chat',
                status: 'done',
                updatedAt: new Date().toISOString()
              }
            ],
            runsCapped: false,
            runsError: null,
            activeRunId: null
          }
        }}
        onSelectRunInWorkspace={onSelectRunInWorkspace}
      >
        <p>Main content</p>
      </AppShell>
    )

    fireEvent.click(screen.getByRole('button', { name: /^other workspace chat/i }))
    expect(onSelectRunInWorkspace).toHaveBeenCalledWith('/ws/other', 'run-xyz')
  })
})


describe('AppShell run toasts', () => {
  function withInbox() {
    let push: ((list: NotificationList) => void) | null = null
    // @ts-expect-error test bridge — a partial window.vyotiq stands in for the preload API
    window.vyotiq = {
      platform: 'win32',
      windowIsMaximized: vi.fn(async () => ({ ok: true as const, data: false })),
      listNotifications: vi.fn(async () => ({ ok: true as const, data: { items: [] } })),
      markNotificationsRead: vi.fn(async () => ({ ok: true as const, data: { items: [] } })),
      onNotificationsChanged: (handler: (list: NotificationList) => void) => {
        push = handler
        return () => {}
      }
    }
    return (items: NotificationItem[]) => act(() => push?.({ items }))
  }

  const finished = (runId: string): NotificationItem => ({
    id: `n-${runId}`,
    createdAt: new Date(Date.now() + 1000).toISOString(),
    read: false,
    source: 'agent',
    kind: 'run_done',
    title: 'Fix tests',
    body: 'Ready for review · 2 files',
    dedupeKey: `run:${runId}:done`,
    action: { type: 'open_run', workspacePath: '/ws/demo', runId },
    reviewFiles: 2
  })

  beforeEach(() => {
    resetToastStoreForTests()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  })

  it('toasts a task that finishes while Home is in front, with Review opening its changes', async () => {
    const publish = withInbox()
    const onReviewTask = vi.fn()
    render(
      <AppShell {...baseProps} view="home" focusedRun={{ workspacePath: '/ws/demo', runId: 'run-abc' }} onReviewTask={onReviewTask}>
        <p>Home</p>
      </AppShell>
    )
    await waitFor(() => expect(window.vyotiq.listNotifications).toHaveBeenCalled())
    publish([finished('run-abc')])
    expect(getToasts().map((t) => [t.message, t.detail])).toEqual([['Ready for review', 'Fix tests · 2 files']])
    getToasts()[0]!.action!.onClick()
    expect(onReviewTask).toHaveBeenCalledWith('/ws/demo', 'run-abc')
  })

  it('says nothing about the task on screen', async () => {
    const publish = withInbox()
    render(
      <AppShell {...baseProps} view="chat" focusedRun={{ workspacePath: '/ws/demo', runId: 'run-abc' }}>
        <p>Task</p>
      </AppShell>
    )
    await waitFor(() => expect(window.vyotiq.listNotifications).toHaveBeenCalled())
    publish([finished('run-abc')])
    expect(getToasts()).toHaveLength(0)
    // A task open in no pane still speaks up.
    publish([finished('run-abc'), finished('run-other')])
    expect(getToasts().map((t) => t.message)).toEqual(['Ready for review'])
  })

  it('answers an ask from the rail’s Inbox, below the desktop breakpoint', async () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: () => ({ matches: false, media: '', addEventListener: () => {}, removeEventListener: () => {} })
    })
    const publish = withInbox()
    const request = {
      requestId: 'req-1',
      runId: 'run-wait',
      toolCallId: 'call-1',
      name: 'terminal',
      summary: 'pnpm test',
      argsPreview: JSON.stringify({ command: 'pnpm test' }),
      mutating: true
    }
    Object.assign(window.vyotiq, { listPendingToolApprovals: vi.fn(async () => ({ ok: true as const, data: [request] })) })
    const onRespondApproval = vi.fn(async () => {})
    render(
      <AppShell
        {...baseProps}
        view="home"
        runsByWorkspacePath={{
          '/ws/demo': {
            ...baseProps.runsByWorkspacePath['/ws/demo'],
            runs: [{ runId: 'run-wait', goal: 'Ship it', status: 'running' as const, updatedAt: new Date().toISOString() }]
          }
        }}
        activeRuns={[
          { runId: 'run-wait', workspacePath: '/ws/demo', invokeId: 1, pendingFollowUps: [], waiting: { kind: 'approval', since: new Date().toISOString() } }
        ]}
        activeRunsLoaded
        onRespondApproval={onRespondApproval}
      >
        <p>Home</p>
      </AppShell>
    )
    await waitFor(() => expect(window.vyotiq.listNotifications).toHaveBeenCalled())
    publish([
      {
        ...finished('run-wait'),
        id: 'n-ask',
        kind: 'needs_you',
        title: 'Ship it',
        body: 'Wants to run pnpm test',
        dedupeKey: 'run:run-wait:needs',
        reviewFiles: undefined
      }
    ])
    const rail = document.querySelector('[data-navigator-rail]') as HTMLElement
    fireEvent.click(within(rail).getByRole('button', { name: /^Inbox/ }))
    const panel = screen.getByRole('dialog', { name: 'Inbox' })
    await waitFor(() => expect(panel.querySelector('[data-inbox-group="asks"]')).not.toBeNull())
    const decision = within(panel).getByRole('group', { name: 'Answer Ship it' })
    fireEvent.click(within(decision).getByRole('button', { name: 'Allow once' }))
    expect(onRespondApproval).toHaveBeenCalledWith('/ws/demo', 'run-wait', 'req-1', 'once')
  })

  it('retries a failed task from the Inbox only while it still stands failed', async () => {
    const publish = withInbox()
    const onRetryRunInWorkspace = vi.fn()
    const failedRuns = (status: 'error' | 'done', retryable: boolean = status === 'error') => ({
      '/ws/demo': {
        ...baseProps.runsByWorkspacePath['/ws/demo'],
        runs: [{ ...baseProps.runsByWorkspacePath['/ws/demo'].runs[0]!, status, ...(retryable ? { retryable: true as const } : {}) }]
      }
    })
    const failure: NotificationItem = { ...finished('run-abc'), id: 'n-err', kind: 'run_error', body: 'Failed: rate limit', dedupeKey: 'run:run-abc:error', reviewFiles: undefined }
    const { rerender } = render(
      <AppShell {...baseProps} view="home" runsByWorkspacePath={failedRuns('error')} onRetryRunInWorkspace={onRetryRunInWorkspace}>
        <p>Home</p>
      </AppShell>
    )
    await waitFor(() => expect(window.vyotiq.listNotifications).toHaveBeenCalled())
    publish([failure])
    fireEvent.click(screen.getByRole('button', { name: /^Inbox/ }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Inbox' })).getByRole('button', { name: 'Retry Fix tests' }))
    expect(onRetryRunInWorkspace).toHaveBeenCalledWith('/ws/demo', 'run-abc')

    // Once it is going again (or done), the Inbox no longer offers it.
    rerender(
      <AppShell {...baseProps} view="home" runsByWorkspacePath={failedRuns('done')} onRetryRunInWorkspace={onRetryRunInWorkspace}>
        <p>Home</p>
      </AppShell>
    )
    fireEvent.click(screen.getByRole('button', { name: /^Inbox/ }))
    const panel = screen.getByRole('dialog', { name: 'Inbox' })
    expect(within(panel).queryByRole('button', { name: /^Retry/ })).toBeNull()
  })

  it('offers no Inbox Retry for a failure Retry cannot get past', async () => {
    const publish = withInbox()
    const runs = {
      '/ws/demo': {
        ...baseProps.runsByWorkspacePath['/ws/demo'],
        runs: [{ ...baseProps.runsByWorkspacePath['/ws/demo'].runs[0]!, status: 'error' as const }]
      }
    }
    const failure: NotificationItem = { ...finished('run-abc'), id: 'n-err', kind: 'run_error', body: 'Failed: crashed', dedupeKey: 'run:run-abc:error', reviewFiles: undefined }
    render(
      <AppShell {...baseProps} view="home" runsByWorkspacePath={runs} onRetryRunInWorkspace={vi.fn()}>
        <p>Home</p>
      </AppShell>
    )
    await waitFor(() => expect(window.vyotiq.listNotifications).toHaveBeenCalled())
    publish([failure])
    fireEvent.click(screen.getByRole('button', { name: /^Inbox/ }))
    const panel = screen.getByRole('dialog', { name: 'Inbox' })
    expect(within(panel).queryByRole('button', { name: /^Retry/ })).toBeNull()
  })
})
