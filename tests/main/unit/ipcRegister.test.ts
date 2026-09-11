import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/channels'
import type { AgentEvent } from '@shared/ipc'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())

const mockWin = vi.hoisted(() => ({
  isDestroyed: vi.fn(() => false),
  minimize: vi.fn(),
  maximize: vi.fn(),
  unmaximize: vi.fn(),
  isMaximized: vi.fn(() => false),
  close: vi.fn()
}))

const mockWcSend = vi.hoisted(() => vi.fn())
const mockMainFrame = vi.hoisted(() => ({ id: 'main-frame' }))
const mockWc = vi.hoisted(() => ({
  isDestroyed: vi.fn(() => false),
  mainFrame: mockMainFrame,
  send: mockWcSend
}))

const clearRunAbortMock = vi.hoisted(() => vi.fn())
const markRunTurnCompleteMock = vi.hoisted(() => vi.fn())
const registerRunAbortMock = vi.hoisted(() =>
  vi.fn(() => ({ controller: new AbortController(), invokeId: 42 }))
)
const tryRegisterRunAbortMock = vi.hoisted(() =>
  vi.fn(() => ({ ok: true as const, controller: new AbortController(), invokeId: 42 }))
)
const isRunTurnCompleteMock = vi.hoisted(() => vi.fn(() => false))
const waitUntilRunInactiveMock = vi.hoisted(() => vi.fn(async () => true))
const runAgentMock = vi.hoisted(() => vi.fn())
const transcribeDictationMock = vi.hoisted(() => vi.fn())
const runExistsMock = vi.hoisted(() => vi.fn())
const isActiveMock = vi.hoisted(() => vi.fn(() => false))
const resolveWritesMock = vi.hoisted(() => vi.fn())
const planRewindWritesMock = vi.hoisted(() => vi.fn(() => ({ checkpointIds: [], files: [] })))
const renameRunMock = vi.hoisted(() => vi.fn())
const previewHarnessApplyMock = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('No harness proposal found. Run `/harness-review` first.')
  })
)
const prepareRewindMock = vi.hoisted(() =>
  vi.fn(async () => ({
    messages: [{ role: 'user' as const, content: 'edited' }],
    writes: { restored: [] as string[], checkpointIds: [] as string[], skipped: [] as string[] }
  }))
)
const prepareRewindToUserMessageMock = vi.hoisted(() =>
  vi.fn(async () => ({
    messages: [{ role: 'user' as const, content: 'kept' }],
    writes: { restored: ['a.txt'], checkpointIds: ['cp-1'], skipped: [] as string[] }
  }))
)
const fromWebContents = vi.hoisted(() => vi.fn(() => mockWin))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
    on: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  },
  BrowserWindow: {
    fromWebContents
  },
  nativeTheme: {
    shouldUseDarkColors: true
  },
  shell: {
    openPath: vi.fn(async () => '')
  },
  app: {
    getPath: vi.fn(() => '/tmp/vyotiq-userdata')
  },
  dialog: {
    showOpenDialog: vi.fn()
  },
  Notification: class {
    static isSupported(): boolean {
      return false
    }
    static handleActivation(_cb: unknown): void {}
    show(): void {}
    close(): void {}
    on(_event: string, _cb: unknown): void {}
  }
}))

vi.mock('@main/workspace/workspace', () => ({
  pickWorkspace: vi.fn()
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({
    provider: 'ollama',
    model: 'qwen2.5',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    theme: 'system',
    telemetryEnabled: false
  }),
  setSettings: vi.fn()
}))

vi.mock('@main/settings/secrets', () => ({
  setSecret: vi.fn(),
  clearSecret: vi.fn(),
  getSecret: vi.fn(),
  secretStatus: vi.fn(() => ({}))
}))

vi.mock('@main/dictation/transcribe', () => ({
  transcribeDictation: transcribeDictationMock
}))

vi.mock('@main/agent/loop', () => ({
  runAgent: runAgentMock,
  createRunId: () => 'run-test',
  registerRunAbort: vi.fn()
}))

vi.mock('@main/agent/rewindRun', () => ({
  prepareRewindAndReplaceUserMessage: prepareRewindMock,
  prepareRewindToUserMessage: prepareRewindToUserMessageMock
}))

