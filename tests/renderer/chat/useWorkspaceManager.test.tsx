/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import {
  useWorkspaceManager,
  WORKSPACE_MANAGER_LIMITS,
  pruneScrollTopByRunId,
  omitRunScrollTop,
  reconcileOpenRunIds,
  resolveComposerDraft,
  omitRunComposerDraft,
  migrateLegacyComposerDraftMap
} from '@renderer/lib/hooks/useWorkspaceManager'
import {
  getWorkspaceHotUi,
  resolveHotComposerDraft,
  resetWorkspaceHotUiStoreForTests
} from '@renderer/lib/hooks/workspaceHotUiStore'
import type { AgentEvent, WorkspacesState } from '@shared/ipc'

type Handler = (event: AgentEvent) => void

function defaultRegistry(overrides: Partial<WorkspacesState> = {}): WorkspacesState {
  return {
    version: 2,
    workspaceIdsByPath: {},
    legacySessionsMigrated: true,
    openPaths: ['/ws-a', '/ws-b'],
    activePath: '/ws-a',
    recentPaths: [],
    uiStateByPath: {
      '/ws-a': {
        activeRunId: null,
        openRunIds: [],
        scrollTop: 0,
        scrollTopByRunId: {},
        composerDraft: ''
      },
      '/ws-b': {
        activeRunId: null,
        openRunIds: [],
        scrollTop: 0,
        scrollTopByRunId: {},
        composerDraft: ''
      }
    },
    settingsOverridesByPath: {},
    ...overrides
  }
}

