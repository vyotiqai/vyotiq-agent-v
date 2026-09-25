import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'

const userData = join(tmpdir(), `vyotiq-auto-${process.pid}-${Date.now()}`)

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
    toolApproval: { mode: 'all', allowlist: [] },
    autonomousMode: true,
    autonomousSkipQuestions: 'skip'
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
const executeTool = vi.fn()

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

describe('agentLoopAutonomous', () => {
  const workspace = join(tmpdir(), `vyotiq-auto-ws-${process.pid}`)

  beforeEach(() => {
    resetActiveRunsForTests()
    mkdirSync(workspace, { recursive: true })
    streamChat.mockReset()
    executeTool.mockReset()
    // ToolResult contract (src/main/agent/tools/index.ts): { ok, summary, content }.
    // A bare string here crashes runSingleTool's failure-log path (result.content.split).
    executeTool.mockResolvedValue({ ok: true, summary: 'read', content: 'file contents' })
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      const n = streamChat.mock.calls.length
      if (n === 1) {
        yield {
          type: 'tool_call',
          toolCall: { id: 'c1', name: 'read', arguments: JSON.stringify({ path: 'a.ts' }) }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'done' }
      yield { type: 'done', stopReason: 'end_turn' }
    })
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  })

  it('completes a gated read tool without a renderer approval sender', async () => {
    const events: { type: string; status?: string; ok?: boolean }[] = []
    for await (const ev of runAgent({
      runId: 'auto-run',
      messages: [{ role: 'user', content: 'autonomous read' }],
      workspacePath: workspace
    })) {
      events.push(ev as { type: string; status?: string; ok?: boolean })
    }
    expect(executeTool).toHaveBeenCalled()
    expect(events.some((e) => e.type === 'tool_result' && e.ok === false)).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'done' })
  })
})