vi.mock('@main/agent/checkpoints', () => ({
  resolveWrites: (...args: unknown[]) => resolveWritesMock(...args),
  planRewindWrites: (...args: unknown[]) => planRewindWritesMock(...args),
  getWriteCheckpointMeta: vi.fn(() => null)
}))

vi.mock('@main/agent/harnessApply', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/harnessApply')>()
  return {
    ...actual,
    workspaceHasEditableHarness: (path: string) =>
      !String(path).replace(/\\/g, '/').includes('plain-ws'),
    previewHarnessApply: (...args: unknown[]) => previewHarnessApplyMock(...args)
  }
})

vi.mock('@main/agent/providers', () => ({
  listProviderModels: vi.fn()
}))

vi.mock('@main/agent/providers/modelCache', () => ({
  clearModelCache: vi.fn()
}))

vi.mock('@main/agent/runRegistry', () => ({
  activeRunCount: vi.fn(() => 0),
  chatCancelResult: vi.fn(),
  listActiveRuns: vi.fn(() => []),
  registerRunAbort: registerRunAbortMock,
  tryRegisterRunAbort: tryRegisterRunAbortMock,
  clearRunAbort: clearRunAbortMock,
  markRunTurnComplete: markRunTurnCompleteMock,
  isActive: isActiveMock,
  isRunTurnComplete: isRunTurnCompleteMock,
  waitUntilRunInactive: waitUntilRunInactiveMock,
  enqueueFollowUp: vi.fn(),
  removeFollowUp: vi.fn(),
  getRunInvokeId: vi.fn(() => 1),
  followUpPreview: vi.fn(() => 'preview'),
  getRunWorkspace: vi.fn(() => '/ws'),
  takeLateWriteCheckpoint: vi.fn(() => undefined),
  takeLateFollowUpDropped: vi.fn(() => undefined)
}))

vi.mock('@main/agent/state', () => ({
  listRuns: vi.fn(),
  loadMessages: vi.fn(),
  loadMessagesAsync: vi.fn(),
  loadEventsForRun: vi.fn(),
  loadEventsForRunAsync: vi.fn(),
  LOAD_EVENTS_UI_LIMIT: 500,
  loadToolResultContent: vi.fn(),
  deleteRun: vi.fn(),
  renameRun: (...args: unknown[]) => renameRunMock(...args),
  runExists: runExistsMock,
  loadStatus: vi.fn(() => null)
}))

vi.mock('@main/workspace/workspaces', () => {
  const state = {
    version: 2 as const,
    workspaceIdsByPath: {},
    legacySessionsMigrated: true,
    openPaths: ['/ws', '/plain-ws'],
    activePath: '/ws',
    recentPaths: [] as string[],
    uiStateByPath: {},
    settingsOverridesByPath: {}
  }
  return {
    getWorkspaces: vi.fn(() => state),
    readWorkspacesState: vi.fn(() => state),
    addWorkspace: vi.fn(),
    removeWorkspace: vi.fn(),
    setActiveWorkspace: vi.fn(),
    updateWorkspaceUiState: vi.fn(),
    setWorkspaceSettingsOverride: vi.fn(),
    findWorkspaceSettingsOverride: vi.fn(() => null),
    enqueueWorkspaceMutation: (fn: () => unknown) => Promise.resolve(fn())
  }
})

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: (path: import('fs').PathLike) => {
      const p = String(path).replace(/\\/g, '/')
      if (p === '/ws' || p === '/plain-ws') return true
      if (p.endsWith('/resources/harness/default.md')) {
        return p.startsWith('/ws/')
      }
      return actual.existsSync(path)
    }
  }
})

vi.mock('@main/app/window', () => ({
  applyTitleBarTheme: vi.fn(),
  getMainWindow: vi.fn(() => mockWin)
}))

vi.mock('@main/logging/init', () => ({
  logsDirectory: () => '/tmp/logs'
}))

vi.mock('@main/logging/sentry', () => ({
  applySentryTelemetry: vi.fn(),
  isSentryBuildConfigured: () => false
}))

import { registerIpc } from '@main/ipc/register'

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function chatEvents(): AgentEvent[] {
  return mockWcSend.mock.calls.map(([, ev]) => ev as AgentEvent)
}

