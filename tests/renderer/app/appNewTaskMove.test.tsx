/**
 * @vitest-environment jsdom
 *
 * App → New task "in" another workspace: the brief goes with it whole (text,
 * checks, extra folders, worktree, attachments) and leaves the one it came
 * from empty. A target with an unsent brief of its own asks before replacing.
 * Opening the draft New task is already continuing keeps the edits made since.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_SETTINGS, emptySecretStatus, type Settings, type WorkspacesState } from '@shared/ipc'
import App from '@renderer/app/App'
import {
  getWorkspaceHotUi,
  resetWorkspaceHotUiStoreForTests,
  resolveHotComposerDraft,
  setWorkspaceHotComposerDraft
} from '@renderer/lib/hooks/workspaceHotUiStore'
import {
  clearComposerAttachments,
  composerAttachmentKey,
  getComposerAttachments
} from '@renderer/lib/hooks/composerAttachmentStore'
import { briefStateFor, requestOpenTaskDraft, setBriefState } from '@renderer/lib/drafts/taskDraftStore'
import type { MovedBrief, NewTaskTargets } from '@renderer/features/task/NewTaskBrief'

type ChatProps = {
  multiPane?: {
    renderPane: (pane: { paneId: string; workspacePath: string; runId: string | null }, options: object) => ReactNode
  }
}
const seen = vi.hoisted(() => ({ chat: null as unknown }))

vi.mock('@renderer/app/AppShell', () => ({
  AppShell: (props: { children: ReactNode }) => <div data-testid="shell">{props.children}</div>
}))
vi.mock('@renderer/features/settings', () => ({ SettingsView: () => null }))
vi.mock('@renderer/features/marketplace', () => ({ MarketplaceView: () => null }))
vi.mock('@renderer/features/home/HomePage', () => ({ HomePage: () => null }))
vi.mock('@renderer/features/chat/ChatView', () => ({
  ChatView: (props: ChatProps) => {
    seen.chat = props
    return <div data-testid="chat" />
  }
}))
vi.mock('@renderer/features/chat/SessionChatColumn', () => ({ SessionChatColumn: () => null }))

const A = '/ws-a'
const B = '/ws-b'

function registry(): WorkspacesState {
  const ui = {
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
  return {
    version: 2,
    workspaceIdsByPath: {},
    legacySessionsMigrated: true,
    openPaths: [A, B],
    activePath: A,
    recentPaths: [B, A],
    uiStateByPath: { [A]: ui, [B]: { ...ui } },
    settingsOverridesByPath: {}
  }
}

function install(): void {
  const settings: Settings = { ...DEFAULT_SETTINGS, toolApprovalOnboardingDone: true, navigationMode: 'sidebar' }
  const state = registry()
  window.vyotiq = {
    getSettings: vi.fn(async () => ({ ok: true as const, data: settings })),
    secretStatus: vi.fn(async () => ({ ok: true as const, data: { keys: emptySecretStatus(), encryptionAvailable: true } })),
    setSettings: vi.fn(async () => ({ ok: true as const, data: settings })),
    getWorkspaces: vi.fn(async () => ({ ok: true as const, data: state })),
    getHomeWorkspacePath: vi.fn(async () => ({ ok: true as const, data: '/userData/home' })),
    listRuns: vi.fn(async () => ({ ok: true as const, data: { runs: [], capped: false } })),
    listActiveRuns: vi.fn(async () => ({ ok: true as const, data: [] })),
    loadRun: vi.fn(async () => ({ ok: true as const, data: { runId: 'x', messages: [] } })),
    loadRunEvents: vi.fn(async () => ({ ok: true as const, data: [] })),
    updateWorkspaceUiState: vi.fn(async () => ({ ok: true as const, data: true })),
    setActiveWorkspace: vi.fn(async (path: string) => ({ ok: true as const, data: { ...state, activePath: path } })),
    listModels: vi.fn(async () => ({ ok: true as const, data: { models: [] } })),
    onChatEvent: vi.fn(() => () => {}),
    probeNetwork: vi.fn(async () => ({ ok: true as const, data: true })),
    chatStart: vi.fn()
  } as unknown as typeof window.vyotiq
}

async function targets(): Promise<NewTaskTargets> {
  await waitFor(() => expect((seen.chat as ChatProps | null)?.multiPane).toBeTruthy(), { timeout: 5000 })
  const el = (seen.chat as ChatProps).multiPane!.renderPane({ paneId: 'p1', workspacePath: A, runId: null }, {
    focused: true,
    multi: false
  }) as ReactElement<{ newTaskTargets: NewTaskTargets }>
  return el.props.newTaskTargets
}

const brief = (text: string): MovedBrief => ({
  text,
  checks: ['Tests pass'],
  extraRoots: ['/shared/lib'],
  worktree: true,
  attachments: { images: ['data:image/png;base64,AAAA'], files: [], nativeFiles: [], audio: [] }
})

beforeEach(() => {
  resetWorkspaceHotUiStoreForTests()
  setBriefState(A, null)
  setBriefState(B, null)
  seen.chat = null
  install()
})

afterEach(() => {
  cleanup()
  for (const p of [A, B]) {
    const key = composerAttachmentKey(p, null)
    if (key) clearComposerAttachments(key)
  }
  resetWorkspaceHotUiStoreForTests()
})

describe('App → moving a New task brief to another workspace', () => {
  it('moves the whole brief and leaves the first workspace empty', async () => {
    render(<App />)
    const t = await targets()
    expect(t.workspaces.map((w) => w.path)).toEqual(expect.arrayContaining([A, B]))

    let moved = false
    await act(async () => {
      moved = await t.onMove(A, B, brief('Bump the shared lib'))
    })
    expect(moved).toBe(true)
    expect(resolveHotComposerDraft(getWorkspaceHotUi(B), null)).toBe('Bump the shared lib')
    expect(briefStateFor(B)).toMatchObject({ checks: ['Tests pass'], extraRoots: ['/shared/lib'], worktree: true, draftId: null })
    expect(getComposerAttachments(composerAttachmentKey(B, null)).images).toEqual(['data:image/png;base64,AAAA'])
    expect(resolveHotComposerDraft(getWorkspaceHotUi(A), null)).toBe('')
    expect(briefStateFor(A).checks).toEqual([])
    expect(getComposerAttachments(composerAttachmentKey(A, null)).images).toEqual([])
  })

  it('asks before replacing an unsent brief there, and keeps it on Cancel', async () => {
    render(<App />)
    const t = await targets()
    act(() => setWorkspaceHotComposerDraft(B, null, 'Already here'))

    let result: Promise<boolean> = Promise.resolve(false)
    act(() => {
      result = t.onMove(A, B, brief('Mine'))
    })
    const dialog = await screen.findByRole('dialog', {}, { timeout: 5000 })
    expect(dialog.textContent).toContain('Replace the brief in ws-b?')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => {
      expect(await result).toBe(false)
    })
    expect(resolveHotComposerDraft(getWorkspaceHotUi(B), null)).toBe('Already here')

    act(() => {
      result = t.onMove(A, B, brief('Mine'))
    })
    await screen.findByRole('dialog', {}, { timeout: 5000 })
    fireEvent.click(screen.getByRole('button', { name: 'Replace and move' }))
    await act(async () => {
      expect(await result).toBe(true)
    })
    expect(resolveHotComposerDraft(getWorkspaceHotUi(B), null)).toBe('Mine')
  })
})

describe('App → opening a draft', () => {
  it('re-opening the draft you are editing keeps your edits and asks nothing (B1)', async () => {
    render(<App />)
    await targets()
    const draft = {
      id: 'd0000000-0000-4000-8000-000000000021',
      brief: 'Saved copy',
      doneWhen: ['Saved check'],
      createdAt: '2026-10-01T10:00:00Z',
      updatedAt: '2026-10-01T10:00:00Z'
    }
    await act(async () => {
      requestOpenTaskDraft(A, draft)
    })
    await waitFor(() => expect(briefStateFor(A).draftId).toBe(draft.id))
    expect(resolveHotComposerDraft(getWorkspaceHotUi(A), null)).toBe('Saved copy')

    act(() => {
      setWorkspaceHotComposerDraft(A, null, 'Saved copy, edited')
      setBriefState(A, { ...briefStateFor(A), checks: ['Saved check', 'New check'] })
    })
    await act(async () => {
      requestOpenTaskDraft(A, draft)
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(resolveHotComposerDraft(getWorkspaceHotUi(A), null)).toBe('Saved copy, edited')
    expect(briefStateFor(A).checks).toEqual(['Saved check', 'New check'])
  })
})
