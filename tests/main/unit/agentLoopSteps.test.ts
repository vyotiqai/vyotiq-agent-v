import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ProviderChatRequest, StreamChunk } from '@main/agent/providers/types'
import { resolveRunDir } from '@main/storage/paths'

const userData = join(tmpdir(), `vyotiq-steps-${process.pid}-${Date.now()}`)

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

vi.mock('@main/agent/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/context')>()
  return {
    ...actual,
    assembleContext: async (input: { messages: unknown[] }) => ({
      messages: input.messages,
      system: 'system',
      estimatedTokens: 100,
      layers: { system: 10, history: 50, tools: 20, buffer: 20 },
      anthropicNative: undefined,
      compaction: null
    }),
    ensureMemoryLayout: () => undefined
  }
})

const { streamChat, executeTool } = vi.hoisted(() => ({
  streamChat: vi.fn(),
  executeTool: vi.fn()
}))

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
        supportsTools: true,
        supportsVision: false
      }
    ]
  })
}))

vi.mock('@main/agent/tools', () => ({
  executeTool: (...args: unknown[]) => executeTool(...args)
}))

import { runAgent } from '@main/agent/loop'
import { resetActiveRunsForTests } from '@main/agent/runRegistry'
import { flushEventAppends } from '@main/agent/eventAppendQueue'

