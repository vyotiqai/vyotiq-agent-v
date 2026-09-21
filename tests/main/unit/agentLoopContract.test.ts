import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'
import { resolveRunDir } from '@main/storage/paths'

const userData = join(tmpdir(), `vyotiq-contract-${process.pid}-${Date.now()}`)

const assembleContext = vi.hoisted(() => vi.fn())

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
    assembleContext,
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

describe('runAgent contract refresh', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-contract-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
    executeTool.mockReset()
    assembleContext.mockReset()
    assembleContext.mockImplementation(async (input: { messages: unknown[]; contract?: string }) => ({
      messages: input.messages,
      system: `contract:${input.contract ?? ''}`,
      estimatedTokens: 100,
      layers: { system: 10, history: 50, tools: 20, buffer: 20 },
      compaction: null
    }))
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('re-reads contract.md at the start of each step', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield {
          type: 'tool_call',
          toolCall: { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }
        }
      } else {
        yield { type: 'text', text: 'done' }
      }
      yield { type: 'done' }
    })

    const runId = 'contract-refresh'
    executeTool.mockImplementation(async () => {
      const runDir = resolveRunDir(workspace, runId)
      writeFileSync(join(runDir, 'contract.md'), '## Goal\n\nupdated contract\n', 'utf8')
      return { ok: true, summary: 'file', content: 'body' }
    })

    for await (const _ev of runAgent({
      runId,
      messages: [{ role: 'user', content: 'work' }],
      workspacePath: workspace
    })) {
      // drain
    }

    expect(assembleContext).toHaveBeenCalledTimes(2)
    const contracts = assembleContext.mock.calls.map(
      (call) => (call[0] as { contract?: string }).contract ?? ''
    )
    expect(contracts[0]).not.toContain('updated contract')
    expect(contracts[1]).toContain('updated contract')

    const contractOnDisk = readFileSync(join(resolveRunDir(workspace, runId), 'contract.md'), 'utf8')
    expect(contractOnDisk).toContain('updated contract')
  })
})
