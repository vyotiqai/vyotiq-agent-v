/**
 * @vitest-environment jsdom
 *
 * App → Set up: shown on a first run only (no approval choice on record and no
 * task in any open workspace), never flashed at a returning user while their
 * tasks load, and "Start your first task" saves the choice where the first-send
 * question saves it, then opens the brief.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_SETTINGS, emptySecretStatus, type Settings, type WorkspacesState } from '@shared/ipc'
import App from '@renderer/app/App'
import { resetWorkspaceHotUiStoreForTests } from '@renderer/lib/hooks/workspaceHotUiStore'

vi.mock('@renderer/app/AppShell', () => ({
  AppShell: ({ children, loading }: { children: ReactNode; loading?: boolean }) => (
    <div data-testid={loading ? 'shell-loading' : 'shell'}>{children}</div>
  )
}))
vi.mock('@renderer/features/settings', () => ({ SettingsView: () => <div data-testid="settings" /> }))
vi.mock('@renderer/features/marketplace', () => ({ MarketplaceView: () => null }))
vi.mock('@renderer/features/home/HomePage', () => ({ HomePage: () => <div data-testid="home" /> }))
vi.mock('@renderer/features/chat/ChatView', () => ({ ChatView: () => <div data-testid="chat" /> }))
vi.mock('@renderer/features/chat/SessionChatColumn', () => ({ SessionChatColumn: () => null }))
vi.mock('@renderer/features/chat/components/ToolApprovalOnboardingModal', () => ({
  ToolApprovalOnboardingModal: () => null
}))

const WS = '/ws-first'
/** Main opens its own scratch folder whenever no project is open — a first run always has it. */
const SCRATCH = '/userData/home'

function registry(openPaths: string[]): WorkspacesState {
  return {
    version: 2,
    workspaceIdsByPath: {},
    legacySessionsMigrated: true,
    openPaths,
    activePath: openPaths[openPaths.length - 1] ?? null,
    recentPaths: [...openPaths].reverse().concat('/ws-older'),
    uiStateByPath: Object.fromEntries(
      openPaths.map((path) => [
        path,
        {
          activeRunId: null,
          openRunIds: [],
          scrollTop: 0,
          scrollTopByRunId: {},
          composerDraft: '',
          composerDraftByRunId: {},
          agentMode: 'agent' as const,
          agentProfileIdByRunId: {},
          expansionsByRunId: {}
        }
      ])
    ),
    settingsOverridesByPath: {}
  }
}

let settings: Settings
let listRunsResult: () => Promise<unknown>
const setSettings = vi.fn()
const listModels = vi.fn()

function install(opts: { settings?: Partial<Settings>; openPaths?: string[]; runs?: number }): void {
  settings = { ...DEFAULT_SETTINGS, ...opts.settings }
  const state = registry(opts.openPaths ?? [SCRATCH])
  const runs = Array.from({ length: opts.runs ?? 0 }, (_, i) => ({
    runId: `run-${i}`,
    status: 'done' as const,
    updatedAt: new Date().toISOString(),
    goal: `Task ${i}`
  }))
  listRunsResult = async () => ({ ok: true as const, data: { runs, capped: false } })
  setSettings.mockImplementation(async (partial: Partial<Settings>) => {
    settings = { ...settings, ...partial }
    return { ok: true as const, data: settings }
  })
  listModels.mockResolvedValue({ ok: true as const, data: { models: [] } })
  window.vyotiq = {
    getSettings: vi.fn(async () => ({ ok: true as const, data: settings })),
    secretStatus: vi.fn(async () => ({
      ok: true as const,
      data: { keys: emptySecretStatus(), encryptionAvailable: true }
    })),
    setSettings,
    getWorkspaces: vi.fn(async () => ({ ok: true as const, data: state })),
    getHomeWorkspacePath: vi.fn(async () => ({ ok: true as const, data: SCRATCH })),
    listRuns: vi.fn(() => listRunsResult()),
    listActiveRuns: vi.fn(async () => ({ ok: true as const, data: [] })),
    loadRun: vi.fn(async () => ({ ok: true as const, data: { runId: 'x', messages: [] } })),
    loadRunEvents: vi.fn(async () => ({ ok: true as const, data: [] })),
    updateWorkspaceUiState: vi.fn(async () => ({ ok: true as const, data: true })),
    setActiveWorkspace: vi.fn(async () => ({ ok: true as const, data: state })),
    listModels,
    onChatEvent: vi.fn(() => () => {}),
    probeNetwork: vi.fn(async () => ({ ok: true as const, data: true }))
  } as unknown as typeof window.vyotiq
}

