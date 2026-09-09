/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AppShell } from '@renderer/app/AppShell'
import { setWorkspaceHotUi, clearWorkspaceHotUi } from '@renderer/lib/hooks/workspaceHotUiStore'

const baseProps = {
  view: 'chat' as const,
  workspacePath: '/ws/demo',
  openWorkspaces: ['/ws/demo'],
  activeRuns: [] as { runId: string; workspacePath: string }[],
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
  sessionQuery: '',
  onSessionQuery: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenMarketplace: vi.fn(),
  onOpenChat: vi.fn(),
  onNewChat: vi.fn(),
  onNewChatInWorkspace: vi.fn(),
  onSelectRunInWorkspace: vi.fn(),
  onRenameRunInWorkspace: vi.fn(),
  onDeleteRunInWorkspace: vi.fn(),
  onSwitchWorkspace: vi.fn(),
  onCloseWorkspace: vi.fn(),
  onAddWorkspace: vi.fn(),
  workspaceHasBackgroundRun: () => false
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
  clearWorkspaceHotUi('/ws/demo')
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

    fireEvent.click(screen.getByRole('button', { name: /open menu/i }))
    expect(screen.getByRole('dialog', { name: /navigation/i })).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: /navigation/i })).toBeNull()
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

  it('shows agent-first sidebar with chats and workspace controls', () => {
    render(
      <AppShell {...baseProps}>
        <p>Main content</p>
      </AppShell>
    )
    expect(screen.getByRole('region', { name: /workspace sessions/i })).toBeTruthy()
    expect(screen.getByText(/workspaces/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /new chat/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /settings/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^marketplace$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /collapse sidebar/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /open menu/i })).toBeNull()
  })

  it('shows a sidebar resize handle on desktop when expanded', () => {
    render(
      <AppShell {...baseProps}>
        <p>Main content</p>
      </AppShell>
    )
    expect(screen.getByRole('separator', { name: /Resize sidebar/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /collapse sidebar/i }))
    expect(screen.queryByRole('separator', { name: /Resize sidebar/i })).toBeNull()
  })

  it('collapses the desktop sidebar to a top corner icon', () => {
    render(
      <AppShell {...baseProps}>
        <p>Main content</p>
      </AppShell>
    )

    fireEvent.click(screen.getByRole('button', { name: /collapse sidebar/i }))
    expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: /search chats/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /new chat in/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^search chats$/i })).toBeNull()
    expect(screen.getByRole('button', { name: /^settings$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^marketplace$/i })).toBeTruthy()
    expect(screen.queryByRole('tablist', { name: /workspaces/i })).toBeNull()
    expect(localStorage.getItem('vyotiq.sidebarCollapsed')).toBe('1')

    // Expanding restores the full sidebar chrome.
    fireEvent.click(screen.getByRole('button', { name: /expand sidebar/i }))
    expect(screen.getByRole('textbox', { name: /search chats/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /new chat in/i })).toBeTruthy()
  })

  it('disables workspace-dependent sidebar actions when no workspace is open', () => {
    render(
      <AppShell {...baseProps} workspacePath={null} openWorkspaces={[]} runs={[]}>
        <p>Main content</p>
      </AppShell>
    )

    expect(screen.queryByRole('button', { name: /new chat in/i })).toBeNull()
    expect((screen.getByRole('textbox', { name: /search chats/i }) as HTMLInputElement).disabled).toBe(
      true
    )
    expect((screen.getByRole('button', { name: /settings/i }) as HTMLButtonElement).disabled).toBe(
      false
    )
    expect(screen.getByText('Open a workspace to see chats')).toBeTruthy()
  })

  it('toggles the desktop sidebar with Ctrl/Cmd+B', () => {
    render(
      <AppShell {...baseProps}>
        <p>Main content</p>
      </AppShell>
    )

    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(screen.getByRole('button', { name: /collapse sidebar/i })).toBeTruthy()
  })

  it('focuses chat search with Ctrl/Cmd+K after expanding', async () => {
    render(
      <AppShell {...baseProps}>
        <p>Main content</p>
      </AppShell>
    )

    fireEvent.click(screen.getByRole('button', { name: /collapse sidebar/i }))
    expect(screen.queryByRole('textbox', { name: /search chats/i })).toBeNull()

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const search = await screen.findByRole('textbox', { name: /search chats/i })
    await waitFor(() => {
      expect(document.activeElement).toBe(search)
    })
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
          <div role="textbox" aria-label="Message" contentEditable tabIndex={0} />
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
          <div role="textbox" aria-label="Message" contentEditable tabIndex={0} />
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
    fireEvent.click(screen.getByRole('button', { name: /open menu/i }))
    expect(screen.getByRole('dialog', { name: /navigation/i })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onChatStop).not.toHaveBeenCalled()
  })

  it('does not stop on Escape with session query while running', () => {
    const onChatStop = vi.fn()
    setWorkspaceHotUi('/ws/demo', { sessionQuery: 'hello' })
    render(
      <AppShell {...baseProps} running onChatStop={onChatStop} sessionQuery="hello">
        <p>Main content</p>
      </AppShell>
    )
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
        <div role="textbox" aria-label="Message" contentEditable tabIndex={0} />
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
        <div role="textbox" aria-label="Message" contentEditable tabIndex={0} />
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

  it('keeps the chat list visible when runsError is set', () => {
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
    expect(screen.getAllByRole('button', { name: /fix tests/i }).length).toBeGreaterThan(0)
  })

  it('opens settings from the sidebar footer', () => {
    const onOpenSettings = vi.fn()
    render(
      <AppShell {...baseProps} onOpenSettings={onOpenSettings}>
        <p>Main content</p>
      </AppShell>
    )

    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('switches workspace when selecting a run from another workspace', () => {
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

    fireEvent.click(screen.getByRole('button', { name: /expand .*other/i }))
    fireEvent.click(screen.getAllByRole('button', { name: /other workspace chat/i })[0])
    expect(onSelectRunInWorkspace).toHaveBeenCalledWith('/ws/other', 'run-xyz')
  })
})