describe('useWorkspaceManager', () => {
  let handler: Handler | null = null
  const chatStart = vi.fn()
  const chatCancel = vi.fn()
  const chatUiSubscribe = vi.fn()
  const getWorkspaces = vi.fn()
  const listRuns = vi.fn()
  const listOlderRuns = vi.fn()
  const listActiveRuns = vi.fn()
  const setActiveWorkspace = vi.fn()
  const removeWorkspace = vi.fn()
  const updateWorkspaceUiState = vi.fn()
  const loadRun = vi.fn()
  const loadRunEvents = vi.fn()

  beforeEach(() => {
    handler = null
    resetWorkspaceHotUiStoreForTests()
    try {
      localStorage.removeItem('vyotiq.chatPaneLayout')
    } catch {
      /* ignore */
    }
    chatStart.mockReset()
    chatCancel.mockReset()
    chatUiSubscribe.mockReset()
    chatUiSubscribe.mockResolvedValue({ ok: true, data: true })
    getWorkspaces.mockReset()
    listRuns.mockReset()
    listOlderRuns.mockReset()
    listActiveRuns.mockReset()
    setActiveWorkspace.mockReset()
    removeWorkspace.mockReset()
    updateWorkspaceUiState.mockReset()
    loadRun.mockReset()
    loadRunEvents.mockReset()

    chatStart.mockResolvedValue({ ok: true, data: { runId: 'run-1', invokeId: 1 } })
    chatCancel.mockResolvedValue({ ok: true, data: true })
    getWorkspaces.mockResolvedValue({ ok: true, data: defaultRegistry() })
    listRuns.mockResolvedValue({ ok: true, data: { runs: [], capped: false } })
    listOlderRuns.mockResolvedValue({ ok: true, data: { runs: [], hasMore: false } })
    listActiveRuns.mockResolvedValue({ ok: true, data: [] })
    updateWorkspaceUiState.mockResolvedValue({ ok: true, data: true })
    loadRun.mockResolvedValue({
      ok: true,
      data: { runId: 'run-restored', messages: [{ role: 'user', content: 'hello' }] }
    })
    loadRunEvents.mockResolvedValue({ ok: true, data: [] })
    setActiveWorkspace.mockImplementation(async (path: string) => ({
      ok: true,
      data: defaultRegistry({ activePath: path })
    }))
    removeWorkspace.mockImplementation(async (path: string, _stopActiveRuns?: boolean) => ({
      ok: true,
      data: defaultRegistry({
        openPaths: ['/ws-a', '/ws-b'].filter((p) => p !== path),
        activePath: path === '/ws-a' ? '/ws-b' : '/ws-a'
      })
    }))

    // @ts-expect-error test bridge
    window.vyotiq = {
      chatStart,
      chatCancel,
      chatUiSubscribe,
      getWorkspaces,
      listRuns,
      listOlderRuns,
      listActiveRuns,
      setActiveWorkspace,
      removeWorkspace,
      updateWorkspaceUiState,
      loadRun,
      loadRunEvents,
      onChatEvent: (h: Handler) => {
        handler = h
        return () => {
          handler = null
        }
      }
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads registry and exposes active workspace context', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })
    expect(result.current.openWorkspaces).toEqual(['/ws-a', '/ws-b'])
    expect(result.current.activeContext?.path).toBe('/ws-a')
  })

  it('routes chat events to the correct workspace controller', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })

    chatStart.mockResolvedValueOnce({ ok: true, data: { runId: 'run-a' } })

    await act(async () => {
      await result.current.chatActions?.send('hello from a')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-a', status: 'running' })
      handler?.({ type: 'text_delta', runId: 'run-a', text: 'Hi A' })
      handler?.({ type: 'assistant_message', runId: 'run-a', content: 'Hi A' })
      handler?.({ type: 'status', runId: 'run-a', status: 'done' })
    })

    expect(result.current.chat.items.some((i) => i.kind === 'message' && i.content === 'Hi A')).toBe(
      true
    )

    await act(async () => {
      await result.current.switchWorkspace('/ws-b')
    })

    chatStart.mockResolvedValueOnce({ ok: true, data: { runId: 'run-b' } })

    await act(async () => {
      await result.current.chatActions?.send('hello from b')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-b', status: 'running' })
      handler?.({ type: 'text_delta', runId: 'run-b', text: 'Hi B' })
      handler?.({ type: 'assistant_message', runId: 'run-b', content: 'Hi B' })
      handler?.({ type: 'status', runId: 'run-b', status: 'done' })
    })

    expect(result.current.chat.items.some((i) => i.kind === 'message' && i.content === 'Hi B')).toBe(
      true
    )

    await act(async () => {
      await result.current.switchWorkspace('/ws-a')
    })

    expect(
      result.current.chat.items.some((i) => i.kind === 'message' && i.content === 'Hi A')
    ).toBe(true)
    expect(
      result.current.chat.items.some((i) => i.kind === 'message' && i.content === 'Hi B')
    ).toBe(false)
  })

  it('opens a run under a different workspace and switches active path', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })

    await act(async () => {
      await result.current.openRunInWorkspace('/ws-b', 'run-b-123')
    })

    expect(setActiveWorkspace).toHaveBeenCalledWith('/ws-b')
    expect(result.current.activeWorkspace).toBe('/ws-b')
    expect(result.current.activeContext?.activeRunId).toBe('run-b-123')
    expect(result.current.activeContext?.openRunIds).toContain('run-b-123')
  })

  it('multi-pane click focuses existing session without duplicating', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
      expect(result.current.paneLayout?.panes.length).toBe(1)
    })

    const anchorPaneId = result.current.paneLayout!.panes[0]!.paneId

    await act(async () => {
      result.current.openRunTab('run-a')
    })
    await act(async () => {
      const ok = result.current.dropSessionOnPane(anchorPaneId, 'right', {
        workspacePath: '/ws-b',
        runId: 'run-b'
      })
      expect(ok).toBe(true)
    })

    await waitFor(() => {
      expect(result.current.paneLayout?.panes).toHaveLength(2)
    })

    const focusedBefore = result.current.paneLayout!.focusedPaneId
    const paneShowingB = result.current.paneLayout!.panes.find((p) => p.runId === 'run-b')
    expect(paneShowingB).toBeTruthy()
    expect(focusedBefore).toBe(paneShowingB!.paneId)

    // Focus the other pane, then click the already-open B session from the sidebar path.
    const paneShowingA = result.current.paneLayout!.panes.find((p) => p.runId === 'run-a')
    expect(paneShowingA).toBeTruthy()
    await act(async () => {
      result.current.focusPaneById(paneShowingA!.paneId)
    })
    expect(result.current.paneLayout!.focusedPaneId).toBe(paneShowingA!.paneId)

    await act(async () => {
      await result.current.openRunInWorkspace('/ws-b', 'run-b')
    })

    expect(result.current.paneLayout?.panes).toHaveLength(2)
    expect(result.current.paneLayout?.panes.filter((p) => p.runId === 'run-b')).toHaveLength(1)
    expect(result.current.paneLayout?.focusedPaneId).toBe(paneShowingB!.paneId)
  })

  it('setAgentMode with workspacePath updates that workspace, not the focused pane', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
      expect(result.current.paneLayout?.panes.length).toBe(1)
    })

    const anchorPaneId = result.current.paneLayout!.panes[0]!.paneId
    await act(async () => {
      result.current.openRunTab('run-a')
    })
    await act(async () => {
      result.current.dropSessionOnPane(anchorPaneId, 'right', {
        workspacePath: '/ws-b',
        runId: 'run-b'
      })
    })
    await waitFor(() => {
      expect(result.current.paneLayout?.panes).toHaveLength(2)
    })

    const paneB = result.current.paneLayout!.panes.find((p) => p.runId === 'run-b')
    expect(paneB).toBeTruthy()
    expect(result.current.paneLayout!.focusedPaneId).toBe(paneB!.paneId)

    await act(async () => {
      result.current.setAgentMode('ask', { workspacePath: '/ws-a', runId: 'run-a' })
    })

    expect(result.current.contexts['/ws-a']?.ui.agentMode).toBe('ask')
    expect(result.current.contexts['/ws-b']?.ui.agentMode).toBe('agent')
  })

  it('queues mode on a live run unless syncOnly (switch_mode echo)', async () => {
    const chatQueueMode = vi.fn().mockResolvedValue({ ok: true, data: true })
    window.vyotiq.chatQueueMode = chatQueueMode

    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })

    chatStart.mockResolvedValueOnce({ ok: true, data: { runId: 'run-live', invokeId: 1 } })
    await act(async () => {
      await result.current.chatActions?.send('go')
    })
    await act(async () => {
      handler?.({ type: 'status', runId: 'run-live', status: 'running' })
    })
    expect(result.current.chat.running).toBe(true)

    await act(async () => {
      result.current.setAgentMode('plan', { workspacePath: '/ws-a', runId: 'run-live' })
    })
    expect(chatQueueMode).toHaveBeenCalledWith({ runId: 'run-live', mode: 'plan' })
    expect(result.current.contexts['/ws-a']?.ui.agentMode).toBe('plan')

    chatQueueMode.mockClear()
    await act(async () => {
      result.current.setAgentMode('agent', {
        workspacePath: '/ws-a',
        runId: 'run-live',
        syncOnly: true
      })
    })
    expect(chatQueueMode).not.toHaveBeenCalled()
    expect(result.current.contexts['/ws-a']?.ui.agentMode).toBe('agent')
  })

  it('openNewChatInPane clears only that pane session', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.paneLayout?.panes.length).toBe(1)
    })
    const anchorPaneId = result.current.paneLayout!.panes[0]!.paneId
    await act(async () => {
      result.current.openRunTab('run-a')
    })
    await act(async () => {
      result.current.dropSessionOnPane(anchorPaneId, 'right', {
        workspacePath: '/ws-b',
        runId: 'run-b'
      })
    })
    await waitFor(() => {
      expect(result.current.paneLayout?.panes).toHaveLength(2)
    })
    const paneA = result.current.paneLayout!.panes.find((p) => p.runId === 'run-a')
    expect(paneA).toBeTruthy()

    await act(async () => {
      result.current.openNewChatInPane(paneA!.paneId)
    })

    const after = result.current.paneLayout!.panes
    expect(after.find((p) => p.paneId === paneA!.paneId)?.runId).toBeNull()
    expect(after.find((p) => p.runId === 'run-b')).toBeTruthy()
  })

  it('removes closed-workspace panes when workspace is removed', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
      expect(result.current.paneLayout?.panes.length).toBe(1)
    })

    const anchorPaneId = result.current.paneLayout!.panes[0]!.paneId
    await act(async () => {
      result.current.openRunTab('run-a')
    })
    await act(async () => {
      expect(
        result.current.dropSessionOnPane(anchorPaneId, 'right', {
          workspacePath: '/ws-b',
          runId: 'run-b'
        })
      ).toBe(true)
    })
    await waitFor(() => {
      expect(result.current.paneLayout?.panes).toHaveLength(2)
    })

    await act(async () => {
      await result.current.removeWorkspace('/ws-a')
    })

    await waitFor(() => {
      expect(result.current.paneLayout?.panes).toHaveLength(1)
    })
    expect(result.current.paneLayout?.panes[0]?.workspacePath).toBe('/ws-b')
    expect(result.current.paneLayout?.panes[0]?.runId).toBe('run-b')
  })

  it('refreshes workspace runs when activeRuns poll drops a finished background run', async () => {
    listActiveRuns.mockResolvedValue({
      ok: true,
      data: [{ runId: 'run-bg', workspacePath: '/ws-a' }]
    })

    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })

    listRuns.mockClear()
    listActiveRuns.mockResolvedValue({ ok: true, data: [] })

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })

    await waitFor(() => {
      expect(listRuns.mock.calls.some((call) => call[0] === '/ws-a')).toBe(true)
    })
  })

  it('stops active runs and forgets routing when workspace is removed', async () => {
    listActiveRuns.mockResolvedValue({
      ok: true,
      data: [{ runId: 'run-bg', workspacePath: '/ws-a', invokeId: 3 }]
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })

    chatStart.mockResolvedValueOnce({ ok: true, data: { runId: 'run-bg' } })

    await act(async () => {
      await result.current.chatActions?.send('background me')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-bg', status: 'running' })
    })

    expect(result.current.chat.running).toBe(true)

    await act(async () => {
      await result.current.removeWorkspace('/ws-a')
    })

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-b')
    })

    await act(async () => {
      handler?.({ type: 'text_delta', runId: 'run-bg', text: 'still going' })
    })

    expect(removeWorkspace).toHaveBeenCalledWith('/ws-a', true, undefined)
    expect(confirm).not.toHaveBeenCalled()
    expect(result.current.isRunActiveInBackground('run-bg')).toBe(false)
    confirm.mockRestore()
  })

  it('moves running run to background when run tab is closed', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })

    chatStart.mockResolvedValueOnce({ ok: true, data: { runId: 'run-tab' } })

    await act(async () => {
      await result.current.chatActions?.send('tab run')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-tab', status: 'running' })
    })

    await act(async () => {
      result.current.openRunTab('run-tab')
    })

    await act(async () => {
      result.current.closeRunTab('run-tab')
    })

    expect(result.current.isRunActiveInBackground('run-tab')).toBe(true)
    expect(chatCancel).not.toHaveBeenCalled()

    const itemsBefore = result.current.getRunController('run-tab')?.items.length ?? 0

    await act(async () => {
      handler?.({ type: 'text_delta', runId: 'run-tab', text: 'bg' })
    })

    // Suspended background runs ignore stream deltas (agent keeps running in main).
    expect(result.current.getRunController('run-tab')?.items.length ?? 0).toBe(itemsBefore)
  })

  it('restores ui state and loads active run transcript on mount', async () => {
    getWorkspaces.mockResolvedValue({
      ok: true,
      data: defaultRegistry({
        uiStateByPath: {
          '/ws-a': {
            activeRunId: 'run-restored',
            openRunIds: ['run-other', 'run-restored'],
            scrollTop: 240,
            scrollTopByRunId: { 'run-restored': 240 },
            composerDraft: 'draft text'
          },
          '/ws-b': {
            activeRunId: null,
            openRunIds: [],
            scrollTop: 0,
            scrollTopByRunId: {},
            composerDraft: ''
          }
        }
      })
    })

    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeContext?.activeRunId).toBe('run-restored')
    })

    expect(result.current.activeContext?.openRunIds).toEqual(['run-other', 'run-restored'])
    expect(result.current.activeContext?.ui.composerDraft).toBe('draft text')
    expect(result.current.activeContext?.ui.scrollTop).toBe(240)
    expect(result.current.activeScrollTop).toBe(240)
    expect(result.current.scrollRestoreToken).toBeGreaterThan(0)

    await waitFor(() => {
      expect(loadRun).toHaveBeenCalledWith('/ws-a', 'run-restored')
    })
  })

  it('debounces ui state persistence on draft and run tab changes', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })

    vi.useFakeTimers()

    act(() => {
      result.current.setComposerDraft('hello')
    })

    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(updateWorkspaceUiState).toHaveBeenCalledWith(
      '/ws-a',
      expect.objectContaining({
        activeRunId: null,
        openRunIds: [],
        scrollTop: 0,
        scrollTopByRunId: {},
        composerDraft: 'hello',
        agentMode: 'agent'
      })
    )

    updateWorkspaceUiState.mockClear()

    act(() => {
      result.current.openRunTab('run-tab-a')
    })

    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(updateWorkspaceUiState).toHaveBeenCalledWith(
      '/ws-a',
      expect.objectContaining({
        activeRunId: 'run-tab-a',
        openRunIds: ['run-tab-a']
      })
    )

    vi.useRealTimers()
  })

  it('reattaches active runs from listActiveRuns on mount', async () => {
    getWorkspaces.mockResolvedValue({
      ok: true,
      data: defaultRegistry({
        uiStateByPath: {
          '/ws-a': {
            activeRunId: 'run-live',
            openRunIds: ['run-live'],
            scrollTop: 0,
            scrollTopByRunId: {},
            composerDraft: ''
          },
          '/ws-b': {
            activeRunId: null,
            openRunIds: [],
            scrollTop: 0,
            scrollTopByRunId: {},
            composerDraft: ''
          }
        }
      })
    })
    listActiveRuns.mockResolvedValue({
      ok: true,
      data: [{ runId: 'run-live', workspacePath: '/ws-a', invokeId: 7 }]
    })
    loadRun.mockResolvedValue({
      ok: true,
      data: {
        runId: 'run-live',
        messages: [
          { role: 'user', content: 'still running' },
          { role: 'assistant', content: 'partial' }
        ]
      }
    })

    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeRuns).toEqual([
        { runId: 'run-live', workspacePath: '/ws-a', invokeId: 7 }
      ])
    })

    expect(loadRun).toHaveBeenCalledWith('/ws-a', 'run-live')
    const ctrl = result.current.getRunController('run-live')
    expect(ctrl?.running).toBe(true)
    expect(ctrl?.runId).toBe('run-live')
    expect(ctrl?.items.some((i) => i.kind === 'message' && i.content === 'partial')).toBe(true)
  })

  it('does not hydrate hidden instance runs from listActiveRuns', async () => {
    getWorkspaces.mockResolvedValue({
      ok: true,
      data: defaultRegistry({
        uiStateByPath: {
          '/ws-a': {
            activeRunId: 'run-parent',
            openRunIds: ['run-parent'],
            scrollTop: 0,
            scrollTopByRunId: {},
            composerDraft: ''
          },
          '/ws-b': {
            activeRunId: null,
            openRunIds: [],
            scrollTop: 0,
            scrollTopByRunId: {},
            composerDraft: ''
          }
        }
      })
    })
    listActiveRuns.mockResolvedValue({
      ok: true,
      data: [
        { runId: 'run-parent', workspacePath: '/ws-a', invokeId: 1 },
        { runId: 'run-child', workspacePath: '/ws-a', invokeId: 2 }
      ]
    })
    loadRun.mockResolvedValue({
      ok: true,
      data: { runId: 'run-parent', messages: [{ role: 'user', content: 'go' }] }
    })

    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeRuns.map((r) => r.runId).sort()).toEqual([
        'run-child',
        'run-parent'
      ])
    })

    expect(loadRun).toHaveBeenCalledWith('/ws-a', 'run-parent')
    expect(loadRun).not.toHaveBeenCalledWith('/ws-a', 'run-child')
  })

  it('subscribes token streams for every open instance pane', async () => {
    getWorkspaces.mockResolvedValue({
      ok: true,
      data: defaultRegistry({
        uiStateByPath: {
          '/ws-a': {
            activeRunId: 'run-parent',
            openRunIds: ['run-parent'],
            scrollTop: 0,
            scrollTopByRunId: {},
            composerDraft: ''
          },
          '/ws-b': {
            activeRunId: null,
            openRunIds: [],
            scrollTop: 0,
            scrollTopByRunId: {},
            composerDraft: ''
          }
        }
      })
    })
    listActiveRuns.mockResolvedValue({
      ok: true,
      data: [
        { runId: 'run-parent', workspacePath: '/ws-a', invokeId: 1 },
        { runId: 'run-child-a', workspacePath: '/ws-a', invokeId: 2 },
        { runId: 'run-child-b', workspacePath: '/ws-a', invokeId: 3 }
      ]
    })
    loadRun.mockResolvedValue({
      ok: true,
      data: { runId: 'run-parent', messages: [{ role: 'user', content: 'go' }] }
    })

    const { result } = renderHook(() =>
      useWorkspaceManager({ openInstanceRunIds: ['run-child-a', 'run-child-b'] })
    )

    await waitFor(() => {
      expect(chatUiSubscribe).toHaveBeenCalled()
    })

    const subscribed = chatUiSubscribe.mock.calls.map((call) => call[0]?.runIds as string[])
    const last = subscribed[subscribed.length - 1] ?? []
    expect(last).toEqual(expect.arrayContaining(['run-child-a', 'run-child-b', 'run-parent']))
  })

  it('does not demux buffered events to the wrong workspace before run id mapping', async () => {
    let resolveA: (value: { ok: true; data: { runId: string } }) => void = () => {}
    let resolveB: (value: { ok: true; data: { runId: string } }) => void = () => {}
    const pendingA = new Promise<{ ok: true; data: { runId: string } }>((r) => {
      resolveA = r
    })
    const pendingB = new Promise<{ ok: true; data: { runId: string } }>((r) => {
      resolveB = r
    })

    chatStart
      .mockImplementationOnce(() => pendingA)
      .mockImplementationOnce(() => pendingB)
    loadRun.mockImplementation(async (_ws: string, runId: string) => ({
      ok: true as const,
      data: {
        runId,
        messages:
          runId === 'run-b'
            ? [
                { role: 'user', content: 'hello from b' },
                { role: 'assistant', content: 'Hi B' }
              ]
            : [{ role: 'user', content: 'hello' }]
      }
    }))

    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })

    await act(async () => {
      void result.current.chatActions?.send('hello from a')
    })

    await act(async () => {
      await result.current.switchWorkspace('/ws-b')
    })

    await act(async () => {
      void result.current.chatActions?.send('hello from b')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-b', status: 'running' })
      handler?.({ type: 'text_delta', runId: 'run-b', text: 'Hi B' })
      handler?.({ type: 'assistant_message', runId: 'run-b', content: 'Hi B' })
    })

    await act(async () => {
      resolveB({ ok: true, data: { runId: 'run-b' } })
      await pendingB
    })

    await act(async () => {
      await result.current.switchWorkspace('/ws-a')
    })

    expect(
      result.current.chat.items.some((i) => i.kind === 'message' && i.content === 'Hi B')
    ).toBe(false)

    await act(async () => {
      resolveA({ ok: true, data: { runId: 'run-a' } })
      await pendingA
      handler?.({ type: 'status', runId: 'run-a', status: 'running' })
      handler?.({ type: 'text_delta', runId: 'run-a', text: 'Hi A' })
      handler?.({ type: 'assistant_message', runId: 'run-a', content: 'Hi A' })
      handler?.({ type: 'status', runId: 'run-a', status: 'done' })
    })

    expect(
      result.current.chat.items.some((i) => i.kind === 'message' && i.content === 'Hi A')
    ).toBe(true)

    await act(async () => {
      await result.current.switchWorkspace('/ws-b')
    })

    expect(
      result.current.chat.items.some((i) => i.kind === 'message' && i.content === 'Hi B')
    ).toBe(true)
  })

  it('persists scroll position per run tab', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })

    vi.useFakeTimers()

    act(() => {
      result.current.openRunTab('run-tab-a')
      result.current.onMessageListScroll(120)
    })

    act(() => {
      result.current.openRunTab('run-tab-b')
      result.current.onMessageListScroll(360)
    })

    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(updateWorkspaceUiState).toHaveBeenLastCalledWith(
      '/ws-a',
      expect.objectContaining({
        activeRunId: 'run-tab-b',
        scrollTop: 360,
        scrollTopByRunId: expect.objectContaining({
          'run-tab-a': 120,
          'run-tab-b': 360
        })
      })
    )

    act(() => {
      result.current.openRunTab('run-tab-a')
    })

    expect(result.current.activeScrollTop).toBe(120)

    vi.useRealTimers()
  })

  it('bumps chat surface epoch on workspace and run tab switches', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })

    const initialEpoch = result.current.chatSurfaceEpoch
    const initialToken = result.current.scrollRestoreToken

    await act(async () => {
      await result.current.switchWorkspace('/ws-b')
    })

    expect(result.current.chatSurfaceEpoch).toBeGreaterThan(initialEpoch)
    expect(result.current.scrollRestoreToken).toBeGreaterThan(initialToken)

    const afterSwitch = result.current.chatSurfaceEpoch

    act(() => {
      result.current.openRunTab('run-tab-a')
    })

    expect(result.current.chatSurfaceEpoch).toBeGreaterThan(afterSwitch)
  })

  it('does not duplicate open run tab on follow-up', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })

    chatStart.mockResolvedValueOnce({ ok: true, data: { runId: 'run-a' } })

    await act(async () => {
      await result.current.chatActions?.send('first')
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-a', status: 'done' })
    })

    expect(result.current.activeContext?.openRunIds).toEqual(['run-a'])
    expect(result.current.activeContext?.activeRunId).toBe('run-a')

    chatStart.mockResolvedValueOnce({ ok: true, data: { runId: 'run-a' } })

    await act(async () => {
      await result.current.chatActions?.send('follow up')
    })

    expect(result.current.activeContext?.openRunIds).toEqual(['run-a'])
    expect(result.current.activeContext?.activeRunId).toBe('run-a')
  })

  it('persists activeRunId when chatStart assigns a run id on a draft chat', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })

    vi.useFakeTimers()
    updateWorkspaceUiState.mockClear()
    chatStart.mockResolvedValueOnce({ ok: true, data: { runId: 'run-assigned', invokeId: 1 } })

    await act(async () => {
      await result.current.chatActions?.send('first')
    })

    expect(result.current.activeContext?.activeRunId).toBe('run-assigned')
    expect(result.current.activeContext?.openRunIds).toEqual(['run-assigned'])

    await act(async () => {
      vi.advanceTimersByTime(300)
    })

    expect(updateWorkspaceUiState).toHaveBeenCalledWith(
      '/ws-a',
      expect.objectContaining({
        activeRunId: 'run-assigned',
        openRunIds: ['run-assigned']
      })
    )

    vi.useRealTimers()
  })

  it('blocks send while transcript is loading', async () => {
    let resolveLoad: (value: {
      ok: true
      data: { runId: string; messages: { role: string; content: string }[] }
    }) => void = () => undefined
    loadRun.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve
        })
    )

    getWorkspaces.mockResolvedValue({
      ok: true,
      data: defaultRegistry({
        uiStateByPath: {
          '/ws-a': {
            activeRunId: 'run-restored',
            openRunIds: ['run-restored'],
            scrollTop: 0,
            scrollTopByRunId: {},
            composerDraft: ''
          },
          '/ws-b': {
            activeRunId: null,
            openRunIds: [],
            scrollTop: 0,
            scrollTopByRunId: {},
            composerDraft: ''
          }
        }
      })
    })

    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.chat.transcriptLoading).toBe(true)
    })

    let sent = false
    await act(async () => {
      sent = (await result.current.chatActions?.send('too early')) ?? false
    })
    expect(sent).toBe(false)
    expect(chatStart).not.toHaveBeenCalled()

    await act(async () => {
      resolveLoad({
        ok: true,
        data: { runId: 'run-restored', messages: [{ role: 'user', content: 'hello' }] }
      })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(result.current.chat.transcriptLoading).toBe(false)
    })
  })

  it('flushes ui state before removing a workspace', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })

    act(() => {
      result.current.setComposerDraft('flush me')
    })

    await act(async () => {
      await result.current.removeWorkspace('/ws-a')
    })

    expect(updateWorkspaceUiState).toHaveBeenCalledWith(
      '/ws-a',
      expect.objectContaining({ composerDraft: 'flush me' })
    )
  })

  it('surfaces workspaceError when getWorkspaces fails on startup', async () => {
    getWorkspaces.mockResolvedValue({ ok: false, error: 'disk read failed' })
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.workspaceError).toBe('disk read failed')
    })
    expect(result.current.activeWorkspace).toBeNull()
  })

  it('caps orphan event buffers for never-registered run ids', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })

    const { ORPHAN_EVENT_BUFFER_MAX } = WORKSPACE_MANAGER_LIMITS
    const overflow = 5

    await act(async () => {
      for (let i = 0; i < ORPHAN_EVENT_BUFFER_MAX + overflow; i++) {
        handler?.({ type: 'text_delta', runId: 'ghost-run', text: `[${i}]` })
      }
    })

    await act(async () => {
      result.current.openRunTab('ghost-run')
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })

    const ctrl = result.current.getRunController('ghost-run')
    const assistant = ctrl?.items.find((i) => i.kind === 'message' && i.role === 'assistant')
    expect(assistant?.kind).toBe('message')
    if (assistant?.kind !== 'message') return

    // Overflow coalesces older text_delta chunks into later ones — no token loss.
    for (let i = 0; i < ORPHAN_EVENT_BUFFER_MAX + overflow; i++) {
      expect(assistant.content).toContain(`[${i}]`)
    }
  })

  it('keeps terminal orphan events when the buffer overflows with text deltas', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })

    const { ORPHAN_EVENT_BUFFER_MAX } = WORKSPACE_MANAGER_LIMITS

    await act(async () => {
      handler?.({
        type: 'assistant_message',
        runId: 'ghost-terminal',
        content: 'kept-answer',
        toolCalls: []
      })
      for (let i = 0; i < ORPHAN_EVENT_BUFFER_MAX; i++) {
        handler?.({ type: 'text_delta', runId: 'ghost-terminal', text: `[${i}]` })
      }
    })

    await act(async () => {
      result.current.openRunTab('ghost-terminal')
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })

    const ctrl = result.current.getRunController('ghost-terminal')
    const assistant = ctrl?.items.find((i) => i.kind === 'message' && i.role === 'assistant')
    expect(assistant?.kind).toBe('message')
    if (assistant?.kind !== 'message') return
    expect(assistant.content).toContain('kept-answer')
  })

  it('coalesces older orphan usage under backpressure and keeps the latest meter', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })

    const { ORPHAN_EVENT_BUFFER_MAX } = WORKSPACE_MANAGER_LIMITS

    await act(async () => {
      for (let i = 0; i < ORPHAN_EVENT_BUFFER_MAX; i++) {
        handler?.({
          type: 'context_usage',
          runId: 'ghost-usage',
          step: i,
          estimatedTokens: i,
          inputTokens: i,
          contextWindow: 100_000,
          contentWindow: 100_000,
          compactionTrigger: 80_000,
          source: 'estimate',
          layers: { system: 0, history: 0, tools: 0, buffer: 0 }
        })
      }
      handler?.({
        type: 'context_usage',
        runId: 'ghost-usage',
        step: ORPHAN_EVENT_BUFFER_MAX,
        estimatedTokens: 9999,
        inputTokens: 9999,
        contextWindow: 100_000,
        contentWindow: 100_000,
        compactionTrigger: 80_000,
        source: 'estimate',
        layers: { system: 0, history: 0, tools: 0, buffer: 0 }
      })
    })

    await act(async () => {
      result.current.openRunTab('ghost-usage')
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })

    const ctrl = result.current.getRunController('ghost-usage')
    expect(ctrl?.getContextUsage()?.inputTokens).toBe(9999)
  })

  it('drops a sole orphan usage meter before tool/status chrome under backpressure', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })

    const { ORPHAN_EVENT_BUFFER_MAX } = WORKSPACE_MANAGER_LIMITS

    await act(async () => {
      handler?.({
        type: 'assistant_message',
        runId: 'ghost-keep-chrome',
        content: 'keep-me',
        toolCalls: []
      })
      handler?.({
        type: 'context_usage',
        runId: 'ghost-keep-chrome',
        step: 1,
        estimatedTokens: 42,
        inputTokens: 42,
        contextWindow: 100_000,
        contentWindow: 100_000,
        compactionTrigger: 80_000,
        source: 'estimate',
        layers: { system: 0, history: 0, tools: 0, buffer: 0 }
      })
      for (let i = 0; i < ORPHAN_EVENT_BUFFER_MAX - 2; i++) {
        handler?.({
          type: 'status',
          runId: 'ghost-keep-chrome',
          message: `status-${i}`
        })
      }
      // Buffer is full; this forces eviction. Sole usage should go before chrome.
      handler?.({
        type: 'status',
        runId: 'ghost-keep-chrome',
        message: 'overflow'
      })
    })

    await act(async () => {
      result.current.openRunTab('ghost-keep-chrome')
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })

    const ctrl = result.current.getRunController('ghost-keep-chrome')
    const assistant = ctrl?.items.find((i) => i.kind === 'message' && i.role === 'assistant')
    expect(assistant?.kind).toBe('message')
    if (assistant?.kind !== 'message') return
    expect(assistant.content).toContain('keep-me')
    expect(ctrl?.getContextUsage()?.inputTokens).not.toBe(42)
  })

  it('does not resurrect an empty transcript from late events after closing a idle run tab', async () => {
    loadRun.mockResolvedValue({
      ok: true,
      data: {
        runId: 'run-closed',
        messages: [{ role: 'user', content: 'persisted' }]
      }
    })

    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })

    await act(async () => {
      result.current.openRunTab('run-closed')
      await result.current.loadRunIntoTab('/ws-a', 'run-closed')
    })

    await waitFor(() => {
      expect(
        result.current.chat.items.some((i) => i.kind === 'message' && i.content === 'persisted')
      ).toBe(true)
    })

    await act(async () => {
      handler?.({ type: 'status', runId: 'run-closed', status: 'done' })
    })

    await act(async () => {
      result.current.closeRunTab('run-closed')
    })

    await act(async () => {
      handler?.({ type: 'text_delta', runId: 'run-closed', text: 'LATE_LEAK' })
      handler?.({ type: 'assistant_message', runId: 'run-closed', content: 'LATE_LEAK' })
    })

    await act(async () => {
      result.current.openRunTab('run-closed')
      await result.current.loadRunIntoTab('/ws-a', 'run-closed')
    })

    await waitFor(() => {
      expect(
        result.current.chat.items.some((i) => i.kind === 'message' && i.content === 'persisted')
      ).toBe(true)
    })

    expect(
      result.current.chat.items.some((i) => i.kind === 'message' && i.content.includes('LATE_LEAK'))
    ).toBe(false)
  })

  it('does not apply late events to an LRU-evicted idle controller', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })

    const { OPEN_RUN_TAB_LIMIT } = WORKSPACE_MANAGER_LIMITS
    const keptId = `run-keep`

    await act(async () => {
      for (let i = 0; i < OPEN_RUN_TAB_LIMIT; i++) {
        result.current.openRunTab(`run-idle-${i}`)
      }
      result.current.openRunTab(keptId)
    })

    expect(result.current.activeContext?.openRunIds.length).toBe(OPEN_RUN_TAB_LIMIT + 1)

    await act(async () => {
      handler?.({ type: 'text_delta', runId: 'run-idle-0', text: 'EVICT_LEAK' })
      handler?.({ type: 'assistant_message', runId: 'run-idle-0', content: 'EVICT_LEAK' })
    })

    await act(async () => {
      result.current.openRunTab('run-idle-0')
    })

    expect(
      result.current.chat.items.some((i) => i.kind === 'message' && i.content.includes('EVICT_LEAK'))
    ).toBe(false)
  })

  it('hydrates a freshly dropped session into its pane (no empty split)', async () => {
    listRuns.mockResolvedValue({
      ok: true,
      data: {
        runs: [
          { runId: 'run-alpha', status: 'done', updatedAt: '2026-01-01T00:00:00.000Z', goal: 'Alpha' },
          { runId: 'run-beta', status: 'done', updatedAt: '2026-01-01T00:01:00.000Z', goal: 'Beta' }
        ],
        capped: false
      }
    })
    loadRun.mockResolvedValue({
      ok: true,
      data: {
        runId: 'run-beta',
        messages: [{ role: 'user', content: 'hello beta' }],
        hasEarlier: false,
        earlierCursor: null
      }
    })
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
      expect(result.current.paneLayout?.panes.length).toBe(1)
    })

    const anchorPaneId = result.current.paneLayout!.panes[0]!.paneId
    await act(async () => {
      result.current.openRunTab('run-alpha')
    })
    let ok = false
    await act(async () => {
      ok = result.current.dropSessionOnPane(anchorPaneId, 'right', {
        workspacePath: '/ws-a',
        runId: 'run-beta'
      })
    })
    expect(ok).toBe(true)
    await waitFor(() => {
      expect(result.current.paneLayout?.panes).toHaveLength(2)
    })

    // Mirror App.handleSessionDrop's post-drop transcript load verbatim.
    await act(async () => {
      const ctrl = result.current.getRunController('run-beta', '/ws-a')
      if (!ctrl || ctrl.items.length === 0) {
        await result.current.loadRunIntoTab('/ws-a', 'run-beta')
      }
    })

    const snap = result.current.getPaneChatSnapshot('/ws-a', 'run-beta')
    expect(snap.items.length).toBeGreaterThan(0)
    expect(snap.transcriptLoading).toBe(false)
  })

  it('self-heals an empty pane transcript on the next layout commit', async () => {
    listRuns.mockResolvedValue({
      ok: true,
      data: {
        runs: [
          { runId: 'run-alpha', status: 'done', updatedAt: '2026-01-01T00:00:00.000Z', goal: 'Alpha' },
          { runId: 'run-beta', status: 'done', updatedAt: '2026-01-01T00:01:00.000Z', goal: 'Beta' }
        ],
        capped: false
      }
    })
    // The drop's own hydrate and App's one-shot load both fail; the pane must
    // not sit empty forever — the next layout commit retries and succeeds.
    // Counted per runId so interleaved loadRun callers don't shift the script.
    let betaFailures = 2
    loadRun.mockImplementation(async (_ws: string, runId: string) => {
      if (runId === 'run-beta' && betaFailures > 0) {
        betaFailures -= 1
        return { ok: false as const, error: 'transient load failure' }
      }
      return {
        ok: true as const,
        data: {
          runId,
          messages: [{ role: 'user' as const, content: 'hello' }],
          hasEarlier: false,
          earlierCursor: null
        }
      }
    })
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
      expect(result.current.paneLayout?.panes.length).toBe(1)
    })

    const anchorPaneId = result.current.paneLayout!.panes[0]!.paneId
    await act(async () => {
      result.current.openRunTab('run-alpha')
    })
    await act(async () => {
      expect(
        result.current.dropSessionOnPane(anchorPaneId, 'right', {
          workspacePath: '/ws-a',
          runId: 'run-beta'
        })
      ).toBe(true)
    })
    await waitFor(() => {
      expect(result.current.paneLayout?.panes).toHaveLength(2)
    })

    // Mirror App.handleSessionDrop's post-drop transcript load — it fails.
    await act(async () => {
      const ctrl = result.current.getRunController('run-beta', '/ws-a')
      if (!ctrl || ctrl.items.length === 0) {
        await result.current.loadRunIntoTab('/ws-a', 'run-beta')
      }
    })
    expect(result.current.getPaneChatSnapshot('/ws-a', 'run-beta').items.length).toBe(0)

    // Any later layout commit (here: a focus change) retries the hydrate.
    await act(async () => {
      result.current.focusPaneById(anchorPaneId)
    })
    await waitFor(() => {
      expect(result.current.getPaneChatSnapshot('/ws-a', 'run-beta').items.length).toBeGreaterThan(
        0
      )
    })
  })

  it('refuses a pane drop beyond capacity and leaves the layout unchanged', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
      expect(result.current.paneLayout?.panes.length).toBe(1)
    })

    const anchorPaneId = result.current.paneLayout!.panes[0]!.paneId
    await act(async () => {
      result.current.openRunTab('run-a')
    })
    await act(async () => {
      expect(
        result.current.dropSessionOnPane(anchorPaneId, 'right', {
          workspacePath: '/ws-b',
          runId: 'run-b'
        })
      ).toBe(true)
    })
    await waitFor(() => {
      expect(result.current.paneLayout?.panes).toHaveLength(2)
    })

    // jsdom viewport (1024px / 280px min column) caps the row at two panes;
    // the third drop is refused without touching the committed layout.
    await act(async () => {
      expect(
        result.current.dropSessionOnPane(anchorPaneId, 'right', {
          workspacePath: '/ws-b',
          runId: 'run-c'
        })
      ).toBe(false)
    })

    expect(result.current.paneLayout?.panes).toHaveLength(2)
    expect(result.current.paneLayout?.panes.map((p) => p.runId).sort()).toEqual([
      'run-a',
      'run-b'
    ])
    expect(result.current.paneLayout?.panes.some((p) => p.runId === 'run-c')).toBe(false)
  })

  it('splitFocusedPane inserts a draft pane beside the focused session', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
      expect(result.current.paneLayout?.panes.length).toBe(1)
    })

    act(() => {
      result.current.openRunTab('run-a')
    })
    await waitFor(() => {
      expect(result.current.paneLayout?.panes[0]?.runId).toBe('run-a')
    })

    let ok = false
    act(() => {
      ok = result.current.splitFocusedPane()
    })
    expect(ok).toBe(true)
    expect(result.current.paneLayout?.panes).toHaveLength(2)
    expect(result.current.paneLayout?.panes[1]?.runId).toBeNull()
    expect(result.current.paneLayout?.panes[1]?.workspacePath).toBe('/ws-a')
    expect(result.current.paneLayout?.focusedPaneId).toBe(
      result.current.paneLayout?.panes[1]?.paneId
    )
  })

  it('splitFocusedPane refuses when the focused pane is a draft', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
      expect(result.current.paneLayout?.panes.length).toBe(1)
    })
    expect(result.current.paneLayout?.panes[0]?.runId).toBeNull()

    let ok = true
    act(() => {
      ok = result.current.splitFocusedPane()
    })
    expect(ok).toBe(false)
    expect(result.current.paneLayout?.panes).toHaveLength(1)
  })

  it('splitFocusedPane respects the maxChatPanes override', async () => {
    const { result } = renderHook(() => useWorkspaceManager({ maxChatPanes: 1 }))

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })
    act(() => {
      result.current.openRunTab('run-a')
    })
    await waitFor(() => {
      expect(result.current.paneLayout?.panes[0]?.runId).toBe('run-a')
    })

    let ok = true
    act(() => {
      ok = result.current.splitFocusedPane()
    })
    expect(ok).toBe(false)
    expect(result.current.paneLayout?.panes).toHaveLength(1)
  })

  it('dropping an instance on a pane never enters openRunIds or activeRunId', async () => {
    listRuns.mockResolvedValue({
      ok: true,
      data: {
        runs: [{ runId: 'parent-1', status: 'done', updatedAt: '2026-01-01T00:00:00.000Z' }],
        instanceRuns: [
          {
            runId: 'child-1',
            status: 'done',
            updatedAt: '2026-01-01T00:00:00.000Z',
            inlineInstance: true,
            parentRunId: 'parent-1'
          }
        ],
        capped: false
      }
    })
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
      expect(result.current.activeContext?.instanceRuns.length).toBe(1)
    })
    const anchorPaneId = result.current.paneLayout!.panes[0]!.paneId

    let ok = false
    act(() => {
      ok = result.current.dropSessionOnPane(anchorPaneId, 'right', {
        workspacePath: '/ws-a',
        runId: 'child-1'
      })
    })
    expect(ok).toBe(true)
    await waitFor(() => {
      expect(result.current.paneLayout?.panes).toHaveLength(2)
    })
    expect(result.current.paneLayout?.panes[1]?.runId).toBe('child-1')
    expect(result.current.activeContext?.activeRunId).not.toBe('child-1')
    expect(result.current.activeContext?.openRunIds).not.toContain('child-1')

      // Contrast: a parent session opened as a tab lands in the tab list.
      act(() => {
        result.current.openRunTab('parent-1')
      })
      expect(result.current.activeContext?.openRunIds).toContain('parent-1')
  })

  describe('teammate model pin + binding prune', () => {
    function registryWithBindings(bindingsA: Record<string, string>): WorkspacesState {
      return defaultRegistry({
        uiStateByPath: {
          '/ws-a': {
            activeRunId: null,
            openRunIds: [],
            scrollTop: 0,
            scrollTopByRunId: {},
            composerDraft: '',
            agentProfileIdByRunId: bindingsA
          },
          '/ws-b': {
            activeRunId: null,
            openRunIds: [],
            scrollTop: 0,
            scrollTopByRunId: {},
            composerDraft: '',
            agentProfileIdByRunId: {}
          }
        } as WorkspacesState['uiStateByPath']
      })
    }

    it('seeds a pre-bound chat with the teammate model pin at controller creation', async () => {
      getWorkspaces.mockResolvedValue({
        ok: true,
        data: registryWithBindings({ __draft__: 'scout' })
      })
      const { result } = renderHook(() =>
        useWorkspaceManager({
          getAgentProfileModelPin: (id) =>
            id === 'scout' ? { provider: 'openai', model: 'gpt-pin' } : null
        })
      )
      await waitFor(() => expect(result.current.activeWorkspace).toBe('/ws-a'))

      chatStart.mockResolvedValueOnce({ ok: true, data: { runId: 'run-pin' } })
      await act(async () => {
        await result.current.chatActions?.send('pinned hello')
      })
      expect(chatStart).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'openai', model: 'gpt-pin', agentProfileId: 'scout' })
      )
    })

    it('adopts the pin immediately when the user binds a teammate mid-session', async () => {
      getWorkspaces.mockResolvedValue({ ok: true, data: registryWithBindings({}) })
      const { result } = renderHook(() =>
        useWorkspaceManager({
          getAgentProfileModelPin: (id) =>
            id === 'scout' ? { provider: 'openai', model: 'gpt-pin' } : null
        })
      )
      await waitFor(() => expect(result.current.activeWorkspace).toBe('/ws-a'))

      act(() => {
        result.current.setAgentProfileIdForRun('/ws-a', null, 'scout')
      })
      expect(result.current.getAgentProfileIdForRun('/ws-a', null)).toBe('scout')

      chatStart.mockResolvedValueOnce({ ok: true, data: { runId: 'run-bound' } })
      await act(async () => {
        await result.current.chatActions?.send('after bind')
      })
      expect(chatStart).toHaveBeenLastCalledWith(
        expect.objectContaining({ provider: 'openai', model: 'gpt-pin', agentProfileId: 'scout' })
      )
    })

    it('hydrates valid durable bindings from initial and older run summaries', async () => {
      listRuns.mockResolvedValue({
        ok: true,
        data: {
          runs: [
            { runId: 'run-current', status: 'done', updatedAt: '2026-02-02T00:00:00.000Z', agentProfileId: 'scout' },
            { runId: 'run-deleted', status: 'done', updatedAt: '2026-02-01T00:00:00.000Z', agentProfileId: 'ghost' }
          ],
          capped: true
        }
      })
      listOlderRuns.mockResolvedValue({
        ok: true,
        data: {
          runs: [{ runId: 'run-older', status: 'done', updatedAt: '2026-01-01T00:00:00.000Z', agentProfileId: 'scout' }],
          hasMore: false
        }
      })
      const { result } = renderHook(() =>
        useWorkspaceManager({ getValidAgentProfileIds: () => new Set(['scout']) })
      )
      await waitFor(() => expect(result.current.activeContext?.runsLoaded).toBe(true))
      expect(result.current.getAgentProfileIdForRun('/ws-a', 'run-current')).toBe('scout')
      expect(result.current.getAgentProfileIdForRun('/ws-a', 'run-deleted')).toBeNull()

      await act(async () => {
        await result.current.loadOlderRuns('/ws-a')
      })
      expect(result.current.getAgentProfileIdForRun('/ws-a', 'run-older')).toBe('scout')
      // Hydrating a durable binding persists through the debounced writer, so
      // the write lands after this tick — same as the prune test below.
      await waitFor(() => expect(updateWorkspaceUiState).toHaveBeenCalled())
    })

    it('keeps durable existing-run bindings immutable in the renderer', async () => {
      listRuns.mockResolvedValue({
        ok: true,
        data: {
          runs: [{ runId: 'run-bound', status: 'done', updatedAt: '2026-01-01T00:00:00.000Z', agentProfileId: 'scout' }],
          capped: false
        }
      })
      const { result } = renderHook(() =>
        useWorkspaceManager({ getValidAgentProfileIds: () => new Set(['scout', 'other']) })
      )
      await waitFor(() => expect(result.current.getAgentProfileIdForRun('/ws-a', 'run-bound')).toBe('scout'))
      act(() => result.current.setAgentProfileIdForRun('/ws-a', 'run-bound', 'other'))
      act(() => result.current.setAgentProfileIdForRun('/ws-a', 'run-bound', null))
      expect(result.current.getAgentProfileIdForRun('/ws-a', 'run-bound')).toBe('scout')
    })

    it('reads a binding through a differently spelled workspace path', async () => {
      getWorkspaces.mockResolvedValue({
        ok: true,
        data: registryWithBindings({ __draft__: 'scout' })
      })
      const { result } = renderHook(() => useWorkspaceManager())
      await waitFor(() => expect(result.current.activeWorkspace).toBe('/ws-a'))

      // The setter already tolerates an equal-but-differently-spelled path;
      // a direct key lookup in the getter would drop the teammate from the
      // send instead.
      expect(result.current.getAgentProfileIdForRun('/ws-a/', null)).toBe('scout')
    })

    it('prunes chat bindings whose teammate no longer exists in the roster', async () => {
      getWorkspaces.mockResolvedValue({
        ok: true,
        data: registryWithBindings({ __draft__: 'ghost', 'run-old': 'scout' })
      })
      const { result } = renderHook(() => useWorkspaceManager())
      await waitFor(() => expect(result.current.activeWorkspace).toBe('/ws-a'))
      expect(result.current.getAgentProfileIdForRun('/ws-a', null)).toBe('ghost')

      act(() => {
        result.current.pruneAgentProfileBindings(new Set(['scout']))
      })
      expect(result.current.getAgentProfileIdForRun('/ws-a', null)).toBeNull()
      expect(result.current.getAgentProfileIdForRun('/ws-a', 'run-old')).toBe('scout')
      await waitFor(() => expect(updateWorkspaceUiState).toHaveBeenCalled())
    })
  })

  it('does not auto-resume inline instance runs on load', async () => {
    const getSettings = vi.fn().mockResolvedValue({
      ok: true,
      data: { autoResumeInterruptedRuns: true }
    })
    ;(window.vyotiq as Record<string, unknown>).getSettings = getSettings
    loadRun.mockResolvedValue({
      ok: true,
      data: {
        runId: 'child-1',
        messages: [],
        status: 'cancelled',
        resumable: true,
        error: 'Run interrupted',
        inlineInstance: true
      }
    })
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })

    await act(async () => {
      await result.current.loadRunIntoTab('/ws-a', 'child-1')
    })

    // The inlineInstance guard short-circuits before settings are consulted.
    expect(getSettings).not.toHaveBeenCalled()
    expect(chatStart).not.toHaveBeenCalled()
  })

  it('purging a deleted parent also closes its instance panes', async () => {
    listRuns.mockResolvedValue({
      ok: true,
      data: {
        runs: [{ runId: 'parent-1', status: 'done', updatedAt: '2026-01-01T00:00:00.000Z' }],
        instanceRuns: [
          {
            runId: 'child-1',
            status: 'done',
            updatedAt: '2026-01-01T00:00:00.000Z',
            inlineInstance: true,
            parentRunId: 'parent-1'
          }
        ],
        capped: false
      }
    })
    // jsdom caps the viewport-derived count at 2 — override so three panes fit.
    const { result } = renderHook(() => useWorkspaceManager({ maxChatPanes: 3 }))

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
      expect(result.current.activeContext?.instanceRuns.length).toBe(1)
    })
    const anchorPaneId = result.current.paneLayout!.panes[0]!.paneId
    act(() => {
      result.current.dropSessionOnPane(anchorPaneId, 'right', {
        workspacePath: '/ws-a',
        runId: 'child-1'
      })
    })
    await waitFor(() => {
      expect(result.current.paneLayout?.panes).toHaveLength(2)
    })
    const childPaneId = result.current.paneLayout!.panes[1]!.paneId
    act(() => {
      result.current.dropSessionOnPane(childPaneId, 'right', {
        workspacePath: '/ws-a',
        runId: 'parent-1'
      })
    })
    await waitFor(() => {
      expect(result.current.paneLayout?.panes).toHaveLength(3)
    })

    act(() => {
      result.current.purgeDeletedRunUi('/ws-a', 'parent-1')
    })

    // Parent + child panes removed in one commit; layout collapses to a draft.
    expect(result.current.paneLayout?.panes).toHaveLength(1)
    expect(result.current.paneLayout?.panes[0]?.runId).toBeNull()
  })

  it('hydration honors the maxChatPanes override when clamping a stored layout', async () => {
    const storedLayout = (): string =>
      JSON.stringify({
        panes: [
          { paneId: 'pane-1', workspacePath: '/ws-a', runId: 'run-1' },
          { paneId: 'pane-2', workspacePath: '/ws-a', runId: 'run-2' },
          { paneId: 'pane-3', workspacePath: '/ws-a', runId: 'run-3' }
        ],
        focusedPaneId: 'pane-2',
        sizes: [1 / 3, 1 / 3, 1 / 3]
      })

    // jsdom viewport derives 2 — the override must win so all three restore.
    localStorage.setItem('vyotiq.chatPaneLayout', storedLayout())
    const first = renderHook(() => useWorkspaceManager({ maxChatPanes: 3 }))
    await waitFor(() => {
      expect(first.result.current.activeWorkspace).toBe('/ws-a')
      expect(first.result.current.paneLayout?.panes.length).toBe(3)
    })
    first.unmount()

    // Override below the stored count clamps to one pane; the single-pane sync
    // effect then mirrors the workspace's active run (null in this mock).
    localStorage.setItem('vyotiq.chatPaneLayout', storedLayout())
    const second = renderHook(() => useWorkspaceManager({ maxChatPanes: 1 }))
    await waitFor(() => {
      expect(second.result.current.activeWorkspace).toBe('/ws-a')
      expect(second.result.current.paneLayout?.panes.length).toBe(1)
    })
    expect(second.result.current.paneLayout?.panes[0]?.runId).toBeNull()
    second.unmount()
  })
})

