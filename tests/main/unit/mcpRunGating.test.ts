import { describe, expect, it, vi, beforeEach } from 'vitest'

const invokeMcpTool = vi.hoisted(() => vi.fn())
const getMcpToolDefinition = vi.hoisted(() =>
  vi.fn(() => ({
    name: 'mcp__fs__read_file',
    description: 'read',
    parameters: { type: 'object', properties: {} }
  }))
)

vi.mock('@main/agent/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/mcp')>()
  return {
    ...actual,
    invokeMcpTool: (...args: unknown[]) => invokeMcpTool(...args),
    getMcpToolDefinition: (...args: unknown[]) => getMcpToolDefinition(...args)
  }
})

import { executeTool } from '@main/agent/tools'

describe('executeTool MCP run gating', () => {
  beforeEach(() => {
    invokeMcpTool.mockReset()
    invokeMcpTool.mockResolvedValue({ ok: true, summary: 'ok', content: 'ok' })
    getMcpToolDefinition.mockClear()
  })

  it('rejects MCP tools for servers not in runEnabledMcpIds', async () => {
    const result = await executeTool(
      'mcp__fs__read_file',
      '{}',
      '/tmp/ws',
      new AbortController().signal,
      { runEnabledMcpIds: new Set(['other']) }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/not enabled for this workspace run/)
    expect(invokeMcpTool).not.toHaveBeenCalled()
  })

  it('rejects MCP tools blocked by deny list', async () => {
    const result = await executeTool(
      'mcp__fs__write_file',
      '{}',
      '/tmp/ws',
      new AbortController().signal,
      {
        runEnabledMcpIds: new Set(['fs']),
        mcpToolPolicies: new Map([['fs', { deniedTools: ['write_file'] }]])
      }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/allow\/deny list/)
    expect(invokeMcpTool).not.toHaveBeenCalled()
  })

  it('invokes when server enabled and tool permitted', async () => {
    await executeTool(
      'mcp__fs__read_file',
      '{}',
      '/tmp/ws',
      new AbortController().signal,
      {
        runEnabledMcpIds: new Set(['fs']),
        mcpToolPolicies: new Map([['fs', { allowedTools: ['read_file'] }]])
      }
    )
    expect(invokeMcpTool).toHaveBeenCalled()
  })

  it('rejects MCP tools omitted from this step catalog', async () => {
    const result = await executeTool(
      'mcp__fs__read_file',
      '{}',
      '/tmp/ws',
      new AbortController().signal,
      {
        runEnabledMcpIds: new Set(['fs']),
        stepMcpToolNames: new Set(['mcp__fs__other_tool'])
      }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/not in this step's tool catalog/)
    expect(invokeMcpTool).not.toHaveBeenCalled()
  })

  it('fail-fasts after repeated not-in-catalog for the same MCP tool', async () => {
    const counts = new Map<string, number>()
    const ctx = {
      runEnabledMcpIds: new Set(['fs']),
      stepMcpToolNames: new Set(['mcp__fs__other_tool']),
      mcpNotInCatalogCounts: counts
    }
    const first = await executeTool(
      'mcp__fs__read_file',
      '{}',
      '/tmp/ws',
      new AbortController().signal,
      ctx
    )
    expect(first.ok).toBe(false)
    expect(first.content).toMatch(/not in this step's tool catalog/)
    expect(first.content).not.toMatch(/FAIL-FAST/)
    expect(counts.get('mcp__fs__read_file')).toBe(1)

    const second = await executeTool(
      'mcp__fs__read_file',
      '{}',
      '/tmp/ws',
      new AbortController().signal,
      ctx
    )
    expect(second.ok).toBe(false)
    expect(second.content).toMatch(/FAIL-FAST/)
    expect(second.content).toMatch(/2 times/)
    expect(counts.get('mcp__fs__read_file')).toBe(2)
    expect(invokeMcpTool).not.toHaveBeenCalled()
  })

  it('mentions already-pinned when not-in-catalog tool was pinned', async () => {
    const result = await executeTool(
      'mcp__fs__read_file',
      '{}',
      '/tmp/ws',
      new AbortController().signal,
      {
        runEnabledMcpIds: new Set(['fs']),
        stepMcpToolNames: new Set(['mcp__fs__other_tool']),
        runPinnedMcpToolNames: new Set(['mcp__fs__read_file']),
        mcpNotInCatalogCounts: new Map()
      }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/already pinned/i)
  })

  it('loads a deferred tool for the next step on the first call', async () => {
    const pinned = new Set<string>()
    const counts = new Map<string, number>()
    const lastUsed = new Map<string, number>()
    let invalidated = false
    const result = await executeTool(
      'mcp__fs__read_file',
      '{}',
      '/tmp/ws',
      new AbortController().signal,
      {
        runEnabledMcpIds: new Set(['fs']),
        stepMcpToolNames: new Set<string>(),
        runPinnedMcpToolNames: pinned,
        mcpNotInCatalogCounts: counts,
        mcpLastUsedByName: lastUsed,
        currentStep: 7,
        invalidateMcpToolCatalogCache: () => {
          invalidated = true
        }
      }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/loaded for the next step/)
    expect(pinned.has('mcp__fs__read_file')).toBe(true)
    expect(lastUsed.get('mcp__fs__read_file')).toBe(7)
    expect(invalidated).toBe(true)
    // A self-healing miss is not a failure to count against fail-fast.
    expect(counts.get('mcp__fs__read_file')).toBeUndefined()
    expect(invokeMcpTool).not.toHaveBeenCalled()
  })

  it('does not load a denied tool even when it is connected', async () => {
    const pinned = new Set<string>()
    const result = await executeTool(
      'mcp__fs__write_file',
      '{}',
      '/tmp/ws',
      new AbortController().signal,
      {
        runEnabledMcpIds: new Set(['fs']),
        mcpToolPolicies: new Map([['fs', { deniedTools: ['write_file'] }]]),
        stepMcpToolNames: new Set<string>(),
        runPinnedMcpToolNames: pinned
      }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/allow\/deny list/)
    expect(pinned.size).toBe(0)
  })

  it('does not load a name no connected server offers', async () => {
    getMcpToolDefinition.mockReturnValueOnce(undefined as never)
    const pinned = new Set<string>()
    const result = await executeTool(
      'mcp__fs__hallucinated',
      '{}',
      '/tmp/ws',
      new AbortController().signal,
      {
        runEnabledMcpIds: new Set(['fs']),
        stepMcpToolNames: new Set<string>(),
        runPinnedMcpToolNames: pinned
      }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/Unknown or unavailable MCP tool/)
    expect(pinned.size).toBe(0)
  })

  it('falls back to fail-fast when an already-loaded tool stays out of the catalog', async () => {
    const pinned = new Set(['mcp__fs__read_file'])
    const counts = new Map<string, number>()
    const ctx = {
      runEnabledMcpIds: new Set(['fs']),
      stepMcpToolNames: new Set<string>(),
      runPinnedMcpToolNames: pinned,
      mcpNotInCatalogCounts: counts
    }
    const first = await executeTool(
      'mcp__fs__read_file',
      '{}',
      '/tmp/ws',
      new AbortController().signal,
      ctx
    )
    expect(first.content).toMatch(/already pinned/i)
    const second = await executeTool(
      'mcp__fs__read_file',
      '{}',
      '/tmp/ws',
      new AbortController().signal,
      ctx
    )
    expect(second.content).toMatch(/FAIL-FAST/)
  })

  it('invokes when tool is in the step catalog', async () => {
    await executeTool(
      'mcp__fs__read_file',
      '{}',
      '/tmp/ws',
      new AbortController().signal,
      {
        runEnabledMcpIds: new Set(['fs']),
        stepMcpToolNames: new Set(['mcp__fs__read_file'])
      }
    )
    expect(invokeMcpTool).toHaveBeenCalled()
  })
})
