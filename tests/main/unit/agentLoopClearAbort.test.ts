import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'

const userData = join(tmpdir(), `vyotiq-clear-abort-${process.pid}-${Date.now()}`)

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

vi.mock('@main/agent/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/state')>()
  return {
    ...actual,
    flushMessageAppends: vi.fn(async (dir?: string) => {
      await actual.flushMessageAppends(dir)
      throw new Error('forced append flush failure')
    })
  }
})

import { runAgent } from '@main/agent/loop'
import { isActive, resetActiveRunsForTests } from '@main/agent/runRegistry'

describe('runAgent finally always clears run abort', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-clear-abort-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('clears isActive even when flushMessageAppends throws in finally', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'hello' }
    })

    const runId = 'flush-fail-run'
    // Drain the generator fully so the outer finally (including clearRunAbort) runs.
    // Do not wrap in expect(...).resolves — that can mask a hanging generator and
    // skip the isActive assertion if the promise never settles as expected.
    const events: unknown[] = []
    for await (const ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'hi' }],
      workspacePath: workspace
    })) {
      events.push(ev)
    }

    expect(events.length).toBeGreaterThan(0)
    expect(isActive(runId)).toBe(false)
  })
})
