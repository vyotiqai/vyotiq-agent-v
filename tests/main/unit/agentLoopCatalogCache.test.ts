import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'

const userData = join(tmpdir(), `vyotiq-catalog-cache-${process.pid}-${Date.now()}`)

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

const { listMcpToolDefinitionsMock, syncMcpServersMock } = vi.hoisted(() => ({
  listMcpToolDefinitionsMock: vi.fn(() => []),
  syncMcpServersMock: vi.fn(async () => {})
}))

vi.mock('@main/agent/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/mcp')>()
  return {
    ...actual,
    syncMcpServers: syncMcpServersMock,
    listMcpToolDefinitions: listMcpToolDefinitionsMock
  }
})

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({
    provider: 'ollama',
    model: 'qwen2.5',
    ollamaBaseUrl: 'http://[IP_ADDRESS]:11434',
    theme: 'system',
    telemetryEnabled: false,
    autoModeSwitch: false
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

describe('step tool catalog rebuild cache', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-catalog-cache-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
    executeTool.mockReset()
    listMcpToolDefinitionsMock.mockClear()
    syncMcpServersMock.mockClear()
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('builds the catalog once and early-returns on later steps', async () => {
    // loop.ts used to embed ::${step}:: in catalogFp, so the per-step
    // early-return could never hit and the catalog was rebuilt every step.
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call <= 2) {
        yield {
          type: 'tool_call',
          toolCall: { id: `c${call}`, name: 'read', arguments: '{"path":"a.ts"}' }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'done' }
      yield { type: 'done', stopReason: 'end_turn' }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'a.ts', content: 'file body' })

    for await (const _ev of runAgent({
      runId: 'catalog-cache',
      messages: [{ role: 'user', content: 'review a.ts' }],
      workspacePath: workspace
    })) {
      // Drain the run.
    }

    // Pre-loop refresh builds once; the per-step refreshes (step > initialStep+1)
    // must hit the fingerprint early-return instead of rebuilding.
    expect(listMcpToolDefinitionsMock).toHaveBeenCalledTimes(1)
    expect(syncMcpServersMock).toHaveBeenCalledTimes(1)
  })
})
