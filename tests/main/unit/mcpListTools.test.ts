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

  it('lists connected tools and marks those omitted from the step catalog', async () => {
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
    expect(result.content).toContain('[omitted from this step catalog]')
    expect(result.content).toContain('mcp__gitlab__list_issues')
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
    expect(result.content).toMatch(/No pinned MCP tools for serverId=github/)
  })
})
