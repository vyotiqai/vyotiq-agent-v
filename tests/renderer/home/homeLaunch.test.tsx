/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AppShell } from '@renderer/app/AppShell'
import { launchViewFor } from '@renderer/app/launchView'
import { HomePage } from '@renderer/features/home/HomePage'
import { clearWorkspaceHotUi } from '@renderer/lib/hooks/workspaceHotUiStore'

const DEMO = '/ws/demo'

const baseProps = {
  view: 'chat' as const,
  workspacePath: DEMO,
  openWorkspaces: [DEMO],
  activeRuns: [] as { runId: string; workspacePath: string }[],
  runsByWorkspacePath: {
    [DEMO]: {
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
  clearWorkspaceHotUi(DEMO)
  vi.restoreAllMocks()
})

function renderDemoHome(overrides: Partial<Parameters<typeof HomePage>[0]> = {}) {
  return render(
    <HomePage
      openWorkspaces={[DEMO]}
      runsByWorkspacePath={baseProps.runsByWorkspacePath}
      onNewSessionInWorkspace={vi.fn()}
      onSelectRunInWorkspace={vi.fn()}
      onSwitchWorkspace={vi.fn()}
      onAddWorkspace={vi.fn()}
      pinnedRunKeys={[]}
      onTogglePinnedRun={vi.fn()}
      {...overrides}
    />
  )
}

describe('launchViewFor (App navigation-mode decision)', () => {
  it('selects the home view by default', () => {
    expect(launchViewFor('home')).toBe('home')
  })

  it('selects the home view when the setting is missing', () => {
    expect(launchViewFor(undefined)).toBe('home')
    expect(launchViewFor(null)).toBe('home')
  })

  it('selects the chat view when navigationMode is sidebar', () => {
    expect(launchViewFor('sidebar')).toBe('chat')
  })
})

describe('Home session entry points', () => {
  it('renders no composer on the Home tab', () => {
    renderDemoHome()

    expect(screen.queryByText(/Describe a task/)).toBeNull()
    expect(screen.getByText('Home')).toBeTruthy()
  })

  it('keeps the workspace card action routing to the new-session handler', () => {
    const onNewSessionInWorkspace = vi.fn()
    renderDemoHome({ onNewSessionInWorkspace })

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))

    expect(onNewSessionInWorkspace).toHaveBeenCalledTimes(1)
    expect(onNewSessionInWorkspace).toHaveBeenCalledWith(DEMO, '')
  })
})

describe("'Go to Home' command dispatch", () => {
  it("opens Home from the command palette's Go to Home entry", () => {
    const onOpenHome = vi.fn()
    render(
      <AppShell {...baseProps} onOpenHome={onOpenHome}>
        <p>Main content</p>
      </AppShell>
    )

    // Command palette chord: Ctrl/Cmd+Shift+P.
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true, shiftKey: true })
    fireEvent.click(screen.getByRole('button', { name: /Go to Home/ }))

    expect(onOpenHome).toHaveBeenCalledTimes(1)
  })

  it('opens Home from the top-left sidebar Home button', () => {
    const onOpenHome = vi.fn()
    render(
      <AppShell {...baseProps} onOpenHome={onOpenHome}>
        <p>Main content</p>
      </AppShell>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Home' }))

    expect(onOpenHome).toHaveBeenCalledTimes(1)
  })
})
