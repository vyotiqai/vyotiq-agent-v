import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@main/agent/providers/types'
import { splitToolCatalogDetail } from '@main/agent/context/toolsDetail'

function tool(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    parameters: { type: 'object', properties: {} }
  }
}

describe('splitToolCatalogDetail', () => {
  it('splits active builtins and MCP tools per server', () => {
    const allDefs = [
      tool('read', 'read files'),
      tool('edit', 'edit files'),
      tool('mcp__github__create_issue', 'x'.repeat(400)),
      tool('mcp__github__list_prs', 'y'.repeat(100)),
      tool('mcp__search__web', 'z'.repeat(200))
    ]
    const active = new Set([
      'read',
      'edit',
      'mcp__github__create_issue',
      'mcp__github__list_prs',
      'mcp__search__web'
    ])
    const detail = splitToolCatalogDetail(allDefs, active)
    expect(detail.builtin.count).toBe(2)
    expect(detail.mcp.count).toBe(3)
    expect(detail.total).toBe(detail.builtin.tokens + detail.mcp.tokens)
    expect(detail.deferredBuiltin.count).toBe(0)
    expect(detail.deferredMcp.count).toBe(0)
    expect(detail.mcpByServer.map((g) => g.serverId)).toEqual(['github', 'search'])
    expect(detail.mcpByServer.map((g) => g.toolCount)).toEqual([2, 1])
    expect(detail.mcpByServer.reduce((n, g) => n + g.tokens, 0)).toBe(detail.mcp.tokens)
    expect(detail.mcpByServer[0]!.tokens).toBeGreaterThanOrEqual(detail.mcpByServer[1]!.tokens)
  })

  it('counts mode-excluded tools as deferred', () => {
    const allDefs = [
      tool('read', 'read'),
      tool('edit', 'edit'),
      tool('mcp__github__create_issue', 'x'.repeat(400))
    ]
    // Ask mode: write builtins + all MCP tools are off the wire.
    const active = new Set(['read'])
    const detail = splitToolCatalogDetail(allDefs, active)
    expect(detail.builtin.count).toBe(1)
    expect(detail.mcp.count).toBe(0)
    expect(detail.deferredBuiltin).toEqual({ tokens: detail.deferredBuiltin.tokens, count: 1 })
    expect(detail.deferredBuiltin.tokens).toBeGreaterThan(0)
    expect(detail.deferredMcp.count).toBe(1)
    expect(detail.deferredMcp.tokens).toBeGreaterThan(0)
    expect(detail.total).toBe(detail.builtin.tokens)
  })

  it('splits deferred MCP per server so the meter can price each one', () => {
    const allDefs = [
      tool('read', 'read'),
      tool('mcp__notion__search', 'n'.repeat(600)),
      tool('mcp__notion__create_pages', 'n'.repeat(600)),
      tool('mcp__github__list_prs', 'g'.repeat(100)),
      tool('mcp__context7__docs', 'c'.repeat(50))
    ]
    // Only github was loaded this step.
    const detail = splitToolCatalogDetail(allDefs, new Set(['read', 'mcp__github__list_prs']))
    expect(detail.mcpByServer.map((g) => g.serverId)).toEqual(['github'])
    expect(detail.deferredMcpByServer?.map((g) => g.serverId)).toEqual(['notion', 'context7'])
    expect(detail.deferredMcpByServer?.[0]?.toolCount).toBe(2)
    expect(
      (detail.deferredMcpByServer ?? []).reduce((n, g) => n + g.tokens, 0)
    ).toBe(detail.deferredMcp.tokens)
  })

  it('returns an empty catalog split for empty input', () => {
    const detail = splitToolCatalogDetail([], new Set())
    expect(detail.builtin).toEqual({ tokens: 0, count: 0 })
    expect(detail.mcp).toEqual({ tokens: 0, count: 0 })
    expect(detail.mcpByServer).toEqual([])
    expect(detail.deferredBuiltin).toEqual({ tokens: 0, count: 0 })
    expect(detail.deferredMcp).toEqual({ tokens: 0, count: 0 })
    expect(detail.deferredMcpByServer).toEqual([])
    expect(detail.total).toBe(0)
  })
})
