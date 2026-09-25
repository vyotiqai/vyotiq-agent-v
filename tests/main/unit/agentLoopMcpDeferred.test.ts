import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk, ToolDefinition } from '@main/agent/providers/types'
import type { ToolExecutionContext } from '@main/agent/tools'

const userData = join(tmpdir(), `vyotiq-mcp-deferred-${process.pid}-${Date.now()}`)

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

function mcpTool(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    parameters: { type: 'object', properties: { query: { type: 'string' } } }
  }
}

/** Two connected servers — a fat one and a small one, like the reported install. */
const CONNECTED_MCP_TOOLS = [
  mcpTool('mcp__notion__search', 'search notion'),
  mcpTool('mcp__notion__create_pages', 'create notion pages'),
  mcpTool('mcp__github__list_prs', 'list pull requests')
]

vi.mock('@main/agent/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/mcp')>()
  return {
    ...actual,
    syncMcpServers: vi.fn(async () => {}),
    getMcpServerStatus: () => [],
    listMcpToolDefinitions: () => CONNECTED_MCP_TOOLS
  }
})

/** Mutable so a test can flip a server's autoLoad the way Marketplace does. */
const { mcpServerList } = vi.hoisted(() => ({
  mcpServerList: [] as Array<Record<string, unknown>>
}))

vi.mock('@main/marketplace/resolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/marketplace/resolve')>()
  return {
    ...actual,
    mcpSessionMapFingerprint: () => 'fp',
    resolveMcpServersForSessionMap: () => mcpServerList,
    resolveEffectiveMcpServers: () => mcpServerList
  }
})

const settings: Record<string, unknown> = {}

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({
    provider: 'ollama',
    model: 'qwen2.5',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    theme: 'system',
    telemetryEnabled: false,
    ...settings
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

const { streamChat, executeTool, toolCatalogs, mcpSections } = vi.hoisted(() => ({
  streamChat: vi.fn(),
  executeTool: vi.fn(),
  toolCatalogs: [] as string[][],
  mcpSections: [] as string[]
}))

vi.mock('@main/agent/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/context')>()
  return {
    ...actual,
    assembleContext: async (input: { messages: unknown[]; mcpSection?: string }) => {
      mcpSections.push(input.mcpSection ?? '')
      return {
        messages: input.messages,
        system: 'system',
        estimatedTokens: 100,
        layers: { system: 10, history: 50, tools: 20, buffer: 20 },
        overflow: false,
        compaction: null
      }
    },
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

function mcpNames(names: string[]): string[] {
  return names.filter((n) => n.startsWith('mcp__'))
}

async function drain(runId: string, workspace: string, prompt?: string): Promise<void> {
  for await (const _ev of runAgent({
    runId,
    messages: [{ role: 'user', content: prompt ?? 'Look something up' }],
    workspacePath: workspace
  })) {
    // Drain the run.
  }
}

describe('runAgent MCP tool loading', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-mcp-deferred-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    mkdirSync(join(userData, 'marketplace', 'packages'), { recursive: true })
    toolCatalogs.length = 0
    mcpSections.length = 0
    for (const key of Object.keys(settings)) delete settings[key]
    mcpServerList.length = 0
    mcpServerList.push(
      { id: 'notion', name: 'Notion', transport: 'http', url: 'https://x', enabled: true },
      { id: 'github', name: 'GitHub', transport: 'http', url: 'https://y', enabled: true }
    )
    resetActiveRunsForTests()
    streamChat.mockReset()
    executeTool.mockReset()
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('sends no MCP schemas by default and lists the servers instead', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'Nothing to do.' }
      yield { type: 'done', stopReason: 'end_turn' }
    })

    await drain('mcp-deferred-default', workspace)

    expect(toolCatalogs.length).toBeGreaterThan(0)
    // The regression this guards: 95 connected tools rode every step.
    expect(mcpNames(toolCatalogs[0] ?? [])).toEqual([])
    expect(toolCatalogs[0]).toContain('read')
    expect(toolCatalogs[0]).toContain('request_mcp_tools')
    const section = mcpSections[0] ?? ''
    expect(section).toContain('<mcp_servers>')
    expect(section).toContain('- notion (2): search, create_pages')
    expect(section).toContain('- github (1): list_prs')
  })

  it('puts a requested server on the wire from the next step, and only that server', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield {
          type: 'tool_call',
          toolCall: {
            id: 'c1',
            name: 'request_mcp_tools',
            arguments: '{"serverId":"github"}'
          }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'Done.' }
      yield { type: 'done', stopReason: 'end_turn' }
    })
    // Stand in for the real handler: it loads the server into the run set.
    executeTool.mockImplementation(async (...args: unknown[]) => {
      const context = args[4] as ToolExecutionContext
      context.runAttachedMcpServerIds?.add('github')
      context.invalidateMcpToolCatalogCache?.()
      return { ok: true, summary: 'github', content: 'Loaded' }
    })

    await drain('mcp-deferred-request', workspace)

    expect(toolCatalogs.length).toBeGreaterThanOrEqual(2)
    expect(mcpNames(toolCatalogs[0] ?? [])).toEqual([])
    expect(mcpNames(toolCatalogs[1] ?? [])).toEqual(['mcp__github__list_prs'])
    // The fat server stays off the wire — loading one must not load all.
    expect(toolCatalogs[1]?.some((n) => n.startsWith('mcp__notion__'))).toBe(false)
    const later = mcpSections[1] ?? ''
    expect(later).toContain("Loaded in this step's tool catalog: github")
    expect(later).toContain('- notion (2)')
  })

  it('eager mode still sends every connected tool', async () => {
    settings.mcpToolLoading = 'eager'
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'Nothing to do.' }
      yield { type: 'done', stopReason: 'end_turn' }
    })

    await drain('mcp-deferred-eager', workspace)

    expect(mcpNames(toolCatalogs[0] ?? []).sort()).toEqual([
      'mcp__github__list_prs',
      'mcp__notion__create_pages',
      'mcp__notion__search'
    ])
  })

  it('pre-loads a tool the user named, so /mcp costs no extra step', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'Nothing to do.' }
      yield { type: 'done', stopReason: 'end_turn' }
    })

    await drain(
      'mcp-deferred-seed',
      workspace,
      'Use the MCP tool `search` from server `notion`. (mcp__notion__search)'
    )

    expect(mcpNames(toolCatalogs[0] ?? [])).toEqual(['mcp__notion__search'])
    // One named tool, not its whole server.
    expect(toolCatalogs[0]).not.toContain('mcp__notion__create_pages')
  })

  it('ignores a named tool no connected server offers', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'Nothing to do.' }
      yield { type: 'done', stopReason: 'end_turn' }
    })

    await drain('mcp-deferred-seed-unknown', workspace, 'Try mcp__notion__made_up please')

    expect(mcpNames(toolCatalogs[0] ?? [])).toEqual([])
  })

  it('per-server autoLoad wins over the on-demand default', async () => {
    mcpServerList[1]!.autoLoad = true
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'Nothing to do.' }
      yield { type: 'done', stopReason: 'end_turn' }
    })

    await drain('mcp-deferred-autoload', workspace)

    expect(mcpNames(toolCatalogs[0] ?? [])).toEqual(['mcp__github__list_prs'])
    expect(mcpSections[0] ?? '').toContain("Loaded in this step's tool catalog: github")
  })
})
