/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useWorkspaceManager } from '@renderer/lib/hooks/useWorkspaceManager'
import { RUN_INTERRUPTED_ERROR } from '@shared/runInterrupt'
import type { WorkspacesState } from '@shared/ipc'

function defaultRegistry(): WorkspacesState {
  return {
    version: 2,
    workspaceIdsByPath: {},
    legacySessionsMigrated: true,
    openPaths: ['/ws-a'],
    activePath: '/ws-a',
    recentPaths: [],
    uiStateByPath: {
      '/ws-a': {
        activeRunId: 'run-resume',
        openRunIds: ['run-resume'],
        scrollTop: 0,
        scrollTopByRunId: {},
        composerDraft: ''
      }
    },
    settingsOverridesByPath: {}
  }
}

describe('auto-resume interrupted runs', () => {
  const chatStart = vi.fn()
  const getSettings = vi.fn()
  const loadRun = vi.fn()
  const loadRunEvents = vi.fn()
  const listRuns = vi.fn()
  const listActiveRuns = vi.fn()
  const getWorkspaces = vi.fn()

  beforeEach(() => {
    chatStart.mockReset()
    getSettings.mockReset()
    loadRun.mockReset()
    loadRunEvents.mockReset()
    listRuns.mockReset()
    listActiveRuns.mockReset()
    getWorkspaces.mockReset()

    chatStart.mockResolvedValue({ ok: true, data: { runId: 'run-resume', invokeId: 1 } })
    getSettings.mockResolvedValue({ ok: true, data: { autoResumeInterruptedRuns: false } })
    loadRun.mockResolvedValue({
      ok: true,
      data: {
        runId: 'run-resume',
        messages: [{ role: 'user', content: 'hello' }],
        status: 'cancelled',
        resumable: true,
        error: RUN_INTERRUPTED_ERROR
      }
    })
    loadRunEvents.mockResolvedValue({ ok: true, data: [] })
    listRuns.mockResolvedValue({ ok: true, data: { runs: [], capped: false } })
    listActiveRuns.mockResolvedValue({ ok: true, data: [] })
    getWorkspaces.mockResolvedValue({ ok: true, data: defaultRegistry() })

    // @ts-expect-error test bridge
    window.vyotiq = {
      chatStart,
      getSettings,
      loadRun,
      loadRunEvents,
      listRuns,
      listActiveRuns,
      getWorkspaces,
      setActiveWorkspace: vi.fn(),
      removeWorkspace: vi.fn(),
      updateWorkspaceUiState: vi.fn(),
      onChatEvent: vi.fn(() => () => {}),
      chatCancel: vi.fn()
    }
  })

  it('does not auto-resume when setting is off', async () => {
    const { result } = renderHook(() => useWorkspaceManager())
    await act(async () => {
      await result.current.loadRunIntoTab('/ws-a', 'run-resume')
    })
    await waitFor(() => expect(loadRun).toHaveBeenCalled())
    expect(chatStart).not.toHaveBeenCalled()
  })

  it('auto-resumes once when setting is on', async () => {
    getSettings.mockResolvedValue({ ok: true, data: { autoResumeInterruptedRuns: true } })
    const { result } = renderHook(() => useWorkspaceManager())
    await act(async () => {
      await result.current.loadRunIntoTab('/ws-a', 'run-resume')
    })
    await waitFor(() => expect(chatStart).toHaveBeenCalledTimes(1))
    expect(chatStart.mock.calls[0]?.[0]).toMatchObject({
      workspacePath: '/ws-a',
      runId: 'run-resume',
      messages: []
    })
  })

  it('serializes multiple interrupted-run resumes instead of stampeding', async () => {
    getSettings.mockResolvedValue({ ok: true, data: { autoResumeInterruptedRuns: true } })
    loadRun.mockImplementation(async (_ws: string, runId: string) => ({
      ok: true,
      data: {
        runId,
        messages: [{ role: 'user', content: 'hello' }],
        status: 'cancelled',
        resumable: true,
        error: RUN_INTERRUPTED_ERROR
      }
    }))
    let releaseFirst: (() => void) | null = null
    chatStart.mockImplementation(async (args: { runId: string }) => {
      if (releaseFirst == null) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
      }
      return { ok: true, data: { runId: args.runId, invokeId: 1 } }
    })

    const { result } = renderHook(() => useWorkspaceManager())
    await act(async () => {
      await Promise.all([
        result.current.loadRunIntoTab('/ws-a', 'run-a'),
        result.current.loadRunIntoTab('/ws-a', 'run-b')
      ])
    })

    await waitFor(() => expect(chatStart).toHaveBeenCalledTimes(1), { timeout: 3000 })
    // While the first resume is still in flight, the second must not start.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900))
    })
    expect(chatStart).toHaveBeenCalledTimes(1)

    releaseFirst!()
    await waitFor(() => expect(chatStart).toHaveBeenCalledTimes(2), { timeout: 5000 })
  })
})
