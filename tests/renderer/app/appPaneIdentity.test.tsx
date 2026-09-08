/**
 * @vitest-environment jsdom
 *
 * App pane wiring: settings / slash writes / slash undo must use the pane's
 * workspacePath + runId, not the registry-active workspace or focused checkpoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { ChatSettingsPatch } from '@shared/effectiveSettings'
import {
  DEFAULT_SETTINGS,
  emptySecretStatus,
  type WorkspacesState
} from '@shared/ipc'
import App from '@renderer/app/App'
import type { SlashClientHandlers } from '@renderer/features/chat/components/composer/slashCommandExecute'
import { executeSlashResolveResult } from '@renderer/features/chat/components/composer/slashCommandExecute'
import { CHAT_PANE_LAYOUT_KEY } from '@renderer/lib/chat/chatPaneLayout'
import { resetWorkspaceHotUiStoreForTests } from '@renderer/lib/hooks/workspaceHotUiStore'

const harness = vi.hoisted(() => ({
  columns: new Map<
    string,
    {
      workspacePath: string | null
      activeRunId: string | null
      transcriptLoading: boolean
      onChatSettingsChange: (patch: ChatSettingsPatch) => void
      slashHandlers?: SlashClientHandlers
    }
  >()
}))

vi.mock('@renderer/app/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@renderer/features/settings', () => ({
  SettingsView: () => null
}))

vi.mock('@renderer/features/marketplace', () => ({
  MarketplaceView: () => null
}))

vi.mock('@renderer/features/chat/components/ToolApprovalOnboardingModal', () => ({
  ToolApprovalOnboardingModal: () => null
}))

vi.mock('@renderer/features/chat/ChatView', () => ({
  ChatView: ({
    multiPane
  }: {
    multiPane?: {
      panes: Array<{ paneId: string; workspacePath: string; runId: string | null }>
      focusedPaneId: string
      renderPane: (
        pane: { paneId: string; workspacePath: string; runId: string | null },
        options: { focused: boolean; sideRailPad: boolean }
      ) => ReactNode
    } | null
  }) => {
    if (!multiPane) return <div data-testid="chat-single" />
    return (
      <div data-testid="chat-multi">
        {multiPane.panes.map((pane) => (
          <div key={pane.paneId} data-testid={`host-${pane.paneId}`}>
            {multiPane.renderPane(pane, {
              focused: pane.paneId === multiPane.focusedPaneId,
              sideRailPad: false
            })}
          </div>
        ))}
      </div>
    )
  }
}))

vi.mock('@renderer/features/chat/SessionChatColumn', () => ({
  SessionChatColumn: (props: {
    workspacePath: string | null
    activeRunId: string | null
    transcriptLoading?: boolean
    onChatSettingsChange: (patch: ChatSettingsPatch) => void
    slashHandlers?: SlashClientHandlers
  }) => {
    if (props.workspacePath) {
      harness.columns.set(props.workspacePath, {
        workspacePath: props.workspacePath,
        activeRunId: props.activeRunId,
        transcriptLoading: Boolean(props.transcriptLoading),
        onChatSettingsChange: props.onChatSettingsChange,
        slashHandlers: props.slashHandlers
      })
    }
    return <div data-testid={`session-${props.workspacePath ?? 'none'}`} />
  }
}))

const WS_A = '/ws-a'
const WS_B = '/ws-b'
const RUN_A = 'run-a'
const RUN_B = 'run-b'

function registry(): WorkspacesState {
  return {
    version: 2,
    workspaceIdsByPath: {},
    legacySessionsMigrated: true,
    openPaths: [WS_A, WS_B],
    activePath: WS_A,
    recentPaths: [],
    uiStateByPath: {
      [WS_A]: {
        activeRunId: RUN_A,
        openRunIds: [RUN_A],
        scrollTop: 0,
        scrollTopByRunId: {},
        composerDraft: '',
        composerDraftByRunId: {},
        agentMode: 'agent'
      },
      [WS_B]: {
        activeRunId: RUN_B,
        openRunIds: [RUN_B],
        scrollTop: 0,
        scrollTopByRunId: {},
        composerDraft: '',
        composerDraftByRunId: {},
        agentMode: 'agent'
      }
    },
    settingsOverridesByPath: {
      [WS_A]: {
        useOverride: true,
        provider: 'openai',
        model: 'gpt-4.1',
        showThinking: false
      },
      [WS_B]: {
        useOverride: true,
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        showThinking: false
      }
    }
  }
}

function checkpointEvent(runId: string, checkpointId: string, path: string) {
  return {
    at: new Date().toISOString(),
    event: {
      type: 'writes_checkpoint' as const,
      runId,
      checkpointId,
      files: [{ path, action: 'modified' as const, undoable: true }]
    }
  }
}

const setWorkspaceSettingsOverride = vi.fn()
const slashCommandsCreateRule = vi.fn()
const resolveWrites = vi.fn()
const loadRun = vi.fn()
const loadRunEvents = vi.fn()

beforeEach(() => {
  harness.columns.clear()
  resetWorkspaceHotUiStoreForTests()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1920 })
  localStorage.setItem(
    CHAT_PANE_LAYOUT_KEY,
    JSON.stringify({
      panes: [
        { paneId: 'pane-a', workspacePath: WS_A, runId: RUN_A },
        { paneId: 'pane-b', workspacePath: WS_B, runId: RUN_B }
      ],
      focusedPaneId: 'pane-a',
      sizes: [0.5, 0.5]
    })
  )

  const state = registry()
  setWorkspaceSettingsOverride.mockReset()
  slashCommandsCreateRule.mockReset()
  resolveWrites.mockReset()
  loadRun.mockReset()
  loadRunEvents.mockReset()

  setWorkspaceSettingsOverride.mockImplementation(
    async (path: string, override: WorkspacesState['settingsOverridesByPath'][string]) => {
      state.settingsOverridesByPath = {
        ...state.settingsOverridesByPath,
        [path]: override
      }
      return { ok: true as const, data: { ...state } }
    }
  )
  slashCommandsCreateRule.mockResolvedValue({
    ok: true as const,
    data: { path: `${WS_B}/.vyotiq/rules/pane-b.md`, relativePath: '.vyotiq/rules/pane-b.md' }
  })
  resolveWrites.mockResolvedValue({
    ok: true as const,
    data: {
      checkpointId: 'cp-b',
      kept: [],
      discarded: ['b.ts'],
      skipped: [],
      fullyResolved: true
    }
  })
  loadRun.mockImplementation(async (_path: string, runId: string) => ({
    ok: true as const,
    data: { runId, messages: [{ role: 'user' as const, content: `hello ${runId}` }] }
  }))
  loadRunEvents.mockImplementation(async (_path: string, runId: string) => ({
    ok: true as const,
    data:
      runId === RUN_A
        ? [checkpointEvent(RUN_A, 'cp-a', 'a.ts')]
        : runId === RUN_B
          ? [checkpointEvent(RUN_B, 'cp-b', 'b.ts')]
          : []
  }))

  // @ts-expect-error test bridge
  window.vyotiq = {
    getSettings: vi.fn(async () => ({
      ok: true as const,
      data: { ...DEFAULT_SETTINGS, navigationMode: 'sidebar' as const }
    })),
    secretStatus: vi.fn(async () => ({
      ok: true as const,
      data: { keys: emptySecretStatus(), encryptionAvailable: true }
    })),
    setSettings: vi.fn(async (partial: Partial<typeof DEFAULT_SETTINGS>) => ({
      ok: true as const,
      data: { ...DEFAULT_SETTINGS, ...partial }
    })),
    getWorkspaces: vi.fn(async () => ({ ok: true as const, data: state })),
    listRuns: vi.fn(async (path: string) => ({
      ok: true as const,
      data: {
        runs: [
          {
            runId: path === WS_A ? RUN_A : RUN_B,
            status: 'done' as const,
            updatedAt: new Date().toISOString(),
            goal: path === WS_A ? 'Workspace A' : 'Workspace B'
          }
        ],
        capped: false
      }
    })),
    listActiveRuns: vi.fn(async () => ({ ok: true as const, data: [] })),
    loadRun,
    loadRunEvents,
    updateWorkspaceUiState: vi.fn(async () => ({ ok: true as const, data: true })),
    setWorkspaceSettingsOverride,
    slashCommandsCreateRule,
    resolveWrites,
    onChatEvent: vi.fn(() => () => {}),
    probeNetwork: vi.fn(async () => ({ ok: true as const, data: true }))
  }
})

afterEach(() => {
  harness.columns.clear()
  resetWorkspaceHotUiStoreForTests()
  try {
    localStorage.removeItem(CHAT_PANE_LAYOUT_KEY)
  } catch {
    /* ignore */
  }
})

