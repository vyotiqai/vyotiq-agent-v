import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'

const userData = join(tmpdir(), `vyotiq-resume-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => '/tmp/vyotiq-app',
    isPackaged: false
  }
}))

vi.mock('@main/agent/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/mcp')>()
  return {
    ...actual,
    syncMcpServers: vi.fn(async () => {}),
    listMcpToolDefinitions: () => []
  }
})

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({
    provider: 'ollama',
    model: 'qwen2.5',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    theme: 'system',
    telemetryEnabled: false,
  }),
  readLegacyWorkspacePath: () => null
}))

vi.mock('@main/settings/secrets', () => ({
  getSecret: () => null,
  hasStoredSecretBlob: () => false,
  secretStatus: () => ({ encryptionAvailable: true, keys: {} })
}))

vi.mock('@main/agent/harness', () => ({
  loadHarness: () => 'harness'
}))

const assembleContextMock = vi.fn(async (input: {
  messages: unknown[]
  priorCompaction?: unknown
}) => ({
  messages: input.messages,
  system: 'system',
  estimatedTokens: 100,
  layers: { system: 10, history: 50, tools: 20, buffer: 20 },
  overflow: false,
  anthropicNative: undefined,
  compaction: null
}))

vi.mock('@main/agent/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/context')>()
  return {
    ...actual,
    assembleContext: (input: Parameters<typeof assembleContextMock>[0]) => assembleContextMock(input),
    ensureMemoryLayout: () => undefined
  }
})

const streamChat = vi.fn()

vi.mock('@main/agent/providers', () => ({
  getProvider: () => ({
    id: 'ollama',
    listModels: async () => [],
    streamChat
  }),
  listProviderModels: async () => ({
    models: [
      {
        id: 'qwen2.5',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: false,
        supportsVision: false
      }
    ]
  })
}))

vi.mock('@main/agent/tools', () => ({
  executeTool: vi.fn()
}))

import { runAgent } from '@main/agent/loop'
import { isActive, registerRunAbort, resetActiveRunsForTests } from '@main/agent/runRegistry'
import {
  appendMessage,
  createRun,
  flushMessageAppends,
  flushStatusWrites,
  interruptOrphanRuns,
  loadCompaction,
  loadMessages,
  loadStatus,
  saveCompaction,
  syncMessages,
  updateStatus
} from '@main/agent/state'
import { RUN_INTERRUPTED_ERROR } from '@shared/runInterrupt'
import { LOOP_CHECKPOINT_VERSION } from '@shared/ipc/schemas/agent'
import { resolveRunDir } from '@main/storage/paths'
import { saveLoopCheckpoint, loadLoopCheckpoint } from '@main/agent/loopCheckpoint'

describe('runAgent session continuation', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-resume-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
    assembleContextMock.mockClear()
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('clears active state after a turn completes', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'hello' }
    })

    const runId = 'session-run'
    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'hi' }],
      workspacePath: workspace
    })) {
      // drain
    }

    expect(isActive(runId)).toBe(false)
  })

  it('resumes the same runId after the previous turn completes', async () => {
    const runId = 'session-run'

    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'hello' }
    })

    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'hi' }],
      workspacePath: workspace
    })) {
      // drain
    }

    expect(isActive(runId)).toBe(false)
    const runDir = resolveRunDir(workspace, runId)
    const priorStep = loadStatus(runDir)?.step ?? 0
    await flushStatusWrites(runDir)
    await updateStatus(runDir, { status: 'error', error: 'stale failure' }, { sync: true })

    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'file list' }
    })

    // chatStart pre-registers before runAgent (startup cancel race).
    registerRunAbort(runId, workspace)

    const events: Array<{ type: string; status?: string; code?: string; message?: string }> = []
    for await (const ev of runAgent({
      runId,
      incremental: true,
      newMessages: [{ role: 'user', content: 'list all the files' }],
      workspacePath: workspace,
      resume: true
    })) {
      events.push(ev)
    }

    expect(events.some((e) => e.type === 'error' && e.code === 'RUN_ACTIVE')).toBe(false)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
    expect(isActive(runId)).toBe(false)

    const messages = loadMessages(workspace, runId)
    expect(messages).toHaveLength(4)
    expect(messages[2]).toMatchObject({ role: 'user', content: 'list all the files' })
    expect(messages[3]).toMatchObject({ role: 'assistant', content: 'file list' })
    expect(loadStatus(runDir)).toMatchObject({
      status: 'done',
      step: priorStep + 1
    })
    expect(loadStatus(runDir)?.error).toBeUndefined()
  })

  it('loads persisted compaction when resuming a run', async () => {
    const runId = 'compact-resume'
    const runDir = createRun(workspace, runId, 'goal')
    const record = {
      summary: '## Session Intent\nPrior work summary',
      createdAt: new Date().toISOString(),
      tokenEstimate: 120
    }
    saveCompaction(runDir, record)

    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'ok' }
    })

    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'continue' }],
      workspacePath: workspace
    })) {
      // drain
    }

    expect(loadCompaction(runDir)).toEqual(record)
    expect(assembleContextMock).toHaveBeenCalled()
    const input = assembleContextMock.mock.calls[0]?.[0] as { priorCompaction?: unknown }
    expect(input.priorCompaction).toEqual(record)
  })

  it('ignores stale client messages and merges only newMessages from disk', async () => {
    const runId = 'disk-first'
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'first' }
    })

    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'real first' }],
      workspacePath: workspace
    })) {
      // drain
    }

    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'second' }
    })
    registerRunAbort(runId, workspace)

    for await (const _ev of runAgent({
      runId,
      // Stale/wrong full history must not rewrite disk.
      messages: [{ role: 'user', content: 'stale rewrite' }],
      incremental: true,
      newMessages: [{ role: 'user', content: 'follow up' }],
      workspacePath: workspace,
      resume: true
    })) {
      // drain
    }

    const messages = loadMessages(workspace, runId)
    expect(messages.map((m) => m.content)).toEqual([
      'real first',
      'first',
      'follow up',
      'second'
    ])
    expect(messages.some((m) => m.content === 'stale rewrite')).toBe(false)
  })

  it('dedupes newMessages already persisted on disk', async () => {
    const runId = 'dedupe-resume'
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'hello' }
    })

    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'hi' }],
      workspacePath: workspace
    })) {
      // drain
    }

    // Simulate chatStart having already appended the follow-up user turn.
    const runDir = resolveRunDir(workspace, runId)
    appendMessage(runDir, { role: 'user', content: 'list files' })
    await flushMessageAppends(runDir)

    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'listed' }
    })
    registerRunAbort(runId, workspace)

    for await (const _ev of runAgent({
      runId,
      incremental: true,
      newMessages: [{ role: 'user', content: 'list files' }],
      workspacePath: workspace,
      resume: true
    })) {
      // drain
    }

    const messages = loadMessages(workspace, runId)
    const userTurns = messages.filter((m) => m.role === 'user' && m.content === 'list files')
    expect(userTurns).toHaveLength(1)
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: 'listed' })
  })

  it('dedupes the full persisted prefix of newMessages', async () => {
    const runId = 'dedupe-prefix-resume'
    const runDir = createRun(workspace, runId, 'goal')
    appendMessage(runDir, { role: 'user', content: 'first replayed turn' })
    appendMessage(runDir, { role: 'user', content: 'second replayed turn' })
    await flushMessageAppends(runDir)

    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'continued once' }
    })
    registerRunAbort(runId, workspace)

    for await (const _ev of runAgent({
      runId,
      incremental: true,
      newMessages: [
        { role: 'user', content: 'first replayed turn' },
        { role: 'user', content: 'second replayed turn' },
        { role: 'user', content: 'new turn' }
      ],
      workspacePath: workspace,
      resume: true
    })) {
      // drain
    }

    const messages = loadMessages(workspace, runId)
    expect(messages.filter((m) => m.content === 'first replayed turn')).toHaveLength(1)
    expect(messages.filter((m) => m.content === 'second replayed turn')).toHaveLength(1)
    expect(messages.filter((m) => m.content === 'new turn')).toHaveLength(1)
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: 'continued once' })
  })

  it('clamps a corrupt foldedMessages watermark so the latest turn stays visible', async () => {
    const runId = 'watermark-clamp'
    const runDir = createRun(workspace, runId, 'goal')
    appendMessage(runDir, { role: 'user', content: 'old' })
    appendMessage(runDir, { role: 'assistant', content: 'prior' })
    await flushMessageAppends(runDir)
    saveCompaction(runDir, {
      summary: 'prior summary',
      createdAt: new Date().toISOString(),
      tokenEstimate: 50,
      foldedMessages: 99
    })

    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'continued' }
    })
    registerRunAbort(runId, workspace)

    for await (const _ev of runAgent({
      runId,
      incremental: true,
      newMessages: [{ role: 'user', content: 'keep me' }],
      workspacePath: workspace,
      resume: true
    })) {
      // drain
    }

    expect(assembleContextMock).toHaveBeenCalled()
    const input = assembleContextMock.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>
    }
    expect(input.messages.some((m) => m.content === 'keep me')).toBe(true)
    expect(input.messages).not.toHaveLength(0)

    const clamped = loadCompaction(runDir)
    expect(clamped?.foldedMessages).toBe(2)
    expect(clamped?.summary).toBe('prior summary')
  })

  it('ignores provider done.compaction (LLM-only compaction)', async () => {
    const runId = 'server-compact'
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'folding' }
      yield { type: 'done', compaction: '## Server compaction\nNew intent' }
    })

    for await (const _ev of runAgent({
      runId,
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
        { role: 'user', content: 'three' }
      ],
      workspacePath: workspace
    })) {
      // drain
    }

    const record = loadCompaction(resolveRunDir(workspace, runId))
    expect(record).toBeNull()
  })

  it('does not emit compaction_started when there is nothing to fold', async () => {
    const runId = 'fold-skip'
    assembleContextMock.mockImplementationOnce(async (input: { messages: unknown[] }) => ({
      messages: input.messages,
      system: 'system',
      estimatedTokens: 200_000,
      layers: { system: 10, history: 30, tools: 20, buffer: 20 },
      overflow: true,
      anthropicNative: undefined,
      compaction: null
    }))

    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'too short to fold' }
      yield { type: 'done' }
    })

    const events: Array<{ type: string }> = []
    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'one' }],
      workspacePath: workspace
    })) {
      events.push(ev)
    }

    expect(events.some((e) => e.type === 'compaction_started')).toBe(false)
    expect(events.some((e) => e.type === 'compaction')).toBe(false)
    expect(loadCompaction(resolveRunDir(workspace, runId))).toBeNull()
  })

  it('persists foldedMessages after auto LLM compaction', async () => {
    const runId = 'fold-persist'
    assembleContextMock.mockImplementationOnce(async (input: { messages: unknown[] }) => ({
      messages: input.messages,
      system: 'system',
      estimatedTokens: 200_000,
      layers: { system: 10, history: 30, tools: 20, buffer: 20 },
      overflow: true,
      anthropicNative: undefined,
      compaction: null
    }))

    streamChat.mockImplementation(async function* (req: {
      tools?: unknown[]
    }): AsyncGenerator<StreamChunk> {
      if (!Array.isArray(req.tools) || req.tools.length === 0) {
        yield { type: 'text', text: '## Session Intent\nFolded prior turns' }
        yield { type: 'done' }
        return
      }
      yield { type: 'text', text: 'after fold' }
      yield { type: 'done' }
    })

    const events: Array<{ type: string }> = []
    for await (const ev of runAgent({
      runId,
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
        { role: 'user', content: 'three' },
        { role: 'assistant', content: 'four' }
      ],
      workspacePath: workspace
    })) {
      events.push(ev)
    }

    expect(events.some((e) => e.type === 'compaction_started')).toBe(true)
    expect(events.some((e) => e.type === 'compaction')).toBe(true)
    const startedAt = events.findIndex((e) => e.type === 'compaction_started')
    const foldedAt = events.findIndex((e) => e.type === 'compaction')
    expect(startedAt).toBeGreaterThanOrEqual(0)
    expect(foldedAt).toBeGreaterThan(startedAt)

    const record = loadCompaction(resolveRunDir(workspace, runId))
    expect(record?.foldedMessages).toBe(2)
    expect(record?.summary).toContain('Folded prior turns')
  })

  it('resumes after orphan interrupt using disk messages without a new user turn', async () => {
    const runId = 'orphan-resume'
    const runDir = createRun(workspace, runId, 'crash goal')
    syncMessages(runDir, [
      { role: 'user', content: 'do work' },
      { role: 'assistant', content: 'partial reply' }
    ])
    await updateStatus(runDir, { status: 'running', step: 4 }, { sync: true })

    const interrupted = await interruptOrphanRuns([workspace])
    expect(interrupted).toBe(1)
    expect(loadStatus(runDir)).toMatchObject({
      status: 'cancelled',
      resumable: true,
      step: 4,
      error: RUN_INTERRUPTED_ERROR
    })

    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'resumed work' }
    })
    registerRunAbort(runId, workspace)

    for await (const _ev of runAgent({
      runId,
      messages: [],
      workspacePath: workspace,
      resume: true
    })) {
      // drain
    }

    expect(loadMessages(workspace, runId)).toEqual([
      { role: 'user', content: 'do work' },
      { role: 'assistant', content: 'partial reply' },
      { role: 'assistant', content: 'resumed work' }
    ])
    expect(loadStatus(runDir)?.resumable).toBeUndefined()
    expect(loadStatus(runDir)?.status).toBe('done')
  })

  it('emits a terminal-loss notice when resuming an interrupted run', async () => {
    const runId = 'terminal-loss-resume'
    const runDir = createRun(workspace, runId, 'crash goal')
    syncMessages(runDir, [{ role: 'user', content: 'run terminal' }])
    await updateStatus(runDir, { status: 'cancelled', resumable: true, step: 2 }, { sync: true })

    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'continued' }
    })
    registerRunAbort(runId, workspace)

    const events: Array<{ type: string; message?: string }> = []
    for await (const ev of runAgent({
      runId,
      messages: [],
      workspacePath: workspace,
      resume: true
    })) {
      events.push(ev)
    }

    expect(
      events.some(
        (e) =>
          e.type === 'token_cost_hint' &&
          e.message?.includes('background terminal sessions from before the interruption')
      )
    ).toBe(true)
  })

  it('auto-continues truncation after resume even when checkpoint already counted continues', async () => {
    const runId = 'checkpoint-truncation-resume'
    const runDir = createRun(workspace, runId, 'crash goal')
    syncMessages(runDir, [{ role: 'user', content: 'long answer' }])
    await updateStatus(runDir, { status: 'cancelled', resumable: true, step: 3 }, { sync: true })
    saveLoopCheckpoint(runDir, {
      version: LOOP_CHECKPOINT_VERSION,
      step: 3,
      invokeId: 2,
      updatedAt: new Date().toISOString(),
      truncationContinues: 2,
      overflowRetryUsed: true
    })

    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield { type: 'text', text: 'still going' }
        yield { type: 'done', stopReason: 'length' }
      } else {
        yield { type: 'text', text: 'completed' }
        yield { type: 'done', stopReason: 'stop' }
      }
    })
    registerRunAbort(runId, workspace)

    const events: Array<{ type: string; reason?: string; message?: string; status?: string }> = []
    for await (const ev of runAgent({
      runId,
      messages: [],
      workspacePath: workspace,
      resume: true
    })) {
      events.push(ev)
    }

    const incomplete = events.filter((e) => e.type === 'incomplete')
    expect(incomplete.length).toBeGreaterThanOrEqual(1)
    expect(incomplete[0]?.reason).toBe('truncated')
    expect(incomplete[0]?.message).toMatch(/continuing automatically/i)
    expect(streamChat).toHaveBeenCalledTimes(2)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
  })

  it('does not restore loop checkpoint on follow-up resume after done', async () => {
    const runId = 'checkpoint-follow-up-resume'
    const runDir = createRun(workspace, runId, 'first goal')
    syncMessages(runDir, [{ role: 'user', content: 'first' }])
    await updateStatus(runDir, { status: 'done', resumable: false, step: 2 }, { sync: true })
    saveLoopCheckpoint(runDir, {
      version: LOOP_CHECKPOINT_VERSION,
      step: 2,
      invokeId: 1,
      updatedAt: new Date().toISOString(),
      truncationContinues: 2,
      overflowRetryUsed: true
    })

    let calls = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      calls += 1
      if (calls === 1) {
        yield { type: 'text', text: 'follow-up answer' }
        yield { type: 'done', stopReason: 'length' }
        return
      }
      yield { type: 'text', text: 'completed' }
      yield { type: 'done', stopReason: 'stop' }
    })
    registerRunAbort(runId, workspace)

    const events: Array<{ type: string; reason?: string; message?: string; status?: string }> = []
    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'follow up' }],
      workspacePath: workspace,
      resume: true
    })) {
      events.push(ev)
    }

    expect(
      events.some(
        (e) => e.type === 'incomplete' && e.message?.match(/continuing automatically/i)
      )
    ).toBe(true)
    expect(streamChat).toHaveBeenCalledTimes(2)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
    expect(loadLoopCheckpoint(runDir)).toBeNull()
  })
})

