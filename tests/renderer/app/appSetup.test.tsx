/**
 * @vitest-environment jsdom
 *
 * App → Set up: shown until an approval choice is on record. A first run (no
 * task in any open workspace) lands on its first-run form, which never flashes
 * at someone whose tasks are still loading; someone with tasks gets the same
 * page with their folder counted. A send made without a choice is held there
 * and sent once Start saves it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_SETTINGS, emptySecretStatus, type Settings, type WorkspacesState } from '@shared/ipc'
import App from '@renderer/app/App'
import { resetWorkspaceHotUiStoreForTests } from '@renderer/lib/hooks/workspaceHotUiStore'

type ShellProps = { children: ReactNode; loading?: boolean; firstRun?: object | null; onOpenChat?: () => void; onOpenHome?: () => void }
type ChatProps = { onSend: (text: string) => Promise<boolean | void> | boolean | void }
const seen = vi.hoisted(() => ({ shell: null as unknown, chat: null as unknown }))

vi.mock('@renderer/app/AppShell', () => ({
  AppShell: (props: ShellProps) => {
    seen.shell = props
    return (
      <div data-testid={props.loading ? 'shell-loading' : 'shell'} data-first-run={props.firstRun ? '' : undefined}>
        {props.children}
      </div>
    )
  }
}))
vi.mock('@renderer/features/settings', () => ({ SettingsView: () => <div data-testid="settings" /> }))
vi.mock('@renderer/features/marketplace', () => ({ MarketplaceView: () => null }))
vi.mock('@renderer/features/home/HomePage', () => ({ HomePage: () => <div data-testid="home" /> }))
vi.mock('@renderer/features/chat/ChatView', () => ({
  ChatView: (props: ChatProps) => {
    seen.chat = props
    return <div data-testid="chat" />
  }
}))
vi.mock('@renderer/features/chat/SessionChatColumn', () => ({ SessionChatColumn: () => null }))

const shell = (): ShellProps => seen.shell as ShellProps
const chatView = (): ChatProps => seen.chat as ChatProps

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
const chatStart = vi.fn()

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
    probeNetwork: vi.fn(async () => ({ ok: true as const, data: true })),
    chatStart
  } as unknown as typeof window.vyotiq
}

beforeEach(() => {
  resetWorkspaceHotUiStoreForTests()
  setSettings.mockReset()
  listModels.mockReset()
  chatStart.mockReset()
  // A code that is not retried: a retry would land in the next test.
  chatStart.mockResolvedValue({ ok: false as const, error: 'not started in this test', code: 'validation' })
  seen.shell = null
  seen.chat = null
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
    // The check starts in an effect after Set up first paints.
    await waitFor(() => expect(listModels).toHaveBeenCalledWith({ provider: 'ollama', forceRefresh: true }))
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

  it('tasks already there: Set up asks only what is missing, and no first-run form flashes while they load', async () => {
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
    expect(await screen.findByRole('heading', { name: 'Set up Agent V' }, { timeout: 5000 })).toBeTruthy()
    // Their tasks stay in the navigator, and the folder they live in counts —
    // even main's scratch folder: nobody is sent to pick one again.
    expect(screen.getByTestId('shell').hasAttribute('data-first-run')).toBe(false)
    expect(document.querySelector('[data-setup-step="2"]')?.getAttribute('data-state')).toBe('done')
    expect(document.querySelector('[data-setup-step="2"]')?.textContent).toContain(SCRATCH)
    await waitFor(
      () => expect((screen.getByRole('button', { name: /Start a task/ }) as HTMLButtonElement).disabled).toBe(false),
      { timeout: 5000 }
    )
    expect(screen.queryByText(/first task/)).toBeNull()
  })

  it('a send made before the choice is held on Set up, then sent once Start saves it', async () => {
    install({ openPaths: [WS], runs: 2, settings: { navigationMode: 'sidebar' } })
    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Set up Agent V' }, { timeout: 5000 })).toBeTruthy()
    act(() => shell().onOpenChat?.())
    expect(await screen.findByTestId('chat')).toBeTruthy()

    let held: boolean | void = true
    await act(async () => {
      held = await chatView().onSend('Fix the flaky test')
    })
    // Not sent: the composer keeps the text, and Set up asks first.
    expect(held).toBe(false)
    expect(chatStart).not.toHaveBeenCalled()
    expect(await screen.findByRole('heading', { name: 'Set up Agent V' })).toBeTruthy()
    expect(
      screen.getByText(
        'Your instruction waits here until you decide what needs your OK. Everything here can change later in Settings.'
      )
    ).toBeTruthy()
    const send = screen.getByRole('button', { name: /Send your instruction/ }) as HTMLButtonElement
    await waitFor(() => expect(send.disabled).toBe(false), { timeout: 5000 })
    expect(screen.getByText('Sends in ws-first')).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: /Unattended/ }))
    fireEvent.click(send)

    await waitFor(() =>
      expect(setSettings).toHaveBeenCalledWith({
        toolApproval: { ...DEFAULT_SETTINGS.toolApproval, mode: 'off' },
        toolApprovalOnboardingDone: true
      })
    )
    expect(await screen.findByTestId('chat', {}, { timeout: 5000 })).toBeTruthy()
    await waitFor(() => expect(chatStart).toHaveBeenCalled(), { timeout: 5000 })
    expect(JSON.stringify(chatStart.mock.calls[0])).toContain('Fix the flaky test')
  })

  it('going back to the task without choosing lets the held send go', async () => {
    install({ openPaths: [WS], runs: 2, settings: { navigationMode: 'sidebar' } })
    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Set up Agent V' }, { timeout: 5000 })).toBeTruthy()
    act(() => shell().onOpenChat?.())
    await act(async () => {
      await chatView().onSend('Fix the flaky test')
    })
    expect(await screen.findByRole('button', { name: /Send your instruction/ })).toBeTruthy()

    act(() => shell().onOpenChat?.())
    expect(await screen.findByTestId('chat')).toBeTruthy()
    // Back on Home, Set up no longer holds it — the words are in the composer.
    act(() => shell().onOpenHome?.())
    const start = await screen.findByRole('button', { name: /Start a task/ })
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 })
    fireEvent.click(start)
    await waitFor(() => expect(setSettings).toHaveBeenCalled())
    expect(chatStart).not.toHaveBeenCalled()
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
