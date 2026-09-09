/**
 * @vitest-environment jsdom
 *
 * App.handleSessionDrop: validates the dropped workspace before committing the
 * pane layout, keeps the capacity toast, and never lets a transcript-load
 * failure surface as an unhandled rejection.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { singlePaneLayout, SESSION_DRAG_MIME } from '@renderer/lib/chat/chatPaneLayout'
import type { ChatPaneLayout } from '@renderer/lib/chat/chatPaneLayout'
import { logger } from '@shared/logger'

const state = {
  paneLayout: null as ChatPaneLayout | null,
  dropSessionOnPane: vi.fn<() => boolean>(),
  loadRunIntoTab: vi.fn<() => Promise<unknown>>(),
  getRunController: vi.fn<() => unknown>(),
  dropCalls: [] as Array<[string, string, { workspacePath: string; runId: string }]>
}

/** Stable object identity across renders — effects key on settings fields. */
const settingsStub = {
  navigationMode: 'sidebar' as const,
  theme: 'system',
  fontScale: 1,
  uiDensity: 'comfortable',
  skinId: 'default',
  customCssPath: '',
  tabAutocomplete: true,
  favoriteModels: [],
  recentModels: [],
  mcpServers: [],
  toolApproval: { mode: 'off' },
  toolApprovalOnboardingDone: true,
  provider: 'anthropic',
  model: 'claude-3-5-sonnet',
  showThinking: true,
  thinkingPrefsByProvider: {},
  thinkingEffort: 'medium',
  serviceTier: 'auto',
  serviceTierByModel: {}
}

const noop = () => undefined

/** Stable workspace-manager stub — same identities across renders. */
const workspaceStub = {
  registry: null,
  activeWorkspace: '/ws-a',
  openWorkspaces: ['/ws-a'],
  activeContext: null,
  contexts: {},
  activeRuns: [],
  chat: {
    runId: null,
    items: [],
    itemsStore: {},
    metaStore: {},
    running: false,
    invokeId: null,
    pendingRun: null,
    errorCode: null,
    networkWait: null,
    compacting: false,
    incomplete: false,
    turnStatus: null,
    contextUsage: null,
    turnUsage: null,
    messages: [],
    pendingFollowUps: [],
    transcriptLoading: false,
    writeCheckpoint: null,
    agentInstances: {}
  },
  chatActions: {
    send: noop,
    cancel: noop,
    editAndResend: noop,
    revertToUserMessage: noop,
    sendFollowUpNow: noop,
    removeFollowUp: noop
  },
  onLoadToolContent: noop,
  onThinkingToggle: noop,
  onToolToggle: noop,
  onGroupToggle: noop,
  onTurnToggle: noop,
  onApprovalDecision: noop,
  onQuestionSubmit: noop,
  collapsedTurns: {},
  openRunTab: noop,
  openRunInWorkspace: noop,
  newChatInWorkspace: noop,
  closeRunTab: noop,
  purgeDeletedRunUi: noop,
  setSessionQuery: noop,
  addWorkspace: noop,
  switchWorkspace: noop,
  removeWorkspace: noop,
  getRunController: (...args: unknown[]) => state.getRunController(...args),
  loadRunIntoTab: (...args: unknown[]) => state.loadRunIntoTab(...args),
  refreshActiveRuns: noop,
  refreshWorkspaceRuns: noop,
  loadOlderRuns: noop,
  workspaceHasBackgroundRun: () => false,
  scrollRestoreToken: 0,
  setComposerDraft: noop,
  setComposerDraftForPane: noop,
  setAgentMode: noop,
  onMessageListScroll: noop,
  onMessageListScrollForPane: noop,
  setPaneCapacityContext: noop,
  setSettingsOverride: noop,
  workspaceError: null,
  clearWorkspaceError: noop,
  clearRunsError: noop,
  activeScrollTop: null,
  chatSurfaceEpoch: 0,
  get paneLayout(): ChatPaneLayout | null {
    return state.paneLayout
  },
  focusPaneById: noop,
  closePaneById: noop,
  setPaneSizesByIndex: noop,
  dropSessionOnPane: (
    anchorPaneId: string,
    zone: string,
    payload: { workspacePath: string; runId: string }
  ) => {
    state.dropCalls.push([anchorPaneId, zone, payload])
    return state.dropSessionOnPane()
  },
  isSessionOpenInPane: () => false,
  isSessionFocusedInPane: () => false,
  getPaneChatSnapshot: () => null,
  focusedWorkspacePath: '/ws-a',
  getFocusedPane: () => null,
  getPaneById: () => null,
  openNewChatInPane: noop,
  focusedRunId: null,
  workspaceExpandedByPath: {},
  setWorkspaceExpanded: noop
}

vi.mock('@renderer/app/AppShell', () => ({
  AppShell: ({ children }: { children?: ReactNode }) => <div>{children}</div>
}))

vi.mock('@renderer/features/chat/ChatView', async () => {
  const { ChatPaneHost } = await import('@renderer/features/chat/ChatPaneHost')
  return {
    ChatView: ({ multiPane }: { multiPane?: Record<string, unknown> | null }) => {
      const panes = (multiPane?.panes ?? []) as never[]
      if (panes.length === 0) return null
      return (
        <ChatPaneHost
          panes={panes}
          focusedPaneId={multiPane!.focusedPaneId as string}
          sizes={multiPane!.sizes as number[]}
          onFocusPane={multiPane!.onFocusPane as () => void}
          onClosePane={multiPane!.onClosePane as () => void}
          onSizesChange={multiPane!.onSizesChange as () => void}
          onSessionDrop={multiPane!.onSessionDrop as () => boolean}
          getPaneTitle={multiPane!.getPaneTitle as () => string}
          renderPane={() => <div data-testid="pane-body">body</div>}
        />
      )
    }
  }
})