async function renderTwoPanes(): Promise<{
  paneB: NonNullable<ReturnType<typeof harness.columns.get>>
}> {
  render(<App />)
  await waitFor(() => {
    expect(harness.columns.get(WS_B)).toBeTruthy()
    expect(harness.columns.get(WS_A)).toBeTruthy()
  })
  await waitFor(() => {
    expect(loadRunEvents).toHaveBeenCalledWith(WS_B, RUN_B)
    expect(harness.columns.get(WS_B)?.transcriptLoading).toBe(false)
  })
  const paneB = harness.columns.get(WS_B)
  expect(paneB).toBeTruthy()
  return { paneB: paneB! }
}

describe('App pane identity wiring', () => {
  it('settings mutation from pane B uses pane B workspace, not registry-active', async () => {
    const { paneB } = await renderTwoPanes()

    await act(async () => {
      paneB.onChatSettingsChange({ showThinking: true })
    })

    expect(setWorkspaceSettingsOverride).toHaveBeenCalledWith(
      WS_B,
      expect.objectContaining({ useOverride: true, showThinking: true })
    )
    expect(setWorkspaceSettingsOverride).not.toHaveBeenCalledWith(WS_A, expect.anything())
  })

  it('slash create-rule from pane B writes pane B workspacePath', async () => {
    const { paneB } = await renderTwoPanes()
    expect(paneB.slashHandlers).toBeTruthy()

    await act(async () => {
      await executeSlashResolveResult(
        { action: 'client', clientAction: 'create_rule', trailingText: 'pane-b-rule' },
        paneB.slashHandlers!
      )
    })

    expect(slashCommandsCreateRule).toHaveBeenCalledWith({
      workspacePath: WS_B,
      title: 'pane-b-rule'
    })
    expect(slashCommandsCreateRule).not.toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: WS_A })
    )
  })

  it('slash undo from pane B uses pane B workspacePath + runId checkpoint', async () => {
    const { paneB } = await renderTwoPanes()
    expect(paneB.slashHandlers).toBeTruthy()

    await act(async () => {
      await executeSlashResolveResult(
        { action: 'client', clientAction: 'undo_writes' },
        paneB.slashHandlers!
      )
    })

    expect(resolveWrites).toHaveBeenCalledWith({
      workspacePath: WS_B,
      runId: RUN_B,
      checkpointId: 'cp-b',
      action: 'discard'
    })
    expect(resolveWrites).not.toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: WS_A })
    )
    expect(resolveWrites).not.toHaveBeenCalledWith(expect.objectContaining({ runId: RUN_A }))
  })
})