beforeEach(() => {
  resetWorkspaceHotUiStoreForTests()
  setSettings.mockReset()
  listModels.mockReset()
})

afterEach(() => {
  cleanup()
  resetWorkspaceHotUiStoreForTests()
})

describe('App → Set up', () => {
  it('a first run lands on Set up, checked against the provider itself', async () => {
    install({})
    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Set up Agent V' }, { timeout: 5000 })).toBeTruthy()
    expect(screen.queryByTestId('home')).toBeNull()
    expect(listModels).toHaveBeenCalledWith({ provider: 'ollama', forceRefresh: true })
    await waitFor(
      () => expect(document.querySelector('[data-setup-step="1"]')?.getAttribute('data-state')).toBe('done'),
      { timeout: 5000 }
    )
    expect(document.querySelector('[data-setup-step="1"]')?.textContent).toContain(
      'Ollama · no key needed · http://127.0.0.1:11434'
    )
    // The scratch folder main opened by itself is nobody's choice: step 2 still
    // asks for a folder, and only folders someone opened are offered.
    expect(document.querySelector('[data-setup-step="2"]')?.getAttribute('data-state')).toBe('current')
    expect(screen.getByRole('button', { name: /ws-older/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /userData/ })).toBeNull()
    expect((screen.getByRole('button', { name: /Start your first task/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Open a workspace first')).toBeTruthy()
  })

  it('a returning user goes to Home', async () => {
    install({ settings: { toolApprovalOnboardingDone: true } })
    render(<App />)

    expect(await screen.findByTestId('home', {}, { timeout: 5000 })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Set up Agent V' })).toBeNull()
  })

  it('tasks already there mean no Set up — and none flashes while they load', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    install({ openPaths: [SCRATCH], runs: 2, settings: { navigationMode: 'sidebar' } })
    const loaded = listRunsResult
    listRunsResult = async () => {
      await gate
      return loaded()
    }
    render(<App />)

    await waitFor(() => expect(window.vyotiq.listRuns).toHaveBeenCalled())
    // The tasks haven't come back: nothing is decided, so nothing but the skeleton shows.
    expect(screen.getByTestId('shell-loading')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Set up Agent V' })).toBeNull()

    release()
    expect(await screen.findByTestId('chat', {}, { timeout: 5000 })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Set up Agent V' })).toBeNull()
  })

  it('Start saves the approval choice, then opens the brief in the workspace', async () => {
    install({ openPaths: [SCRATCH, WS] })
    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Set up Agent V' }, { timeout: 5000 })).toBeTruthy()
    expect(document.querySelector('[data-setup-step="2"]')?.getAttribute('data-state')).toBe('done')
    expect(document.querySelector('[data-setup-step="2"]')?.textContent).toContain(WS)
    await waitFor(
      () => expect((screen.getByRole('button', { name: /Start your first task/ }) as HTMLButtonElement).disabled).toBe(false),
      { timeout: 5000 }
    )
    expect(screen.getByText('Starts in ws-first')).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: /Every tool/ }))
    fireEvent.click(screen.getByRole('button', { name: /Start your first task/ }))

    await waitFor(
      () =>
        expect(setSettings).toHaveBeenCalledWith({
          toolApproval: { ...DEFAULT_SETTINGS.toolApproval, mode: 'all' },
          toolApprovalOnboardingDone: true
        }),
      { timeout: 5000 }
    )
    expect(await screen.findByTestId('chat', {}, { timeout: 5000 })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Set up Agent V' })).toBeNull()
  })
})