describe('scrollTopByRunId prune helpers', () => {
  it('keeps open/active keys; drops draft when a run is active', () => {
    const pruned = pruneScrollTopByRunId(
      {
        'run-open': 10,
        'run-gone': 99,
        'run-active': 20,
        __draft__: 5
      },
      { openRunIds: ['run-open'], activeRunId: 'run-active' }
    )
    expect(pruned).toEqual({
      'run-open': 10,
      'run-active': 20
    })
  })

  it('keeps __draft__ only while drafting', () => {
    expect(
      pruneScrollTopByRunId(
        { __draft__: 5, 'run-open': 10 },
        { openRunIds: ['run-open'], activeRunId: null }
      )
    ).toEqual({ __draft__: 5, 'run-open': 10 })
  })

  it('omitRunScrollTop removes a deleted run key', () => {
    expect(omitRunScrollTop({ a: 1, b: 2 }, 'a')).toEqual({ b: 2 })
    expect(omitRunScrollTop({ a: 1 }, 'missing')).toEqual({ a: 1 })
  })
})

describe('reconcileOpenRunIds', () => {
  it('drops deleted tabs and reassigns active run', () => {
    const result = reconcileOpenRunIds(
      ['run-a', 'run-deleted', 'run-b'],
      'run-deleted',
      ['run-a', 'run-b'],
      ['run-a', 'run-deleted', 'run-b']
    )
    expect(result.changed).toBe(true)
    expect(result.openRunIds).toEqual(['run-a', 'run-b'])
    expect(result.activeRunId).toBe('run-b')
  })

  it('no-ops when all open tabs still exist', () => {
    const result = reconcileOpenRunIds(['run-a'], 'run-a', ['run-a', 'run-b'], ['run-a'])
    expect(result.changed).toBe(false)
    expect(result.openRunIds).toEqual(['run-a'])
    expect(result.activeRunId).toBe('run-a')
  })

  it('no-ops when listRuns is empty but prior runs were unknown', () => {
    const result = reconcileOpenRunIds(['run-new'], 'run-new', [], [])
    expect(result.changed).toBe(false)
    expect(result.openRunIds).toEqual(['run-new'])
    expect(result.activeRunId).toBe('run-new')
  })
})

