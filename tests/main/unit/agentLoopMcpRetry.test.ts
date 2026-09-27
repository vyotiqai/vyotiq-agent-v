import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk, ToolDefinition } from '@main/agent/providers/types'

const userData = join(tmpdir(), `vyotiq-mcp-retry-${process.pid}-${Date.now()}`)

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

const { mcp } = vi.hoisted(() => ({
  mcp: {
    /** Server status as `getMcpServerStatus` reports it. */
    failed: false,
    generation: 0,
    tools: [] as ToolDefinition[],
    syncCalls: [] as Array<{ forceRetryFailures?: boolean }>,
    /** Resolves the one retry-only sync the test holds open. */
    finishRetry: null as (() => void) | null
  }
}))

vi.mock('@main/agent/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/mcp')>()
  return {
    ...actual,
    syncMcpServers: vi.fn((_servers: unknown, opts?: { forceRetryFailures?: boolean }) => {
      mcp.syncCalls.push({ ...opts })
      if (!opts?.forceRetryFailures) return Promise.resolve()
      return new Promise<void>((resolve) => {
        mcp.finishRetry = resolve
      })
    }),
    getMcpServerStatus: () =>
      mcp.failed ? [{ id: 'notion', enabled: true, connected: false, error: 'connect failed' }] : [],
    getMcpSessionGeneration: () => mcp.generation,
    listMcpToolDefinitions: () => mcp.tools
  }
})

vi.mock('@main/marketplace/resolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/marketplace/resolve')>()
  const servers = [{ id: 'notion', name: 'Notion', transport: 'http', url: 'https://x', enabled: true, autoLoad: true }]
  return {
    ...actual,
    mcpSessionMapFingerprint: () => 'fp',
    resolveMcpServersForSessionMap: () => servers,
    resolveEffectiveMcpServers: () => servers
  }
})

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({
    provider: 'ollama',
    model: 'qwen2.5',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    theme: 'system',
    telemetryEnabled: false
  }),
  readLegacyWorkspacePath: () => null
}))

vi.mock('@main/settings/secrets', () => ({
  getSecret: () => null,
  hasStoredSecretBlob: () => false,
  secretStatus: () => ({ encryptionAvailable: true, keys: {} })
}))

vi.mock('@main/agent/harness', () => ({ loadHarness: () => 'harness' }))

const { streamChat, executeTool, toolCatalogs } = vi.hoisted(() => ({
  streamChat: vi.fn(),
  executeTool: vi.fn(),
  toolCatalogs: [] as string[][]
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
      overflow: false,
      compaction: null
    }),
    ensureMemoryLayout: () => undefined
  }
})

vi.mock('@main/agent/providers', () => ({
  getProvider: () => ({
    id: 'ollama',
    listModels: async () => [],
    streamChat: (req: { tools?: { name: string }[] }, ...rest: unknown[]) => {
      toolCatalogs.push((req.tools ?? []).map((t) => t.name))
      return streamChat(req, ...rest)
    }
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

describe('runAgent MCP failure retry', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-mcp-retry-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    Object.assign(mcp, { failed: false, generation: 0, tools: [], syncCalls: [], finishRetry: null })
    toolCatalogs.length = 0
    resetActiveRunsForTests()
    streamChat.mockReset()
    executeTool.mockReset()
  })

  afterEach(() => {
    mcp.finishRetry?.()
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  // A server that failed to connect is retried once per run. Awaited, a slow
  // reconnect held the step for up to the whole connect budget (120s).
  it('reconnects a failed server in the background, and admits its tools once it lands', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        // The server drops after the run's first sync.
        mcp.failed = true
      }
      if (call === 2) {
        // Step 2 went ahead without waiting; now the reconnect lands.
        mcp.tools = [{ name: 'mcp__notion__search', description: 'search', parameters: { type: 'object' } }]
        mcp.generation += 1
        mcp.finishRetry?.()
      }
      if (call < 3) {
        yield { type: 'tool_call', toolCall: { id: `c${call}`, name: 'read', arguments: '{"path":"a.ts"}' } }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'done' }
      yield { type: 'done', stopReason: 'stop' }
    })
    executeTool.mockResolvedValue({ ok: true, summary: 'file', content: 'body' })

    const run = (async () => {
      for await (const _ev of runAgent({
        runId: 'mcp-retry-background',
        messages: [{ role: 'user', content: 'work' }],
        workspacePath: workspace
      })) {
        // drain
      }
    })()
    const stalled = new Promise<'stalled'>((resolve) => setTimeout(() => resolve('stalled'), 8_000))
    expect(await Promise.race([run.then(() => 'finished' as const), stalled])).toBe('finished')

    expect(mcp.syncCalls.some((c) => c.forceRetryFailures)).toBe(true)
    // The generation bump rebuilt the catalog: the reconnected server's tool
    // (autoLoad) reached the wire on the step after it landed.
    expect(toolCatalogs[1]).not.toContain('mcp__notion__search')
    expect(toolCatalogs[2]).toContain('mcp__notion__search')
  }, 20_000)
})
