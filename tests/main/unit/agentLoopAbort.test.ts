import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ProviderChatRequest, StreamChunk } from '@main/agent/providers/types'
import { resolveRunDir } from '@main/storage/paths'

const userData = join(tmpdir(), `vyotiq-loop-${process.pid}-${Date.now()}`)

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
      compaction: null
    }),
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
import { cancelRun, resetActiveRunsForTests } from '@main/agent/runRegistry'
import { loadMessages } from '@main/agent/state'

describe('runAgent abort during provider stream', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-loop-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('persists partial assistant text when SSE aborts mid-stream', async () => {
    streamChat.mockImplementation(async function* (
      req: ProviderChatRequest
    ): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'partial ' }
      while (!req.signal.aborted) {
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new DOMException('Aborted', 'AbortError')
    })

    const runId = 'abort-stream-run'
    const events: Array<{ type: string; status?: string; content?: string; text?: string }> = []

    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'hello' }],
      workspacePath: workspace
    })) {
      events.push(ev)
      if (ev.type === 'text_delta') cancelRun(runId)
    }

    expect(events.some((e) => e.type === 'text_delta' && e.text === 'partial ')).toBe(true)
    expect(
      events.some(
        (e) => e.type === 'assistant_message' && String(e.content).trim() === 'partial'
      )
    ).toBe(true)
    expect(events.some((e) => e.type === 'status' && e.status === 'cancelled')).toBe(true)

    const messages = loadMessages(workspace, runId)
    expect(
      messages.some((m) => m.role === 'assistant' && String(m.content).trim() === 'partial')
    ).toBe(true)

    const eventsPath = join(resolveRunDir(workspace, runId), 'events.jsonl')
    const persisted = readFileSync(eventsPath, 'utf8')
    expect(persisted).toContain('"status":"cancelled"')
  })
})
