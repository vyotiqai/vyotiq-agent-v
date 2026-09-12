import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'
import { resolveRunDir } from '@main/storage/paths'

const userData = join(tmpdir(), `vyotiq-stopreason-${process.pid}-${Date.now()}`)

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
    // Isolate stop-reason behavior from soft finish gates (default contract
    // may include a typecheck criterion; require mode would nudge forever here).
  }),
  readLegacyWorkspacePath: () => null
}))

vi.mock('@main/settings/secrets', () => ({
  getSecret: () => null,
  hasStoredSecretBlob: () => false,
  secretStatus: () => ({ encryptionAvailable: true, keys: {} })
}))
vi.mock('@main/agent/harness', () => ({ loadHarness: () => 'harness' }))

const { streamChat, executeTool, assembleContext } = vi.hoisted(() => ({
  streamChat: vi.fn(),
  executeTool: vi.fn(),
  assembleContext: vi.fn(async (input: { messages: unknown[] }) => ({
    messages: input.messages,
    system: 'system',
    estimatedTokens: 100,
    layers: { system: 10, history: 50, tools: 20, buffer: 20 },
    overflow: false,
    anthropicNative: undefined,
    compaction: null
  }))
}))

vi.mock('@main/agent/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/context')>()
  return {
    ...actual,
    assembleContext: (...args: unknown[]) => assembleContext(...args),
    ensureMemoryLayout: () => undefined
  }
})

vi.mock('@main/agent/providers', () => ({
  getProvider: () => ({ id: 'ollama', listModels: async () => [], streamChat }),
  listProviderModels: async () => ({
    models: [
      {
        id: 'qwen2.5',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: false
      }
    ]
  })
}))

vi.mock('@main/agent/tools', () => ({
  executeTool: (...args: unknown[]) => executeTool(...args)
}))

const { saveCompactionFails } = vi.hoisted(() => ({
  saveCompactionFails: { value: false }
}))

vi.mock('@main/agent/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/state')>()
  return {
    ...actual,
    saveCompaction: (...args: Parameters<typeof actual.saveCompaction>) =>
      saveCompactionFails.value ? false : actual.saveCompaction(...args)
  }
})

import { runAgent } from '@main/agent/loop'
import { enqueueFollowUp, resetActiveRunsForTests } from '@main/agent/runRegistry'
import { appendMessage, createRun, flushMessageAppends, loadCompaction } from '@main/agent/state'

type CapturedEvent = {
  type: string
  status?: string
  reason?: string
  content?: string
  code?: string
  message?: string
  toolCallId?: string
  name?: string
  argumentsDelta?: string
}

async function collect(runId: string, workspace: string): Promise<CapturedEvent[]> {
  const events: CapturedEvent[] = []
  for await (const ev of runAgent({
    runId,
    messages: [{ role: 'user', content: 'do the thing' }],
    workspacePath: workspace
  })) {
    events.push(ev as CapturedEvent)
  }
  return events
}

type StreamChatReq = {
  tools?: unknown[]
  toolChoice?: 'auto' | 'none' | 'required'
}

/** Auto-compaction is an isolated internal job, not a normal agent continuation. */
function isParentCompactFork(req: StreamChatReq): boolean {
  return (
    req.toolChoice === 'none' &&
    Array.isArray(req.tools) &&
    req.tools.length === 0 &&
    /internal session summarizer/i.test(String(req.system ?? ''))
  )
}

