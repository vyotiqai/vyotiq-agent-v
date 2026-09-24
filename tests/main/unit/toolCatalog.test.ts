import { describe, expect, it } from 'vitest'
import type { McpServer } from '@shared/ipc'
import { isMcpToolPermitted } from '@shared/utils/mcpToolPolicy'
import { AGENT_TOOLS } from '@main/agent/schemas/tools'
import { buildToolCatalog } from '@main/agent/toolsCatalog'
import { filterToolDefsForCodeIndex, filterToolDefsForMode } from '@main/agent/tools/modePolicy'

const servers: McpServer[] = [
  {
    id: 'gh',
    name: 'GitHub',
    transport: 'stdio',
    command: 'gh-mcp',
    enabled: true,
    allowedTools: ['get_file_contents']
  },
  { id: 'ctx', name: 'Context', transport: 'stdio', command: 'cce', enabled: true },
  { id: 'web', name: 'Web', transport: 'stdio', command: 'web-mcp', enabled: true }
]

const mcpToolDefs = [
  { name: 'mcp__gh__get_file_contents', description: 'Read a file from GitHub' },
  { name: 'mcp__gh__list_commits', description: 'List commits' },
  { name: 'mcp__ctx__expand_chunk', description: 'Expand a chunk' },
  { name: 'mcp__web__fetch_page', description: 'Fetch a page' }
]

const inputs = {
  autoModeSwitch: true,
  codeIndexEnabled: true,
  mcpToolDefs,
  servers,
  authAllowedServerIds: new Set(['gh', 'ctx'])
}

describe('buildToolCatalog', () => {
  it('carries every builtin with a description and matches the loop filters', () => {
    const result = buildToolCatalog(inputs)
    const builtins = result.entries.filter((e) => e.source === 'builtin')
    expect(builtins.length).toBe(AGENT_TOOLS.length)
    for (const entry of builtins) {
      expect(entry.description.length).toBeGreaterThan(0)
      expect(entry.modes).toContain('agent')
      expect(entry.active).toBe(true)
      expect(entry.reason).toBeUndefined()
    }
    // Parity with the loop's per-step assembly (agent mode, all gates open).
    const loopNames = filterToolDefsForCodeIndex(
      filterToolDefsForMode('agent', AGENT_TOOLS, { autoModeSwitch: true }),
      true
    ).map((d) => d.name)
    expect(builtins.filter((e) => e.active).map((e) => e.name)).toEqual(loopNames)
  })

  it('mirrors autoModeSwitch + code index gates with the loop filters', () => {
    const result = buildToolCatalog({ ...inputs, autoModeSwitch: false, codeIndexEnabled: false })
    const loopNames = new Set(
      filterToolDefsForCodeIndex(
        filterToolDefsForMode('agent', AGENT_TOOLS, { autoModeSwitch: false }),
        false
      ).map((d) => d.name)
    )
    for (const entry of result.entries.filter((e) => e.source === 'builtin')) {
      expect(entry.active).toBe(loopNames.has(entry.name))
    }
    const byName = new Map(result.entries.map((e) => [e.name, e]))
    expect(byName.get('switch_mode')).toMatchObject({
      active: false,
      reason: 'auto-mode-switch-off',
      modes: []
    })
    expect(byName.get('codebase_search')).toMatchObject({
      active: false,
      reason: 'code-index-off'
    })
    expect(byName.get('concept_search')).toMatchObject({
      active: false,
      reason: 'code-index-off'
    })
  })

  it('reports MCP tools with server state and policy reasons', () => {
    const result = buildToolCatalog(inputs)
    const byName = new Map(
      result.entries.filter((e) => e.source === 'mcp').map((e) => [e.name, e])
    )
    expect(byName.get('mcp__gh__get_file_contents')).toMatchObject({
      active: true,
      serverId: 'gh',
      serverName: 'GitHub',
      modes: ['agent']
    })
    expect(byName.get('mcp__gh__list_commits')).toMatchObject({
      active: false,
      reason: 'denied-by-policy'
    })
    expect(byName.get('mcp__ctx__expand_chunk')).toMatchObject({ active: true })
    expect(byName.get('mcp__web__fetch_page')).toMatchObject({
      active: false,
      reason: 'auth-not-allowed'
    })
    // Parity: the same policy check the loop applies (bare tool name).
    expect(
      isMcpToolPermitted('list_commits', {
        allowedTools: servers[0]?.allowedTools,
        deniedTools: servers[0]?.deniedTools
      })
    ).toBe(false)
    expect(
      isMcpToolPermitted('get_file_contents', {
        allowedTools: servers[0]?.allowedTools,
        deniedTools: servers[0]?.deniedTools
      })
    ).toBe(true)
  })

  it('marks connected servers and produces a stable fingerprint that tracks state', () => {
    const first = buildToolCatalog(inputs)
    expect(first.fingerprint).toBe(buildToolCatalog(inputs).fingerprint)
    expect(first.servers).toEqual([
      { id: 'gh', name: 'GitHub', enabled: true, connected: true, loading: 'on-demand' },
      { id: 'ctx', name: 'Context', enabled: true, connected: true, loading: 'on-demand' },
      { id: 'web', name: 'Web', enabled: true, connected: true, loading: 'on-demand' }
    ])
    const changed = buildToolCatalog({
      ...inputs,
      mcpToolDefs: mcpToolDefs.slice(0, 1)
    })
    expect(changed.fingerprint).not.toBe(first.fingerprint)
    expect(changed.entries.filter((e) => e.source === 'mcp').length).toBe(1)
  })

  it('reports how each server loads: per-server autoLoad, then the settings default', () => {
    const perServer = buildToolCatalog({
      ...inputs,
      servers: inputs.servers.map((s) => (s.id === 'ctx' ? { ...s, autoLoad: true } : s))
    })
    expect(perServer.servers.map((s) => [s.id, s.loading])).toEqual([
      ['gh', 'on-demand'],
      ['ctx', 'every-step'],
      ['web', 'on-demand']
    ])

    const eager = buildToolCatalog({ ...inputs, mcpToolLoading: 'eager' })
    expect(eager.servers.every((s) => s.loading === 'every-step')).toBe(true)
  })

  it('carries what each MCP server declared as read-only, and tracks it in the fingerprint', () => {
    const hints: Record<string, boolean> = {
      mcp__gh__get_file_contents: true,
      mcp__gh__list_commits: false
    }
    const result = buildToolCatalog({ ...inputs, mcpReadOnlyHint: (name) => hints[name] })
    const byName = new Map(result.entries.map((e) => [e.name, e]))
    expect(byName.get('mcp__gh__get_file_contents')?.readOnlyHint).toBe(true)
    expect(byName.get('mcp__gh__list_commits')?.readOnlyHint).toBe(false)
    // A tool whose session never reported a hint carries no claim at all.
    expect(byName.get('mcp__ctx__expand_chunk')).not.toHaveProperty('readOnlyHint')
    expect(result.entries.filter((e) => e.source === 'builtin').some((e) => 'readOnlyHint' in e)).toBe(false)

    const flipped = buildToolCatalog({
      ...inputs,
      mcpReadOnlyHint: (name) => (name === 'mcp__gh__list_commits' ? true : hints[name])
    })
    expect(flipped.fingerprint).not.toBe(result.fingerprint)
  })
})
