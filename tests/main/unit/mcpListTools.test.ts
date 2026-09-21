import { describe, expect, it, vi, beforeEach } from 'vitest'

const listMcpToolDefinitions = vi.hoisted(() =>
  vi.fn(() => [
    {
      name: 'mcp__github__list_issues',
      description: 'list issues',
      parameters: { type: 'object', properties: {} }
    },
    {
      name: 'mcp__gitlab__list_issues',
      description: 'list gitlab issues',
      parameters: { type: 'object', properties: {} }
    },
    {
      name: 'mcp__github__create_issue',
      description: 'create',
      parameters: { type: 'object', properties: {} }
    }
  ])
)

const getMcpServerStatus = vi.hoisted(() => vi.fn(() => []))

vi.mock('@main/agent/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/mcp')>()
  return {
    ...actual,
    listMcpToolDefinitions: (...args: unknown[]) => listMcpToolDefinitions(...args),
    getMcpReadOnlyHint: () => undefined,
    getMcpServerStatus: (...args: unknown[]) => getMcpServerStatus(...args)
  }
})

vi.mock('@main/marketplace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/marketplace')>()
  return {
    ...actual,
    resolveEffectiveMcpServers: () => []
  }
})

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import { executeTool } from '@main/agent/tools'

describe('mcp_list_tools filtering', () => {
  beforeEach(() => {
    listMcpToolDefinitions.mockClear()
    getMcpServerStatus.mockReset()
    getMcpServerStatus.mockReturnValue([])
  })

  it('filters by parsed serverId equality, not substring of full tool name', async () => {
    // Substring "git" would wrongly match both github and gitlab tool names.
    const result = await executeTool(
      'mcp_list_tools',
      JSON.stringify({ serverId: 'github' }),
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['github', 'gitlab']) }
    )
    expect(result.ok).toBe(true)
    expect(result.content).toContain('mcp__github__list_issues')
    expect(result.content).toContain('mcp__github__create_issue')
    expect(result.content).not.toContain('mcp__gitlab__')
  })

  it('lists connected tools and marks the ones not loaded into the step catalog', async () => {
    const result = await executeTool(
      'mcp_list_tools',
      '{}',
      '/tmp/ws',
      new AbortController().signal,
      {
        runEnabledMcpIds: new Set(['github', 'gitlab']),
        stepMcpToolNames: new Set(['mcp__github__list_issues'])
      }
    )
    expect(result.ok).toBe(true)
    expect(result.content).toContain('mcp__github__list_issues')
    expect(result.content).toContain('mcp__github__create_issue')
    expect(result.content).toContain('[not loaded]')
    expect(result.content).toContain('mcp__gitlab__list_issues')
    // The listing has to say how to get them, or a deferred catalog is a dead end.
    expect(result.content).toMatch(/2 of these are connected but not in this step's catalog/)
    expect(result.content).toMatch(/request_mcp_tools/)
  })

  it('fails when enabled servers are configured but not connected', async () => {
    listMcpToolDefinitions.mockReturnValueOnce([])
    getMcpServerStatus.mockReturnValueOnce([
      {
        id: 'git',
        name: 'Git',
        enabled: true,
        connected: false,
        toolCount: 0,
        hasAuthToken: false,
        error: 'spawn uvx ENOENT'
      }
    ])
    const result = await executeTool(
      'mcp_list_tools',
      '{}',
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['git']) }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toContain('not connected')
    expect(result.content).toContain('spawn uvx ENOENT')
  })

  it('pins tools for the next step via request_mcp_tools', async () => {
    const pinned = new Set<string>()
    let invalidated = false
    const lastUsed = new Map<string, number>()
    const result = await executeTool(
      'request_mcp_tools',
      JSON.stringify({ tools: ['mcp__github__create_issue'] }),
      '/tmp/ws',
      new AbortController().signal,
      {
        runEnabledMcpIds: new Set(['github', 'gitlab']),
        runPinnedMcpToolNames: pinned,
        mcpLastUsedByName: lastUsed,
        currentStep: 4,
        invalidateMcpToolCatalogCache: () => {
          invalidated = true
        }
      }
    )
    expect(result.ok).toBe(true)
    expect(pinned.has('mcp__github__create_issue')).toBe(true)
    expect(lastUsed.get('mcp__github__create_issue')).toBe(4)
    expect(invalidated).toBe(true)
  })

  it('pins deferred optional builtins into the sticky catalog via request_mcp_tools', async () => {
    const pinned = new Set<string>()
    const sticky = new Set<string>(['read', 'browser_navigate'])
    let invalidated = false
    const result = await executeTool(
      'request_mcp_tools',
      JSON.stringify({ tools: ['browser_hover'] }),
      '/tmp/ws',
      new AbortController().signal,
      {
        runPinnedMcpToolNames: pinned,
        runStickyToolNames: sticky,
        invalidateMcpToolCatalogCache: () => {
          invalidated = true
        }
      }
    )
    expect(result.ok).toBe(true)
    expect(sticky.has('browser_hover')).toBe(true)
    expect(pinned.size).toBe(0)
    expect(invalidated).toBe(true)
  })

  it('pins PascalCase deferred builtins via request_mcp_tools', async () => {
    const pinned = new Set<string>()
    const sticky = new Set<string>(['read', 'browser_navigate'])
    const result = await executeTool(
      'request_mcp_tools',
      JSON.stringify({ tools: ['BrowserHover'] }),
      '/tmp/ws',
      new AbortController().signal,
      {
        runPinnedMcpToolNames: pinned,
        runStickyToolNames: sticky
      }
    )
    expect(result.ok).toBe(true)
    expect(sticky.has('browser_hover')).toBe(true)
    expect(pinned.size).toBe(0)
  })

  it('rejects request_mcp_tools with empty args', async () => {
    const result = await executeTool(
      'request_mcp_tools',
      '{}',
      '/tmp/ws',
      new AbortController().signal,
      { runPinnedMcpToolNames: new Set() }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/tools: string\[\] and\/or serverId/)
  })

  it('releases pinned tools via release_mcp_tools', async () => {
    const pinned = new Set(['mcp__github__create_issue', 'mcp__github__list_issues'])
    const lastUsed = new Map([
      ['mcp__github__create_issue', 2],
      ['mcp__github__list_issues', 3]
    ])
    let invalidated = false
    const result = await executeTool(
      'release_mcp_tools',
      JSON.stringify({ tools: ['mcp__github__create_issue'] }),
      '/tmp/ws',
      new AbortController().signal,
      {
        runPinnedMcpToolNames: pinned,
        mcpLastUsedByName: lastUsed,
        invalidateMcpToolCatalogCache: () => {
          invalidated = true
        }
      }
    )
    expect(result.ok).toBe(true)
    expect(pinned.has('mcp__github__create_issue')).toBe(false)
    expect(pinned.has('mcp__github__list_issues')).toBe(true)
    expect(lastUsed.has('mcp__github__create_issue')).toBe(false)
    expect(invalidated).toBe(true)
  })

  it('releases all pinned tools for a serverId', async () => {
    const pinned = new Set(['mcp__github__create_issue', 'mcp__gitlab__list_issues'])
    const result = await executeTool(
      'release_mcp_tools',
      JSON.stringify({ serverId: 'github' }),
      '/tmp/ws',
      new AbortController().signal,
      { runPinnedMcpToolNames: pinned }
    )
    expect(result.ok).toBe(true)
    expect(pinned.has('mcp__github__create_issue')).toBe(false)
    expect(pinned.has('mcp__gitlab__list_issues')).toBe(true)
  })

  it('succeeds when request_mcp_tools serverId has no connected tools', async () => {
    const result = await executeTool(
      'request_mcp_tools',
      JSON.stringify({ serverId: 'missing-server' }),
      '/tmp/ws',
      new AbortController().signal,
      { runPinnedMcpToolNames: new Set() }
    )
    expect(result.ok).toBe(true)
    expect(result.content).toMatch(/No connected MCP tools for serverId=missing-server/)
  })

  it('succeeds when release_mcp_tools serverId has nothing pinned', async () => {
    const result = await executeTool(
      'release_mcp_tools',
      JSON.stringify({ serverId: 'github' }),
      '/tmp/ws',
      new AbortController().signal,
      { runPinnedMcpToolNames: new Set() }
    )
    expect(result.ok).toBe(true)
    expect(result.content).toMatch(/No loaded MCP tools for serverId=github/)
  })

  it('loads a whole server for the next step instead of pinning tool by tool', async () => {
    const attached = new Set<string>()
    const pinned = new Set<string>()
    let invalidated = false
    const result = await executeTool(
      'request_mcp_tools',
      JSON.stringify({ serverId: 'GitHub' }),
      '/tmp/ws',
      new AbortController().signal,
      {
        runEnabledMcpIds: new Set(['github', 'gitlab']),
        runAttachedMcpServerIds: attached,
        runPinnedMcpToolNames: pinned,
        invalidateMcpToolCatalogCache: () => {
          invalidated = true
        }
      }
    )
    expect(result.ok).toBe(true)
    // Case-insensitive in, canonical id out.
    expect([...attached]).toEqual(['github'])
    expect(pinned.size).toBe(0)
    expect(invalidated).toBe(true)
    expect(result.content).toMatch(/server github \(2 tools\)/)
    expect(result.content).toMatch(/next model step/)
  })

  it('reports a server that is already loaded instead of loading it twice', async () => {
    const attached = new Set(['github'])
    const result = await executeTool(
      'request_mcp_tools',
      JSON.stringify({ serverId: 'github' }),
      '/tmp/ws',
      new AbortController().signal,
      {
        runEnabledMcpIds: new Set(['github']),
        runAttachedMcpServerIds: attached,
        runPinnedMcpToolNames: new Set()
      }
    )
    expect(result.ok).toBe(true)
    expect(result.content).toMatch(/Already available: server github/)
    expect(result.content).toMatch(/Nothing new loaded/)
  })

  it('does not re-load a tool whose server is already loaded', async () => {
    const pinned = new Set<string>()
    const result = await executeTool(
      'request_mcp_tools',
      JSON.stringify({ tools: ['mcp__github__create_issue'] }),
      '/tmp/ws',
      new AbortController().signal,
      {
        runEnabledMcpIds: new Set(['github']),
        runAttachedMcpServerIds: new Set(['github']),
        runPinnedMcpToolNames: pinned
      }
    )
    expect(result.ok).toBe(true)
    expect(pinned.size).toBe(0)
    expect(result.content).toMatch(/Already available: mcp__github__create_issue/)
  })

  it('releases a loaded server and the single tools loaded from it', async () => {
    const attached = new Set(['github', 'gitlab'])
    const pinned = new Set(['mcp__github__create_issue', 'mcp__gitlab__list_issues'])
    const result = await executeTool(
      'release_mcp_tools',
      JSON.stringify({ serverId: 'github' }),
      '/tmp/ws',
      new AbortController().signal,
      {
        runAttachedMcpServerIds: attached,
        runPinnedMcpToolNames: pinned
      }
    )
    expect(result.ok).toBe(true)
    expect([...attached]).toEqual(['gitlab'])
    expect(pinned.has('mcp__github__create_issue')).toBe(false)
    expect(pinned.has('mcp__gitlab__list_issues')).toBe(true)
    expect(result.content).toMatch(/server github/)
  })

  it('will not list or load a tool the server policy denies', async () => {
    const ctx = {
      runEnabledMcpIds: new Set(['github']),
      mcpToolPolicies: new Map([['github', { deniedTools: ['create_issue'] }]]),
      runPinnedMcpToolNames: new Set<string>()
    }
    const listed = await executeTool(
      'mcp_list_tools',
      JSON.stringify({ serverId: 'github' }),
      '/tmp/ws',
      new AbortController().signal,
      ctx
    )
    expect(listed.content).toContain('mcp__github__list_issues')
    expect(listed.content).not.toContain('mcp__github__create_issue')

    const requested = await executeTool(
      'request_mcp_tools',
      JSON.stringify({ tools: ['mcp__github__create_issue'] }),
      '/tmp/ws',
      new AbortController().signal,
      ctx
    )
    // Promising a load that executeTool would then refuse is worse than saying no.
    expect(requested.content).toMatch(/Unknown \/ unresolved: mcp__github__create_issue/)
    expect(ctx.runPinnedMcpToolNames.size).toBe(0)
  })

  it('explains that a tool is on the wire via its loaded server rather than calling it unknown', async () => {
    const result = await executeTool(
      'release_mcp_tools',
      JSON.stringify({ tools: ['mcp__github__create_issue'] }),
      '/tmp/ws',
      new AbortController().signal,
      {
        runAttachedMcpServerIds: new Set(['github']),
        runPinnedMcpToolNames: new Set()
      }
    )
    expect(result.ok).toBe(true)
    expect(result.content).toMatch(/is on the wire because server github is loaded/)
    expect(result.content).not.toMatch(/Unknown \/ unresolved/)
  })
})