vi.mock('@renderer/lib/hooks/useSettings', () => ({
  useSettings: () => ({
    settings: settingsStub,
    secrets: {},
    encryptionAvailable: false,
    secretsLoadError: null,
    loading: false,
    refresh: noop,
    update: noop,
    saveSecret: noop,
    removeSecret: noop,
    pickWorkspace: noop,
    error: null,
    setError: noop
  })
}))

vi.mock('@renderer/lib/hooks/useAppearance', () => ({
  useAppearance: () => ({ setAppearance: noop, hydrate: noop })
}))

vi.mock('@renderer/lib/hooks/useCustomSkinCss', () => ({
  useCustomSkinCss: () => ({ customCssError: null })
}))

vi.mock('@renderer/lib/hooks/useWorkspaceManager', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@renderer/lib/hooks/useWorkspaceManager')>()
  return {
    ...actual,
    useWorkspaceManager: () => workspaceStub
  }
})

// @vitest-environment jsdom
import App from '@renderer/app/App'

function mockPaneRect(host: HTMLElement): void {
  Object.defineProperty(host, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 0,
      top: 0,
      width: 600,
      height: 400,
      right: 600,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
  })
}

function dropOnPane(payload: { workspacePath: string; runId: string }): void {
  const host = screen.getByTestId('pane-body').closest('[data-chat-pane]') as HTMLElement
  mockPaneRect(host)
  const raw = JSON.stringify(payload)
  const drop = createEvent.drop(host, {
    dataTransfer: {
      types: [SESSION_DRAG_MIME],
      getData: (type: string) => (type === SESSION_DRAG_MIME ? raw : '')
    }
  })
  Object.defineProperty(drop, 'clientX', { configurable: true, value: 520 })
  fireEvent(host, drop)
}

describe('App.handleSessionDrop', () => {
  beforeEach(() => {
    // @ts-expect-error test bridge
    window.vyotiq = {}
    state.paneLayout = singlePaneLayout('/ws-a', null)
    state.dropCalls = []
    state.dropSessionOnPane.mockReset()
    state.loadRunIntoTab.mockReset()
    state.getRunController.mockReset()
    state.getRunController.mockReturnValue(undefined)
    state.loadRunIntoTab.mockResolvedValue(undefined)
  })

  it('success commits the drop, returns true and loads the transcript once', async () => {
    state.dropSessionOnPane.mockReturnValue(true)
    render(<App />)
    await waitFor(() => screen.getByTestId('pane-body'))

    const loadRun = state.loadRunIntoTab
    dropOnPane({ workspacePath: '/ws-a', runId: 'run-a' })

    await waitFor(() => expect(state.dropCalls).toHaveLength(1))
    expect(state.dropCalls[0]![1]).toBe('right')
    expect(state.dropCalls[0]![2]).toEqual({ workspacePath: '/ws-a', runId: 'run-a' })
    await waitFor(() => expect(loadRun).toHaveBeenCalledTimes(1))
    expect(loadRun).toHaveBeenCalledWith('/ws-a', 'run-a')
    expect(screen.queryByText('The workspace for that chat is not open.')).toBeNull()
    expect(screen.queryByText('Not enough room for another chat pane.')).toBeNull()
  })

  it('rejects a drop for a workspace that is not open with an accurate toast', async () => {
    state.dropSessionOnPane.mockReturnValue(true)
    render(<App />)
    await waitFor(() => screen.getByTestId('pane-body'))

    dropOnPane({ workspacePath: '/ws-closed', runId: 'run-x' })

    await waitFor(() =>
      expect(screen.getByText('The workspace for that chat is not open.')).toBeTruthy()
    )
    expect(state.dropCalls).toHaveLength(0)
    expect(state.loadRunIntoTab).not.toHaveBeenCalled()
  })

  it('capacity refusal keeps the room toast and returns false', async () => {
    state.dropSessionOnPane.mockReturnValue(false)
    render(<App />)
    await waitFor(() => screen.getByTestId('pane-body'))

    dropOnPane({ workspacePath: '/ws-a', runId: 'run-a' })

    await waitFor(() =>
      expect(screen.getByText('Not enough room for another chat pane.')).toBeTruthy()
    )
    expect(state.dropCalls).toHaveLength(1)
    expect(state.loadRunIntoTab).not.toHaveBeenCalled()
  })

  it('transcript load failure is logged, not thrown as unhandled rejection', async () => {
    state.dropSessionOnPane.mockReturnValue(true)
    state.loadRunIntoTab.mockRejectedValue(new Error('transcript unavailable'))
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err)
    }
    process.on('unhandledRejection', onUnhandled)

    render(<App />)
    await waitFor(() => screen.getByTestId('pane-body'))

    dropOnPane({ workspacePath: '/ws-a', runId: 'run-a' })

    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    const [message, fields] = warn.mock.calls[0]! as unknown as [
      string,
      Record<string, unknown>
    ]
    expect(message).toBe('session drop transcript load failed')
    expect(fields.scope).toBe('chat')
    expect(fields.workspacePath).toBe('/ws-a')
    expect(fields.runId).toBe('run-a')
    await waitFor(() => expect(unhandled).toHaveLength(0))

    process.off('unhandledRejection', onUnhandled)
    warn.mockRestore()
  })
})