describe('runAgent stop-reason classification', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-stopreason-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
    executeTool.mockReset()
    assembleContext.mockReset()
    assembleContext.mockImplementation(async (input: { messages: unknown[] }) => ({
      messages: input.messages,
      system: 'system',
      estimatedTokens: 100,
      layers: { system: 10, history: 50, tools: 20, buffer: 20 },
      overflow: false,
      anthropicNative: undefined,
      compaction: null
    }))
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('auto-continues after a truncated step then finishes', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield { type: 'text', text: 'half an ans' }
        yield { type: 'done', stopReason: 'length' }
      } else {
        yield { type: 'text', text: 'wer completed' }
        yield { type: 'done', stopReason: 'stop' }
      }
    })

    const events = await collect('stop-truncated-continue', workspace)
    expect(call).toBe(2)
    expect(events.filter((e) => e.type === 'incomplete')).toHaveLength(1)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
  })

  it('auto-continues after repeated truncations then finishes', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call < 4) {
        yield { type: 'text', text: 'still going' }
        yield { type: 'done', stopReason: 'length' }
      } else {
        yield { type: 'text', text: 'finished' }
        yield { type: 'done', stopReason: 'stop' }
      }
    })

    const events = await collect('stop-truncated-multi', workspace)
    const incomplete = events.filter((e) => e.type === 'incomplete')

    expect(call).toBe(4)
    expect(incomplete).toHaveLength(3)
    expect(incomplete.every((e) => e.reason === 'truncated')).toBe(true)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
  })

  it('auto-continues after repeated empty responses then finishes', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call < 4) {
        yield { type: 'done', stopReason: 'stop' }
      } else {
        yield { type: 'text', text: 'recovered answer' }
        yield { type: 'done', stopReason: 'stop' }
      }
    })

    const events = await collect('stop-empty-multi', workspace)
    const incomplete = events.filter((e) => e.type === 'incomplete')

    expect(call).toBe(4)
    expect(incomplete).toHaveLength(3)
    expect(incomplete.every((e) => e.reason === 'empty_response')).toBe(true)
    expect(incomplete[0]?.message).toMatch(/retrying/i)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
    // 2026-09-01: the empty-response retry re-streams the SAME request — it must
    // not inject a synthetic user nudge. Run 707a561f leaked
    // "Your previous response was empty…" into messages.jsonl where it rendered
    // as a user chat bubble (session c3290c9d lines 459→460 on disk).
    const persisted = readFileSync(
      join(resolveRunDir(workspace, 'stop-empty-multi'), 'messages.jsonl'),
      'utf8'
    )
    expect(persisted).not.toContain('previous response was empty')
    expect(persisted).toContain('do the thing')
  })

  it('auto-continues once after an empty response then finishes', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield { type: 'done', stopReason: 'stop' }
      } else {
        yield { type: 'text', text: 'recovered answer' }
        yield { type: 'done', stopReason: 'stop' }
      }
    })

    const events = await collect('stop-empty-continue', workspace)
    expect(call).toBe(2)
    expect(events.filter((e) => e.type === 'incomplete')).toHaveLength(1)
    expect(events.find((e) => e.type === 'incomplete')?.reason).toBe('empty_response')
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
  })

  it('auto-continues after a reasoning-only response then finishes', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield { type: 'thinking_delta', text: 'I will make the edits next.' }
        yield {
          type: 'done',
          stopReason: 'stop',
          reasoningState: {
            kind: 'openai_compat',
            reasoningContent: 'I will make the edits next.'
          }
        }
      } else {
        yield { type: 'text', text: 'Recovered answer' }
        yield { type: 'done', stopReason: 'stop' }
      }
    })

    const runId = 'stop-reasoning-only-continue'
    const events = await collect(runId, workspace)
    const messagesPath = join(resolveRunDir(workspace, runId), 'messages.jsonl')
    const persisted = readFileSync(messagesPath, 'utf8')

    expect(call).toBe(2)
    expect(events.find((e) => e.type === 'incomplete')?.reason).toBe('empty_response')
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
    expect(persisted).not.toContain('I will make the edits next.')
    expect(persisted).toContain('Recovered answer')
  })

  it('reports a content filter stop', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'partial' }
      yield { type: 'done', stopReason: 'content_filter' }
    })

    const events = await collect('stop-filtered', workspace)

    expect(events.find((e) => e.type === 'incomplete')?.reason).toBe('filtered')
  })

  it('stays silent when the model finishes cleanly', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'all done' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const events = await collect('stop-clean', workspace)

    expect(events.some((e) => e.type === 'incomplete')).toBe(false)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
  })

  it('live-forwards tool_call chunks as tool_call_delta before assistant_message', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield { type: 'text', text: 'checking' }
        yield {
          type: 'tool_call',
          toolCall: { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'done' }
      yield { type: 'done', stopReason: 'stop' }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'ok' })

    const events = await collect('live-forward-tool', workspace)
    const deltaIdx = events.findIndex((e) => e.type === 'tool_call_delta')
    const msgIdx = events.findIndex((e) => e.type === 'assistant_message')

    expect(deltaIdx).toBeGreaterThanOrEqual(0)
    expect(msgIdx).toBeGreaterThan(deltaIdx)
    expect(events[deltaIdx]).toMatchObject({
      type: 'tool_call_delta',
      toolCallId: 'c1',
      name: 'read',
      argumentsDelta: '{"path":"a.ts"}'
    })

    const eventsPath = join(resolveRunDir(workspace, 'live-forward-tool'), 'events.jsonl')
    const persisted = readFileSync(eventsPath, 'utf8')
    expect(persisted).toContain('"type":"tool_call_delta"')
    expect(persisted).toContain('"toolCallId":"c1"')
  })

  it('does not concatenate full tool_call args on a second live-forward of the same id', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield {
          type: 'tool_call',
          toolCall: { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }
        }
        yield {
          type: 'tool_call',
          toolCall: { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'done' }
      yield { type: 'done', stopReason: 'stop' }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'ok' })

    const events = await collect('live-forward-dedupe', workspace)
    const deltas = events.filter((e) => e.type === 'tool_call_delta') as Array<{
      argumentsDelta?: string
    }>

    expect(deltas[0]?.argumentsDelta).toBe('{"path":"a.ts"}')
    expect(deltas[1]?.argumentsDelta).toBe('')
  })

  it('forwards complete tool_call args after chrome-only tool_call_delta', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield {
          type: 'tool_call_delta',
          toolCallDelta: { index: 0, id: 'c-edit', name: 'edit', arguments: '' }
        }
        yield {
          type: 'tool_call',
          toolCall: {
            id: 'c-edit',
            name: 'edit',
            arguments: '{"path":"src/app.ts","diff":"@@\\n+hello"}'
          }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'done' }
      yield { type: 'done', stopReason: 'stop' }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'src/app.ts', content: 'ok' })

    const events = await collect('live-forward-after-chrome', workspace)
    const deltas = events.filter((e) => e.type === 'tool_call_delta') as Array<{
      argumentsDelta?: string
      name?: string
    }>
    const joined = deltas.map((d) => d.argumentsDelta ?? '').join('')
    expect(joined).toContain('"path":"src/app.ts"')
    expect(joined).toContain('+hello')
  })

  it('merges args-only tool_call_delta onto the indexed id when later delta sends id:""', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield {
          type: 'tool_call_delta',
          toolCallDelta: {
            index: 0,
            id: 'call_57e537a25d04434a8489d688',
            name: 'web_fetch',
            arguments: ''
          }
        }
        yield {
          type: 'tool_call_delta',
          toolCallDelta: {
            index: 0,
            id: '',
            arguments: '{"url":"https://example.com"}'
          }
        }
        yield {
          type: 'tool_call',
          toolCall: {
            id: 'call_57e537a25d04434a8489d688',
            name: 'web_fetch',
            arguments: '{"url":"https://example.com"}'
          }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'done' }
      yield { type: 'done', stopReason: 'stop' }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'fetched', content: 'ok' })

    const events = await collect('deepseek-empty-id-args', workspace)
    const deltas = events.filter((e) => e.type === 'tool_call_delta')
    const argsDelta = deltas.find((e) => e.argumentsDelta?.includes('example.com'))

    expect(argsDelta?.toolCallId).toBe('call_57e537a25d04434a8489d688')
    expect(executeTool).toHaveBeenCalled()
  })

  it('reports truncation when stopReason is tool_calls but no tools were parsed', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield { type: 'text', text: 'about to call' }
        yield { type: 'done', stopReason: 'tool_calls' }
      } else {
        yield { type: 'text', text: 'finished after truncated tool_calls' }
        yield { type: 'done', stopReason: 'stop' }
      }
    })

    const events = await collect('stop-tool-parse-fail', workspace)

    expect(events.find((e) => e.type === 'incomplete')?.reason).toBe('truncated')
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
  })

  it('reports truncation when a provider error arrives after partial text', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield { type: 'text', text: 'partial answer' }
        yield { type: 'done', stopReason: 'error' }
      } else {
        yield { type: 'text', text: 'finished after truncated error' }
        yield { type: 'done', stopReason: 'stop' }
      }
    })

    const events = await collect('stop-error-partial', workspace)

    expect(events.find((e) => e.type === 'incomplete')?.reason).toBe('truncated')
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
  })

  it('treats a missing stop reason with real text as a clean finish', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'answer' }
      yield { type: 'done' }
    })

    const events = await collect('stop-unset', workspace)

    expect(events.some((e) => e.type === 'incomplete')).toBe(false)
  })

  it('stops with context_overflow when assemble stays over budget after auto compact', async () => {
    assembleContext.mockImplementation(async (input: { messages: unknown[] }) => ({
      messages: input.messages,
      system: 'system',
      systemStable: 'system',
      estimatedTokens: 200_000,
      layers: { system: 10, history: 50, tools: 20, buffer: 20 },
      overflow: true,
      anthropicNative: undefined,
      compaction: null
    }))

    streamChat.mockImplementation(async function* (req: StreamChatReq): AsyncGenerator<StreamChunk> {
      if (req.toolChoice === 'none') {
        yield { type: 'text', text: '## Session Intent\nFolded summary' }
        yield { type: 'done' }
        return
      }
      yield { type: 'text', text: 'should not stream' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const runId = 'overflow-stop'
    const runDir = createRun(workspace, runId, 'goal')
    for (let i = 0; i < 6; i++) {
      await appendMessage(runDir, { role: 'user', content: `old-u-${i}` })
      await appendMessage(runDir, { role: 'assistant', content: `old-a-${i}` })
    }
    await flushMessageAppends(runDir)

    const events: CapturedEvent[] = []
    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'continue' }],
      workspacePath: workspace,
      resume: true,
      newMessages: [{ role: 'user', content: 'continue' }]
    })) {
      events.push(ev as CapturedEvent)
    }

    expect(events.find((e) => e.type === 'incomplete')?.reason).toBe('context_overflow')
    expect(events.some((e) => e.type === 'status' && e.status === 'error')).toBe(true)
    expect(events.some((e) => e.type === 'text_delta')).toBe(false)
    expect(streamChat.mock.calls.some((c) => isParentCompactFork(c[0] as StreamChatReq))).toBe(true)
  })

  it('ends the step when auto compact cannot persist compaction.json', async () => {
    saveCompactionFails.value = true
    assembleContext.mockImplementation(async (input: { messages: unknown[] }) => ({
      messages: input.messages,
      system: 'system',
      systemStable: 'system',
      estimatedTokens: 200_000,
      layers: { system: 10, history: 50, tools: 20, buffer: 20 },
      overflow: true,
      anthropicNative: undefined,
      compaction: null
    }))
    streamChat.mockImplementation(async function* (req: StreamChatReq): AsyncGenerator<StreamChunk> {
      if (req.toolChoice === 'none') {
        yield { type: 'text', text: '## Session Intent\nFolded summary' }
        yield { type: 'done' }
        return
      }
      yield { type: 'text', text: 'should not stream' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const runId = 'auto-compact-persist-fail'
    const runDir = createRun(workspace, runId, 'goal')
    for (let i = 0; i < 6; i++) {
      await appendMessage(runDir, { role: 'user', content: `old-u-${i}` })
      await appendMessage(runDir, { role: 'assistant', content: `old-a-${i}` })
    }
    await flushMessageAppends(runDir)

    const events: CapturedEvent[] = []
    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'continue' }],
      workspacePath: workspace,
      resume: true,
      newMessages: [{ role: 'user', content: 'continue' }]
    })) {
      events.push(ev as CapturedEvent)
    }

    expect(events.some((e) => e.type === 'status' && e.status === 'error')).toBe(true)
    expect(events.some((e) => e.type === 'text_delta')).toBe(false)
    expect(streamChat.mock.calls.some((c) => isParentCompactFork(c[0] as StreamChatReq))).toBe(true)
  })

  it('ends the step when auto compact retry cannot persist compaction.json', async () => {
    saveCompactionFails.value = true
    let assembleCall = 0
    assembleContext.mockImplementation(async (input: { messages: unknown[] }) => {
      assembleCall += 1
      return {
        messages: input.messages,
        system: 'system',
        systemStable: 'system',
        estimatedTokens: 200_000,
        layers: { system: 10, history: 50, tools: 20, buffer: 20 },
        overflow: true,
        anthropicNative: undefined,
        compaction: null
      }
    })
    streamChat.mockImplementation(async function* (req: StreamChatReq): AsyncGenerator<StreamChunk> {
      if (req.toolChoice === 'none') {
        yield { type: 'text', text: '## Session Intent\nFolded summary' }
        yield { type: 'done' }
        return
      }
      yield { type: 'text', text: 'should not stream' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const runId = 'auto-compact-retry-persist-fail'
    const runDir = createRun(workspace, runId, 'goal')
    for (let i = 0; i < 6; i++) {
      await appendMessage(runDir, { role: 'user', content: `old-u-${i}` })
      await appendMessage(runDir, { role: 'assistant', content: `old-a-${i}` })
    }
    await flushMessageAppends(runDir)

    const events: CapturedEvent[] = []
    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'continue' }],
      workspacePath: workspace,
      resume: true,
      newMessages: [{ role: 'user', content: 'continue' }]
    })) {
      events.push(ev as CapturedEvent)
    }

    expect(streamChat.mock.calls.some((c) => isParentCompactFork(c[0] as StreamChatReq))).toBe(true)
    expect(events.some((e) => e.type === 'status' && e.status === 'error')).toBe(true)
    expect(events.some((e) => e.type === 'text_delta')).toBe(false)
  })
})