describe('runAgent steps', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-steps-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
    executeTool.mockReset()
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('exits with done when tool steps complete successfully', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield {
          type: 'tool_call',
          toolCall: { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'Both files read.' }
      yield { type: 'done', stopReason: 'end_turn' }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'body' })

    const runId = 'max-steps-done'
    const events: Array<{ type: string; status?: string; code?: string; reason?: string }> = []

    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'read files' }],
      workspacePath: workspace
    })) {
      events.push(ev)
    }

    expect(events.some((e) => e.type === 'status' && e.status === 'done')).toBe(true)

    const eventsPath = join(resolveRunDir(workspace, runId), 'events.jsonl')
    const persisted = readFileSync(eventsPath, 'utf8')
    expect(persisted).toContain('"status":"done"')
    expect(persisted).toContain('"runId":"max-steps-done"')
  })

  it('emits step_usage when the provider reports token usage', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'done' }
      yield {
        type: 'done',
        usage: { inputTokens: 1200, outputTokens: 40, cachedInputTokens: 900 }
      }
    })

    const runId = 'step-usage'
    const events: Array<{ type: string; cachedInputTokens?: number }> = []
    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'hello' }],
      workspacePath: workspace
    })) {
      events.push(ev)
    }

    const usage = events.find((e) => e.type === 'step_usage')
    expect(usage?.cachedInputTokens).toBe(900)
    expect(typeof (usage as { generationMs?: number } | undefined)?.generationMs).toBe('number')

    const eventsPath = join(resolveRunDir(workspace, runId), 'events.jsonl')
    expect(readFileSync(eventsPath, 'utf8')).toContain('"type":"step_usage"')
    expect(readFileSync(eventsPath, 'utf8')).toContain('"cachedInputTokens":900')
    expect(readFileSync(eventsPath, 'utf8')).toContain('"source":"provider"')
    expect(events.filter((e) => e.type === 'context_usage').length).toBeGreaterThanOrEqual(1)
    const providerCtx = events.find(
      (e) => e.type === 'context_usage' && (e as { source?: string }).source === 'provider'
    ) as { inputTokens?: number } | undefined
    expect(providerCtx?.inputTokens).toBe(1200)
  })

  it('persists reasoning once per assistant message (no thinking + reasoningState double-store)', async () => {
    const think = 'Need the file before answering.'
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'thinking_delta', text: think }
      yield { type: 'thinking_done', text: think }
      yield { type: 'text', text: 'Here you go.' }
      yield {
        type: 'done',
        stopReason: 'end_turn',
        reasoningState: { kind: 'openai_compat', reasoningContent: think }
      }
    })

    const runId = 'reasoning-once'
    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'hello' }],
      workspacePath: workspace
    })) {
      void _ev
    }

    const messagesPath = join(resolveRunDir(workspace, runId), 'messages.jsonl')
    const rows = readFileSync(messagesPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const assistants = rows.filter((m) => m.role === 'assistant')
    expect(assistants.length).toBeGreaterThan(0)
    for (const row of assistants) {
      const hasThinking = typeof row.thinking === 'string' && row.thinking.length > 0
      const state = row.reasoningState as { reasoningContent?: string } | undefined
      const stateText = typeof state?.reasoningContent === 'string' ? state.reasoningContent : ''
      // Exactly one representation of the reasoning words per message.
      expect(Boolean(hasThinking) !== Boolean(stateText)).toBe(true)
      // And it is the wire payload that survives (replay source of truth).
      if (stateText) expect(stateText).toBe(think)
    }
    // Answer text is untouched.
    expect(rows.some((m) => m.role === 'assistant' && m.content === 'Here you go.')).toBe(true)
  })

  it('does not persist thinking bytes into stream_snapshot events', async () => {
    const think = 'Long reasoning streamed over several seconds.'
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'thinking_delta', text: think }
      yield { type: 'thinking_done', text: think }
      yield { type: 'text', text: 'Answer.' }
      yield {
        type: 'done',
        stopReason: 'end_turn',
        reasoningState: { kind: 'openai_compat', reasoningContent: think }
      }
    })

    const runId = 'snapshot-no-thinking'
    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'hello' }],
      workspacePath: workspace
    })) {
      void _ev
    }

    // Appends are serialized asynchronously — flush before reading, or the
    // final snapshot may not have landed yet (this read used to race it).
    await flushEventAppends()
    const eventsPath = join(resolveRunDir(workspace, runId), 'events.jsonl')
    const persisted = readFileSync(eventsPath, 'utf8')
    // Answer-text snapshots ARE durable (a hard kill recovers from
    // events.jsonl); the invariant is that no snapshot carries thinking bytes.
    const snapshotLines = persisted
      .split('\n')
      .filter((line) => line.includes('"type":"stream_snapshot"'))
    for (const line of snapshotLines) {
      expect(line).not.toContain('Long reasoning')
    }
    expect(persisted).toContain('"type":"thinking_done"')
    expect(persisted).toContain('Long reasoning')
  })

  it('merges multi-block thinking_done segments instead of dropping earlier blocks', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      // Anthropic shape: one thinking_done per thinking block.
      yield { type: 'thinking_delta', text: 'plan the change' }
      yield { type: 'thinking_done', text: 'plan the change' }
      yield { type: 'thinking_delta', text: 'check the tests' }
      yield { type: 'thinking_done', text: 'check the tests' }
      yield { type: 'text', text: 'Done.' }
      yield {
        type: 'done',
        stopReason: 'end_turn',
        reasoningState: {
          kind: 'anthropic',
          blocks: [
            { type: 'thinking', thinking: 'plan the change' },
            { type: 'thinking', thinking: 'check the tests' }
          ]
        }
      }
    })

    const runId = 'multi-block-thinking'
    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'hello' }],
      workspacePath: workspace
    })) {
      void _ev
    }

    const messagesPath = join(resolveRunDir(workspace, runId), 'messages.jsonl')
    const rows = readFileSync(messagesPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const assistant = rows.find((m) => m.role === 'assistant')
    expect(assistant).toBeDefined()
    // With a derivable reasoningState the display copy is not double-stored;
    // the state payload keeps every block.
    expect(assistant?.reasoningState).toMatchObject({
      blocks: [
        { type: 'thinking', thinking: 'plan the change' },
        { type: 'thinking', thinking: 'check the tests' }
      ]
    })
  })

  it('replaces thinking with a longer done snapshot instead of duplicating the buffer', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'thinking_delta', text: 'partial thought' }
      // OpenAI-compat message snapshot: done text supersedes the streamed buffer.
      yield { type: 'thinking_done', text: 'partial thought extended into the full text' }
      yield { type: 'text', text: 'Answer.' }
      yield {
        type: 'done',
        stopReason: 'end_turn',
        reasoningState: { kind: 'openai_compat', reasoningContent: 'partial thought extended into the full text' }
      }
    })

    const runId = 'done-replace-thinking'
    const doneThinking: string[] = []
    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'hello' }],
      workspacePath: workspace
    })) {
      if (ev.type === 'thinking_done') doneThinking.push(ev.text ?? '')
    }

    // No doubled buffer in the emitted done event.
    expect(doneThinking.some((t) => t.includes('partial thought partial thought'))).toBe(false)
  })
})
