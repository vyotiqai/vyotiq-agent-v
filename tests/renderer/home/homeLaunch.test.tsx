/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'
import type { ProviderId, SecretProvider } from '@shared/ipc'
import { AppShell } from '@renderer/app/AppShell'
import { launchViewFor } from '@renderer/app/launchView'
import { HomePage } from '@renderer/features/home/HomePage'
import { clearWorkspaceHotUi } from '@renderer/lib/hooks/workspaceHotUiStore'

// Same composer stub contract as homePage.test.tsx: these tests cover the
// Home page's routing wiring, not the composer internals.
const composerState = vi.hoisted(() => ({
  props: {} as Record<string, unknown>
}))

vi.mock('@renderer/features/chat/components/composer', () => ({
  Composer: function ComposerStub(props: {
    onSend?: (
      text: string,
      images?: string[],
      files?: unknown,
      extras?: unknown
    ) => unknown
  }) {
    composerState.props = props as Record<string, unknown>
    return (
      <div data-testid="composer-stub">
        <button
          type="button"
          aria-label="Composer send"
          onClick={() => {
            void props.onSend?.('Ship the home surface', undefined, undefined, undefined)
          }}
        >
          Composer send
        </button>
      </div>
    )
  }
}))

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
  composerState.props = {}
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
      activeWorkspacePath={DEMO}
      runsByWorkspacePath={baseProps.runsByWorkspacePath}
      onNewSessionInWorkspace={vi.fn()}
      onSelectRunInWorkspace={vi.fn()}
      onSwitchWorkspace={vi.fn()}
      onAddWorkspace={vi.fn()}
      onSendInWorkspace={vi.fn(async () => true)}
      onDraftChangeInWorkspace={vi.fn()}
      pinnedRunKeys={[]}
      onTogglePinnedRun={vi.fn()}
      provider={'openai' as ProviderId}
      model="gpt-test"
      secrets={{} as Record<SecretProvider, boolean>}
      onProviderModel={vi.fn()}
      chatSettings={{} as unknown as EffectiveChatSettings}
      onChatSettingsChange={vi.fn()}
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

describe('Home hero composer → session pipeline wiring', () => {
  it('routes the composed send to the send handler bound to the workspace', () => {
    const onSendInWorkspace = vi.fn(async () => true)
    renderDemoHome({ onSendInWorkspace })

    fireEvent.click(screen.getByRole('button', { name: 'Composer send' }))

    expect(onSendInWorkspace).toHaveBeenCalledTimes(1)
    expect(onSendInWorkspace).toHaveBeenCalledWith(DEMO, 'Ship the home surface', undefined, undefined, undefined)
    expect(composerState.props.workspacePath).toBe(DEMO)
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