describe('runAgent partial persistence', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-partial-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
    executeTool.mockReset()
    assembleContext.mockReset()
    assembleContext.mockImplementation(async (input: { messages: unknown[] }) => ({
      messages: input.messages,
      system: 'system',
      estimatedTokens: 100,
      layers: { system: 10, history: 50, tools: 20, buffer: 20 },
      overflow: false,
      anthropicNative: undefined,
      compaction: null
    }))
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('keeps text that streamed before a non-retriable provider error', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'streamed before the failure' }
      yield { type: 'error', error: 'HTTP 400: bad request' }
    })

    const runId = 'partial-on-error'
    const events = await collect(runId, workspace)

    expect(events.some((e) => e.type === 'error' && e.code === 'PROVIDER_STREAM')).toBe(true)

    const messages = readFileSync(join(resolveRunDir(workspace, runId), 'messages.jsonl'), 'utf8')
    expect(messages).toContain('streamed before the failure')
  })

  it('recovers from a retriable thrown stream error (no exhaustion stop)', async () => {
    const { RetriableStreamError } = await import('@main/agent/providers/fetchWithRetry')
    let attempt = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      attempt += 1
      yield { type: 'text', text: 'partial before disconnect' }
      if (attempt === 1) throw new RetriableStreamError('stream ended')
      yield { type: 'done', stopReason: 'stop' }
    })

    const events = await collect('thrown-stream-recovered', workspace)

    // No attempt ceiling (cap removed): the retriable throw retries until the
    // stream recovers instead of ending the run.
    expect(attempt).toBe(2)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
    expect(events.some((e) => e.type === 'incomplete')).toBe(false)

    const messages = readFileSync(
      join(resolveRunDir(workspace, 'thrown-stream-recovered'), 'messages.jsonl'),
      'utf8'
    )
    expect(messages).toContain('partial before disconnect')
  })

  it('retries a PROVIDER_NETWORK error chunk once and finishes the step', async () => {
    let attempt = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      attempt += 1
      if (attempt === 1) {
        yield {
          type: 'error',
          error: 'Connect timed out waiting for response headers after 30000ms',
          errorCode: 'PROVIDER_NETWORK'
        }
        return
      }
      yield { type: 'text', text: 'recovered after reconnect' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const events = await collect('network-chunk-retry', workspace)

    expect(attempt).toBe(2)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
    expect(events.some((e) => e.type === 'incomplete')).toBe(false)
  })

  it('keeps queued follow-ups on disk through a retried network outage', async () => {
    const runId = 'network-chunk-recovered'
    let calls = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      calls += 1
      if (calls === 1) {
        const queued = enqueueFollowUp(runId, { role: 'user', content: 'queued before outage' })
        expect(queued.ok).toBe(true)
        yield {
          type: 'error',
          error: 'Connect timed out waiting for response headers after 30000ms',
          errorCode: 'PROVIDER_NETWORK'
        }
        return
      }
      // No attempt ceiling (cap removed): the outage retries until recovery.
      yield { type: 'text', text: 'recovered after reconnect' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const events = await collect(runId, workspace)

    expect(events.some((e) => e.type === 'follow_up_dropped')).toBe(false)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
    expect(events.some((e) => e.type === 'incomplete')).toBe(false)
  })

  it('emits stream_reset so the UI drops output from a retried attempt', async () => {
    let attempt = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      attempt += 1
      if (attempt === 1) {
        yield { type: 'text', text: 'doomed first attempt' }
        yield { type: 'error', error: 'socket hang up' }
        return
      }
      yield { type: 'text', text: 'good second attempt' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const events = await collect('partial-retry', workspace)

    expect(events.some((e) => e.type === 'stream_reset')).toBe(true)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)
  })

  it('emits stream_reset when the failed attempt only streamed tool deltas', async () => {
    let attempt = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      attempt += 1
      if (attempt === 1) {
        yield {
          type: 'tool_call_delta',
          toolCallDelta: {
            index: 0,
            id: 'call_1',
            name: 'read',
            arguments: '{"path":'
          }
        }
        yield { type: 'error', error: 'socket hang up' }
        return
      }
      yield { type: 'text', text: 'recovered' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const runId = 'tool-delta-retry'
    const events = await collect(runId, workspace)

    expect(events.some((e) => e.type === 'stream_reset')).toBe(true)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)

    const eventsPath = join(resolveRunDir(workspace, runId), 'events.jsonl')
    const persisted = readFileSync(eventsPath, 'utf8')
    expect(persisted).toContain('"type":"stream_reset"')
    // Stale chrome from attempt 1 is followed by a persisted reset before recovery text.
    const resetIdx = persisted.indexOf('"type":"stream_reset"')
    const deltaIdx = persisted.indexOf('"toolCallId":"call_1"')
    expect(deltaIdx).toBeGreaterThanOrEqual(0)
    expect(resetIdx).toBeGreaterThan(deltaIdx)
  })

  it('retries a usage-limit 429 until recovery (no exhaustion stop)', async () => {
    const runId = 'quota-chunk-then-circuit'
    let calls = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      calls += 1
      // Wire shape from run 6265fa90: PROVIDER_HTTP 429 with the quota body.
      // Quota errors are no longer a terminal class, and the attempt ceiling
      // is gone (run-stopping caps removed): the 429 retries until the
      // stream recovers instead of ending the run.
      if (calls === 1) {
        yield {
          type: 'error',
          error:
            'Weekly usage limit reached. Resets in 6 days. To continue using this model now, enable usage from your available balance.',
          errorCode: 'PROVIDER_HTTP',
          httpStatus: 429
        }
        return
      }
      yield { type: 'text', text: 'recovered after quota window' }
      yield { type: 'done', stopReason: 'stop' }
    })

    const events = await collect(runId, workspace)

    expect(calls).toBe(2)
    expect(
      events.some((e) => e.type === 'error' && e.code === 'QUOTA_EXHAUSTED')
    ).toBe(false)
    expect(events.some((e) => e.type === 'incomplete')).toBe(false)
    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)

    const statusFile = readFileSync(
      join(resolveRunDir(workspace, runId), 'status.json'),
      'utf8'
    )
    const status = JSON.parse(statusFile) as { status?: string; error?: string }
    expect(status.status).toBe('done')
    expect(status.error ?? '').not.toContain('Weekly usage limit reached')
  })

  it('stops resumably when the exhausted class carries a quota message', async () => {
    const runId = 'quota-exhausted-class'
    let calls = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      calls += 1
      if (calls === 1) {
        yield {
          type: 'error',
          error: 'Weekly usage limit reached. Resets in 6 days. To continue using this model now, enable usage from your available balance.',
          errorCode: 'PROVIDER_HTTP',
          httpStatus: 429
        }
        return
      }
      yield { type: 'error', error: 'Circuit open for http:opencode.ai; retry in 59s', errorCode: 'CIRCUIT_OPEN' }
    })

    const events = await collect(runId, workspace)

    expect(
      events.some((e) => e.type === 'error' && e.code === 'QUOTA_EXHAUSTED')
    ).toBe(false)
    // circuit_open stop path removed: a circuit-shaped stream error now
    // surfaces as the resumable network-interrupted class instead.
    expect(
      events.some((e) => e.type === 'incomplete' && e.reason === 'network_interrupted')
    ).toBe(true)
    expect(calls).toBeGreaterThanOrEqual(1)
  })
})