describe('registerIpc', () => {
  beforeEach(() => {
    handlers.clear()
    mockWcSend.mockReset()
    mockWc.isDestroyed.mockReturnValue(false)
    mockWin.webContents = mockWc
    fromWebContents.mockReturnValue(mockWin)
    runAgentMock.mockReset()
    runExistsMock.mockReset()
    isActiveMock.mockReset()
    clearRunAbortMock.mockReset()
    markRunTurnCompleteMock.mockReset()
    registerRunAbortMock.mockReset()
    registerRunAbortMock.mockReturnValue({ controller: new AbortController(), invokeId: 42 })
    tryRegisterRunAbortMock.mockReset()
    tryRegisterRunAbortMock.mockReturnValue({
      ok: true as const,
      controller: new AbortController(),
      invokeId: 42
    })
    isRunTurnCompleteMock.mockReset()
    isRunTurnCompleteMock.mockReturnValue(false)
    waitUntilRunInactiveMock.mockReset()
    waitUntilRunInactiveMock.mockResolvedValue(true)
    isActiveMock.mockReturnValue(false)
    resolveWritesMock.mockReset()
    planRewindWritesMock.mockReset()
    planRewindWritesMock.mockReturnValue({ checkpointIds: [], files: [] })
    renameRunMock.mockReset()
    previewHarnessApplyMock.mockReset()
    previewHarnessApplyMock.mockImplementation(() => {
      throw new Error('No harness proposal found. Run `/harness-review` first.')
    })
    prepareRewindMock.mockReset()
    prepareRewindMock.mockResolvedValue({
      messages: [{ role: 'user' as const, content: 'edited' }],
      writes: { restored: [], checkpointIds: [] }
    })
    registerIpc()
  })

  afterEach(() => {
    handlers.clear()
  })

  describe('workspace Files IPC boundary', () => {
    const fileChannels = [
      IPC.workspaceFileList,
      IPC.workspaceFileRead,
      IPC.workspaceFileSave,
      IPC.workspaceFileCreate,
      IPC.workspaceFileMove,
      IPC.workspaceFileDelete,
      IPC.workspaceFileReveal,
      IPC.workspaceFormatterStatus,
      IPC.workspaceFormatFile,
      IPC.workspaceLspStatus,
      IPC.workspaceLspRequest,
      IPC.workspaceEditorRecoverySave,
      IPC.workspaceEditorRecoveryLoad,
      IPC.workspaceEditorRecoveryClear,
      IPC.gitBlame
    ] as const

    const validPayloads: Record<(typeof fileChannels)[number], unknown> = {
      [IPC.workspaceFileList]: {
        workspacePath: '/not-open',
        path: '',
        offset: 0,
        limit: 10
      },
      [IPC.workspaceFileRead]: { workspacePath: '/not-open', path: 'note.txt' },
      [IPC.workspaceFileSave]: {
        workspacePath: '/not-open',
        path: 'note.txt',
        kind: 'text',
        content: 'draft',
        encoding: 'utf8',
        eol: 'lf',
        bom: false,
        expectedVersion: null,
        replaceExisting: false
      },
      [IPC.workspaceFileCreate]: {
        workspacePath: '/not-open',
        parentPath: '',
        name: 'note.txt',
        kind: 'file',
        replaceExisting: false
      },
      [IPC.workspaceFileMove]: {
        workspacePath: '/not-open',
        fromPath: 'a.txt',
        toPath: 'b.txt',
        replaceExisting: false
      },
      [IPC.workspaceFileDelete]: {
        workspacePath: '/not-open',
        path: 'note.txt',
        recursive: false
      },
      [IPC.workspaceFileReveal]: {
        workspacePath: '/not-open',
        path: 'note.txt'
      },
      [IPC.workspaceFormatterStatus]: {
        workspacePath: '/not-open',
        path: 'note.ts'
      },
      [IPC.workspaceFormatFile]: {
        workspacePath: '/not-open',
        path: 'note.ts',
        content: 'draft'
      },
      [IPC.workspaceLspStatus]: {
        workspacePath: '/not-open',
        path: 'note.ts'
      },
      [IPC.workspaceLspRequest]: {
        workspacePath: '/not-open',
        path: 'note.ts',
        content: 'draft',
        action: 'diagnostics',
        line: 0,
        character: 0
      },
      [IPC.workspaceEditorRecoverySave]: {
        workspacePath: '/not-open',
        sessionToken: 'session-token-for-tests',
        generation: 1,
        snapshot: {
          version: 1,
          activeTabId: null,
          savedAt: new Date().toISOString(),
          tabs: []
        }
      },
      [IPC.workspaceEditorRecoveryLoad]: { workspacePath: '/not-open' },
      [IPC.workspaceEditorRecoveryClear]: {
        workspacePath: '/not-open',
        sessionToken: 'session-token-for-tests',
        generation: 1
      },
      [IPC.gitBlame]: {
        workspacePath: '/not-open',
        path: 'note.ts'
      }
    }

    it('rejects invalid senders for every Files/recovery handler', async () => {
      for (const channel of fileChannels) {
        fromWebContents.mockReturnValueOnce(null)
        const result = await handlers.get(channel)!({ sender: mockWc, senderFrame: mockMainFrame }, validPayloads[channel])
        expect(result).toEqual({ ok: false, error: 'Invalid sender' })
      }
    })

    it('rejects unopened workspaces before filesystem access', async () => {
      for (const channel of fileChannels) {
        const result = await handlers.get(channel)!({ sender: mockWc, senderFrame: mockMainFrame }, validPayloads[channel])
        expect(result).toEqual({ ok: false, error: 'Workspace is not open' })
      }
    })
  })

  describe('getSystemTheme', () => {
    it('rejects invalid senders', async () => {
      fromWebContents.mockReturnValueOnce(null)
      const handler = handlers.get(IPC.getSystemTheme)
      expect(handler).toBeTypeOf('function')

      const result = await handler!({ sender: {} })
      expect(result).toEqual({ ok: false, error: 'Invalid sender' })
    })

    it('rejects non-main-frame senders', async () => {
      const main = { id: 'main' }
      const subframe = { id: 'child' }
      const handler = handlers.get(IPC.getSystemTheme)
      const result = await handler!({
        sender: { ...mockWc, mainFrame: main },
        senderFrame: subframe
      })
      expect(result).toEqual({ ok: false, error: 'Invalid sender' })
    })

    it('accepts main-frame senders', async () => {
      const main = { id: 'main' }
      const handler = handlers.get(IPC.getSystemTheme)
      const result = await handler!({
        sender: { ...mockWc, mainFrame: main },
        senderFrame: main
      })
      expect(result).toEqual({ ok: true, data: true })
    })

    it('returns native theme for valid senders', async () => {
      const handler = handlers.get(IPC.getSystemTheme)
      const result = await handler!({ sender: mockWc, senderFrame: mockMainFrame })
      expect(result).toEqual({ ok: true, data: true })
    })
  })

  describe('chatStart defensive catch', () => {
    const chatStartPayload = {
      messages: [{ role: 'user' as const, content: 'hello' }],
      workspacePath: '/ws'
    }

    it('does not duplicate cancelled status when generator throws after terminal status', async () => {
      runAgentMock.mockImplementation(async function* () {
        yield { type: 'status', runId: 'run-test', status: 'cancelled' } satisfies AgentEvent
        throw new DOMException('Aborted', 'AbortError')
      })

      const handler = handlers.get(IPC.chatStart)
      await handler!({ sender: mockWc, senderFrame: mockMainFrame }, chatStartPayload)
      await flushAsync()

      const cancelled = chatEvents().filter(
        (ev) => ev.type === 'status' && ev.status === 'cancelled'
      )
      expect(cancelled).toHaveLength(1)
    })

    it('does not duplicate error terminal events when generator throws after status error', async () => {
      runAgentMock.mockImplementation(async function* () {
        yield { type: 'status', runId: 'run-test', status: 'error' } satisfies AgentEvent
        throw new Error('post-terminal throw')
      })

      const handler = handlers.get(IPC.chatStart)
      await handler!({ sender: mockWc, senderFrame: mockMainFrame }, chatStartPayload)
      await flushAsync()

      const statusErrors = chatEvents().filter(
        (ev) => ev.type === 'status' && ev.status === 'error'
      )
      const errors = chatEvents().filter((ev) => ev.type === 'error')
      expect(statusErrors).toHaveLength(1)
      expect(errors).toHaveLength(0)
    })

    it('still emits error terminal events when generator throws before terminal status', async () => {
      runAgentMock.mockImplementation(async function* () {
        yield { type: 'text_delta', runId: 'run-test', text: 'partial' } satisfies AgentEvent
        throw new Error('boom')
      })

      const handler = handlers.get(IPC.chatStart)
      await handler!({ sender: mockWc, senderFrame: mockMainFrame }, chatStartPayload)
      await flushAsync()

      const statusErrors = chatEvents().filter(
        (ev) => ev.type === 'status' && ev.status === 'error'
      )
      const errors = chatEvents().filter((ev) => ev.type === 'error')
      expect(statusErrors).toHaveLength(1)
      expect(errors).toHaveLength(1)
      if (errors[0]?.type === 'error') {
        expect(errors[0].message).toBe('boom')
      }
      expect(chatEvents().map((event) => event.type)).toEqual([
        'text_delta',
        'error',
        'status'
      ])
    })

    it('stamps the invoke on streamed and catch-path events', async () => {
      runAgentMock.mockImplementation(async function* () {
        yield { type: 'text_delta', runId: 'run-test', text: 'partial' } satisfies AgentEvent
        throw new Error('boom')
      })

      const handler = handlers.get(IPC.chatStart)
      await handler!({ sender: mockWc, senderFrame: mockMainFrame }, chatStartPayload)
      await flushAsync()

      const events = chatEvents()
      expect(events.length).toBeGreaterThan(0)
      for (const ev of events) {
        expect(ev.invokeId).toBe(42)
      }
    })

    it('reuses existing runId when run exists and is not active', async () => {
      runExistsMock.mockReturnValue(true)
      isActiveMock.mockReturnValue(false)
      runAgentMock.mockImplementation(async function* () {
        yield { type: 'status', runId: 'existing-run', status: 'done' } satisfies AgentEvent
      })

      const handler = handlers.get(IPC.chatStart)
      const result = await handler!(
        { sender: mockWc, senderFrame: mockMainFrame },
        {
          incremental: true,
          newMessages: [{ role: 'user' as const, content: 'follow up' }],
          workspacePath: '/ws',
          runId: 'existing-run'
        }
      )

      expect(result).toEqual({ ok: true, data: { runId: 'existing-run', invokeId: 42 } })
      expect(runAgentMock).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'existing-run',
          resume: true
        })
      )
    })

    it('rejects chatStart when requested run is already active', async () => {
      runExistsMock.mockReturnValue(true)
      isActiveMock.mockReturnValue(true)

      const handler = handlers.get(IPC.chatStart)
      const result = await handler!(
        { sender: mockWc, senderFrame: mockMainFrame },
        {
          incremental: true,
          newMessages: [{ role: 'user' as const, content: 'follow up' }],
          workspacePath: '/ws',
          runId: 'busy-run'
        }
      )

      expect(result).toEqual({ ok: false, error: 'Run is already active' })
      expect(runAgentMock).not.toHaveBeenCalled()
    })

    it('marks turn complete on terminal status; clearRunAbort owned by runAgent', async () => {
      runAgentMock.mockImplementation(async function* () {
        yield { type: 'status', runId: 'run-test', status: 'done' } satisfies AgentEvent
      })

      const handler = handlers.get(IPC.chatStart)
      await handler!({ sender: mockWc, senderFrame: mockMainFrame }, chatStartPayload)
      await flushAsync()

      expect(markRunTurnCompleteMock).toHaveBeenCalledWith('run-test', 42)
      // clearRunAbort is owned by runAgent's finally (mocked here).
      expect(clearRunAbortMock).not.toHaveBeenCalled()
    })
  })

  describe('chatRewindAndStart', () => {
    const rewindPayload = {
      workspacePath: '/ws',
      runId: 'run-edit',
      editMessageIndex: 0,
      editedUserMessage: { role: 'user' as const, content: 'edited' }
    }

    it('registers the run before preparing rewind on disk', async () => {
      const order: string[] = []
      tryRegisterRunAbortMock.mockImplementation(() => {
        order.push('register')
        return { ok: true as const, controller: new AbortController(), invokeId: 7 }
      })
      prepareRewindMock.mockImplementation(async () => {
        order.push('prepare')
        return {
          messages: [{ role: 'user' as const, content: 'edited' }],
          writes: { restored: [], checkpointIds: [] }
        }
      })
      runExistsMock.mockReturnValue(true)
      runAgentMock.mockImplementation(async function* () {
        yield { type: 'status', runId: 'run-edit', status: 'done' } satisfies AgentEvent
      })

      const handler = handlers.get(IPC.chatRewindAndStart)
      const result = await handler!({ sender: mockWc, senderFrame: mockMainFrame }, rewindPayload)

      expect(result).toEqual({ ok: true, data: { runId: 'run-edit', invokeId: 7 } })
      expect(order).toEqual(['register', 'prepare'])
    })

    it('clears the run slot when rewind prepare fails after register', async () => {
      runExistsMock.mockReturnValue(true)
      prepareRewindMock.mockRejectedValue(new Error('editMessageIndex out of range'))

      const handler = handlers.get(IPC.chatRewindAndStart)
      const result = await handler!({ sender: mockWc, senderFrame: mockMainFrame }, rewindPayload)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/editMessageIndex out of range/i)
        expect(result.code).not.toBe('IPC_HANDLER')
      }
      expect(tryRegisterRunAbortMock).toHaveBeenCalledWith('run-edit', '/ws')
      expect(clearRunAbortMock).toHaveBeenCalledWith('run-edit', 42)
      expect(runAgentMock).not.toHaveBeenCalled()
    })
  })

  describe('chatRewind', () => {
    const rewindPayload = {
      workspacePath: '/ws',
      runId: 'run-revert',
      userMessageIndex: 0
    }

    it('rewinds without starting a new agent run', async () => {
      runExistsMock.mockReturnValue(true)
      isActiveMock.mockReturnValue(false)

      const handler = handlers.get(IPC.chatRewind)
      const result = await handler!({ sender: mockWc, senderFrame: mockMainFrame }, rewindPayload)

      expect(result).toEqual({
        ok: true,
        data: {
          messages: [{ role: 'user', content: 'kept' }],
          restored: ['a.txt'],
          skipped: []
        }
      })
      expect(prepareRewindToUserMessageMock).toHaveBeenCalledWith({
        workspacePath: '/ws',
        runId: 'run-revert',
        userMessageIndex: 0
      })
      expect(tryRegisterRunAbortMock).not.toHaveBeenCalled()
      expect(runAgentMock).not.toHaveBeenCalled()
    })

    it('cancels an active run before rewinding', async () => {
      runExistsMock.mockReturnValue(true)
      isActiveMock.mockReturnValueOnce(true).mockReturnValue(false)
      const { chatCancelResult } = await import('@main/agent/runRegistry')
      vi.mocked(chatCancelResult).mockReturnValue({ ok: true, data: true })

      const handler = handlers.get(IPC.chatRewind)
      const result = await handler!({ sender: mockWc, senderFrame: mockMainFrame }, rewindPayload)

      expect(result.ok).toBe(true)
      expect(chatCancelResult).toHaveBeenCalledWith('run-revert')
      expect(waitUntilRunInactiveMock).toHaveBeenCalled()
    })

    it('maps userMessageIndex errors to user-facing fail', async () => {
      runExistsMock.mockReturnValue(true)
      isActiveMock.mockReturnValue(false)
      prepareRewindToUserMessageMock.mockRejectedValueOnce(
        new Error('userMessageIndex out of range')
      )

      const handler = handlers.get(IPC.chatRewind)
      const result = await handler!({ sender: mockWc, senderFrame: mockMainFrame }, rewindPayload)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/userMessageIndex out of range/i)
        expect(result.code).not.toBe('IPC_HANDLER')
      }
    })
  })

  describe('runsRename', () => {
    it('maps Cancel run first to user-facing fail', async () => {
      renameRunMock.mockImplementation(() => {
        throw new Error('Cancel run first')
      })
      const handler = handlers.get(IPC.runsRename)
      const result = await handler!(
        { sender: mockWc, senderFrame: mockMainFrame },
        { workspacePath: '/ws', runId: 'run-1', goal: 'new title' }
      )

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/cancel run first/i)
        expect(result.code).not.toBe('IPC_HANDLER')
      }
    })

    it('maps Run not found to user-facing fail', async () => {
      renameRunMock.mockImplementation(() => {
        throw new Error('Run not found')
      })
      const handler = handlers.get(IPC.runsRename)
      const result = await handler!(
        { sender: mockWc, senderFrame: mockMainFrame },
        { workspacePath: '/ws', runId: 'missing', goal: 'new title' }
      )

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/run not found/i)
        expect(result.code).not.toBe('IPC_HANDLER')
      }
    })
  })

  describe('harness preview/apply', () => {
    it('returns user-facing fail for preview when workspace has no editable harness', async () => {
      const handler = handlers.get(IPC.harnessPreviewApply)
      const result = await handler!(
        { sender: mockWc, senderFrame: mockMainFrame },
        {
          workspacePath: '/plain-ws',
          proposalPath: 'resources/harness/proposals/test.md'
        }
      )

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/no editable harness/i)
        expect(result.code).not.toBe('IPC_HANDLER')
      }
    })

    it('returns user-facing fail for apply when workspace has no editable harness', async () => {
      const handler = handlers.get(IPC.harnessApply)
      const result = await handler!(
        { sender: mockWc, senderFrame: mockMainFrame },
        {
          workspacePath: '/plain-ws',
          proposalPath: 'resources/harness/proposals/test.md',
          confirm: true
        }
      )

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/no editable harness/i)
        expect(result.code).not.toBe('IPC_HANDLER')
      }
    })

    it('returns user-facing fail for preview when harness proposal is missing', async () => {
      const handler = handlers.get(IPC.harnessPreviewApply)
      const result = await handler!({ sender: mockWc, senderFrame: mockMainFrame }, { workspacePath: '/ws' })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/no harness proposal/i)
        expect(result.code).not.toBe('IPC_HANDLER')
      }
    })
  })

  describe('runsResolveWrites', () => {
    it('maps already-resolved checkpoint errors to user-facing fail', async () => {
      resolveWritesMock.mockImplementation(() => {
        throw new Error('That checkpoint was already resolved')
      })
      const handler = handlers.get(IPC.runsResolveWrites)
      const result = await handler!(
        { sender: mockWc, senderFrame: mockMainFrame },
        {
          workspacePath: '/ws',
          runId: 'run-1',
          checkpointId: 'cp-1',
          action: 'keep'
        }
      )

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/already resolved/i)
        expect(result.code).not.toBe('IPC_HANDLER')
      }
    })

    it('returns ok for soft no-op when checkpointId is empty', async () => {
      resolveWritesMock.mockReturnValue({
        checkpointId: '',
        kept: [],
        discarded: [],
        skipped: [],
        fullyResolved: true
      })
      const handler = handlers.get(IPC.runsResolveWrites)
      const result = await handler!(
        { sender: mockWc, senderFrame: mockMainFrame },
        {
          workspacePath: '/ws',
          runId: 'run-1',
          action: 'keep'
        }
      )

      expect(result).toEqual({
        ok: true,
        data: {
          checkpointId: '',
          kept: [],
          discarded: [],
          skipped: [],
          fullyResolved: true
        }
      })
    })
  })

  describe('chatRewindPreview', () => {
    const previewPayload = {
      workspacePath: '/ws',
      runId: 'run-revert',
      userMessageIndex: 0
    }

    it('returns the planned file set without mutating anything', async () => {
      runExistsMock.mockReturnValue(true)
      isActiveMock.mockReturnValue(false)
      planRewindWritesMock.mockReturnValue({
        checkpointIds: ['cp-1'],
        files: [{ path: 'a.txt', action: 'modified', undoable: true }]
      })

      const handler = handlers.get(IPC.chatRewindPreview)
      const result = await handler!({ sender: mockWc, senderFrame: mockMainFrame }, previewPayload)

      expect(result).toEqual({
        ok: true,
        data: {
          checkpointIds: ['cp-1'],
          files: [{ path: 'a.txt', action: 'modified', undoable: true }]
        }
      })
      expect(planRewindWritesMock).toHaveBeenCalledWith(expect.any(String), 0)
    })

    it('refuses while a run is active', async () => {
      runExistsMock.mockReturnValue(true)
      isActiveMock.mockReturnValue(true)

      const handler = handlers.get(IPC.chatRewindPreview)
      const result = await handler!({ sender: mockWc, senderFrame: mockMainFrame }, previewPayload)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/stop the run/i)
      }
      expect(planRewindWritesMock).not.toHaveBeenCalled()
    })

    it('maps run-not-found to user-facing fail', async () => {
      runExistsMock.mockReturnValue(false)
      isActiveMock.mockReturnValue(false)

      const handler = handlers.get(IPC.chatRewindPreview)
      const result = await handler!({ sender: mockWc, senderFrame: mockMainFrame }, previewPayload)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/run not found/i)
        expect(result.code).not.toBe('IPC_HANDLER')
      }
    })
  })

  describe('mcpRefresh', () => {
    it('rejects a workspace path that is not open', async () => {
      const handler = handlers.get(IPC.mcpRefresh)
      expect(handler).toBeTypeOf('function')

      const result = await handler!({ sender: mockWc, senderFrame: mockMainFrame }, { workspacePath: '/not-open' })
      expect(result).toEqual({ ok: false, error: 'Workspace is not open' })
    })
  })

  describe('browserSetBounds', () => {
    it('accepts finite numeric bounds', async () => {
      const handler = handlers.get(IPC.browserSetBounds)
      expect(handler).toBeTypeOf('function')

      const result = await handler!(
        { sender: mockWc, senderFrame: mockMainFrame },
        { x: 10, y: 20, width: 300, height: 200 }
      )
      expect(result).toEqual({ ok: true, data: true })
    })

    it('clears bounds on a null payload', async () => {
      const handler = handlers.get(IPC.browserSetBounds)
      const result = await handler!({ sender: mockWc, senderFrame: mockMainFrame }, null)
      expect(result).toEqual({ ok: true, data: true })
    })

    it('rejects non-finite or missing bounds fields', async () => {
      const handler = handlers.get(IPC.browserSetBounds)

      const missing = await handler!({ sender: mockWc, senderFrame: mockMainFrame }, { x: 0, y: 0, width: 100 })
      expect(missing.ok).toBe(false)

      const nonFinite = await handler!(
        { sender: mockWc, senderFrame: mockMainFrame },
        { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 100 }
      )
      expect(nonFinite.ok).toBe(false)
    })
  })

  describe('workspacesRemove', () => {
    it('refuses close when active runs exist and stopActiveRuns is false', async () => {
      const { listActiveRuns } = await import('@main/agent/runRegistry')
      vi.mocked(listActiveRuns).mockReturnValueOnce([
        { runId: 'run-1', workspacePath: '/ws', invokeId: 1, pendingFollowUps: [] }
      ])

      const handler = handlers.get(IPC.workspacesRemove)
      const result = await handler!({ sender: mockWc, senderFrame: mockMainFrame }, { path: '/ws', stopActiveRuns: false })
      expect(result).toEqual({
        ok: false,
        error:
          'Workspace has 1 active run(s). Confirm “Stop run and close” to continue.'
      })
    })

    it('cancels active runs then removes when stopActiveRuns is true', async () => {
      const { listActiveRuns, chatCancelResult } = await import('@main/agent/runRegistry')
      const { removeWorkspace } = await import('@main/workspace/workspaces')
      vi.mocked(listActiveRuns).mockReturnValueOnce([
        { runId: 'run-1', workspacePath: '/ws', invokeId: 1, pendingFollowUps: [] }
      ])
      vi.mocked(removeWorkspace).mockReturnValueOnce({
        version: 2,
        workspaceIdsByPath: {},
        legacySessionsMigrated: true,
        openPaths: ['/plain-ws'],
        activePath: '/plain-ws',
        recentPaths: [],
        uiStateByPath: {},
        settingsOverridesByPath: {}
      })

      const handler = handlers.get(IPC.workspacesRemove)
      const result = await handler!({ sender: mockWc, senderFrame: mockMainFrame }, { path: '/ws', stopActiveRuns: true })
      expect(chatCancelResult).toHaveBeenCalledWith('run-1')
      expect(removeWorkspace).toHaveBeenCalledWith('/ws')
      expect(result).toEqual({
        ok: true,
        data: expect.objectContaining({ openPaths: ['/plain-ws'] })
      })
    })
  })
})