describe('resolveComposerDraft', () => {
  it('reads per-run drafts and falls back to workspace draft for new chat', () => {
    const ui = {
      composerDraft: 'workspace-draft',
      composerDraftByRunId: { 'run-1': 'run-one' }
    }
    expect(resolveComposerDraft(ui, 'run-1')).toBe('run-one')
    expect(resolveComposerDraft(ui, 'run-2')).toBe('')
    expect(resolveComposerDraft(ui, null)).toBe('workspace-draft')
  })

  it('falls back to legacy composerDraft when map is empty and a run is active', () => {
    const ui = {
      composerDraft: 'pre-migration',
      composerDraftByRunId: {} as Record<string, string>
    }
    expect(resolveComposerDraft(ui, 'run-1')).toBe('pre-migration')
  })
})

describe('setComposerDraftForPane hot UI', () => {
  it('writes typed draft into hot UI for a non-null runId', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })

    act(() => {
      result.current.openRunTab('run-hot-1')
    })

    act(() => {
      result.current.setComposerDraftForPane('/ws-a', 'run-hot-1', 'typed on run')
    })

    const hot = getWorkspaceHotUi('/ws-a')
    expect(resolveHotComposerDraft(hot, 'run-hot-1')).toBe('typed on run')
    expect(resolveComposerDraft(result.current.activeContext!.ui, 'run-hot-1')).toBe(
      'typed on run'
    )
  })

  it('persists workspace expand/collapse state through updateWorkspaceUiState', async () => {
    const { result } = renderHook(() => useWorkspaceManager())

    await waitFor(() => {
      expect(result.current.activeWorkspace).toBe('/ws-a')
    })

    // Default: active workspace expanded, other workspaces collapsed.
    expect(result.current.workspaceExpandedByPath['/ws-a']).toBe(true)
    expect(result.current.workspaceExpandedByPath['/ws-b']).toBe(false)

    vi.useFakeTimers()

    act(() => {
      result.current.setWorkspaceExpanded('/ws-b', true)
    })

    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(window.vyotiq.updateWorkspaceUiState).toHaveBeenCalledWith(
      '/ws-b',
      expect.objectContaining({ expanded: true })
    )
    expect(result.current.workspaceExpandedByPath['/ws-b']).toBe(true)

    ;(window.vyotiq.updateWorkspaceUiState as ReturnType<typeof vi.fn>).mockClear()

    act(() => {
      result.current.setWorkspaceExpanded('/ws-a', false)
    })

    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(window.vyotiq.updateWorkspaceUiState).toHaveBeenCalledWith(
      '/ws-a',
      expect.objectContaining({ expanded: false })
    )
    expect(result.current.workspaceExpandedByPath['/ws-a']).toBe(false)

    vi.useRealTimers()
  })
})

describe('omitRunComposerDraft / migrateLegacyComposerDraftMap', () => {
  it('omits a run draft key without touching siblings', () => {
    expect(omitRunComposerDraft({ a: '1', b: '2' }, 'a')).toEqual({ b: '2' })
    expect(omitRunComposerDraft({ a: '1' }, 'missing')).toEqual({ a: '1' })
  })

  it('migrates legacy workspace draft into active run + __draft__ keys', () => {
    const migrated = migrateLegacyComposerDraftMap(
      { composerDraft: 'hello', composerDraftByRunId: {} },
      'run-1'
    )
    expect(migrated['run-1']).toBe('hello')
    expect(migrated.__draft__).toBe('hello')
  })
})
