import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@main/agent/providers/types'
import { AGENT_TOOLS } from '@main/agent/types'
import {
  buildStepToolCatalog,
  isOptionalBuiltinName,
  OPTIONAL_BUILTIN_NAMES,
  toolCatalogFingerprint
} from '@main/agent/context/toolsBudget'
import { toolsBudgetFromRaw } from '@shared/domain/contextBudget'

function tool(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    parameters: { type: 'object', properties: {} }
  }
}

describe('buildStepToolCatalog', () => {
  it('keeps every builtin including browser and merge tools', () => {
    const builtins = [
      tool('read', 'read files'),
      tool('edit', 'edit files'),
      tool('browser_navigate', 'nav'),
      tool('browser_click', 'click'),
      tool('browser_hover', 'hover'),
      tool('diagnostics', 'diag'),
      tool('merge_agent_instance', 'merge')
    ]
    const result = buildStepToolCatalog(builtins)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tools.map((t) => t.name)).toEqual(builtins.map((t) => t.name))
    expect(result.tools.map((t) => t.name)).toContain('browser_hover')
    expect(result.tools.map((t) => t.name)).toContain('merge_agent_instance')
  })

  it('offers the full AGENT_TOOLS catalog within a small-window tools budget', () => {
    expect(isOptionalBuiltinName('browser_hover')).toBe(true)
    expect(isOptionalBuiltinName('merge_agent_instance')).toBe(true)
    expect(isOptionalBuiltinName('read')).toBe(false)
    expect(OPTIONAL_BUILTIN_NAMES.has('browser_hover')).toBe(true)

    const result = buildStepToolCatalog(AGENT_TOOLS)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tools.map((t) => t.name)).toEqual(AGENT_TOOLS.map((t) => t.name))
    expect(result.tools.some((t) => t.name === 'browser_navigate')).toBe(true)
    expect(result.tools.some((t) => t.name === 'diagnostics')).toBe(true)
    expect(result.tools.some((t) => t.name === 'spawn_agent_instance')).toBe(true)
    expect(result.tools.some((t) => t.name === 'await_agent_instance')).toBe(true)
    expect(result.tools.some((t) => t.name === 'pull_agent_instance')).toBe(true)
    expect(result.tools.some((t) => t.name === 'merge_agent_instance')).toBe(true)
    expect(result.tools.some((t) => t.name === 'browser_hover')).toBe(true)
  })

  it('includes unpinned MCP tools and never returns overflow', () => {
    const tools = [
      tool('read', 'read'),
      tool('mcp__a__one', 'small'),
      tool('mcp__b__two', 'y'.repeat(2000))
    ]
    const result = buildStepToolCatalog(tools)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tools.map((t) => t.name)).toEqual(tools.map((t) => t.name))
    expect(result.estimate).toBeGreaterThan(0)
  })

  it('fingerprints the kept catalog by ordered tool names', () => {
    const required = [tool('read', 'r'), tool('edit', 'e')]
    const optional = [tool('browser_hover', 'hover')]
    const result = buildStepToolCatalog([...required, ...optional])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.fingerprint).toBe('read|edit|browser_hover')
    expect(result.fingerprint).toBe(toolCatalogFingerprint(result.tools))
  })

  it('estimates tokens over full tool JSON', () => {
    const small = buildStepToolCatalog([tool('read', 'r')])
    const bigger = buildStepToolCatalog([tool('read', 'r'), tool('edit', 'e'.repeat(500))])
    expect(small.ok && bigger.ok).toBe(true)
    if (!small.ok || !bigger.ok) return
    expect(small.estimate).toBeGreaterThan(0)
    expect(bigger.estimate).toBeGreaterThan(small.estimate)
  })
})
