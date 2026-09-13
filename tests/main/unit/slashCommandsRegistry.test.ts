import { describe, expect, it, vi } from 'vitest'
import {
  BUILTIN_COMMANDS,
  buildHelpMessage,
  resolveBuiltin
} from '../../../src/main/agent/slashCommands/builtins'
import { resolveMcpCommand } from '../../../src/main/agent/slashCommands/mcp'

vi.mock('../../../src/main/agent/mcp', () => ({
  listMcpToolDefinitions: () => [
    {
      name: 'mcp__fetch__fetch',
      description: 'HTTP fetch',
      parameters: { type: 'object', properties: {} }
    }
  ],
  getMcpServerStatus: (servers: Array<{ id: string }>) =>
    servers.map((s) => ({
      id: s.id,
      name: s.id,
      enabled: true,
      connected: true,
      toolCount: 1,
      hasAuthToken: false
    })),
  parseMcpToolName: (name: string) => {
    if (!name.startsWith('mcp__')) return null
    const rest = name.slice('mcp__'.length)
    const sep = rest.indexOf('__')
    if (sep <= 0) return null
    return { serverId: rest.slice(0, sep), toolName: rest.slice(sep + 2) }
  }
}))

vi.mock('../../../src/main/marketplace/resolve', () => ({
  resolveEffectiveMcpServers: (overrides?: { mcp?: Record<string, boolean> } | null) => {
    const enabled = overrides?.mcp?.fetch !== false
    return enabled
      ? [{ id: 'fetch', name: 'Fetch', enabled: true, transport: 'stdio' as const }]
      : []
  }
}))

vi.mock('../../../src/main/settings/secrets', () => ({
  hasMcpAuthToken: () => false,
  hasMcpOAuthState: () => false,
  hasStoredMcpOAuthBlob: () => false
}))

describe('builtin slash commands', () => {
  it('exposes core app commands', () => {
    const triggers = BUILTIN_COMMANDS.map((c) => c.trigger)
    expect(triggers).toEqual(
      expect.arrayContaining([
        'clear',
        'compact',
        'marketplace',
        'settings',
        'create-rule',
        'create-skill',
        'help'
      ])
    )
    const marketplace = BUILTIN_COMMANDS.find((c) => c.trigger === 'marketplace')
    expect(marketplace?.description).toBe(
      'Browse and manage skills, MCP servers, and packages'
    )
    expect(marketplace?.description).not.toMatch(/plugin/i)
  })

  it('resolves client actions', () => {
    expect(resolveBuiltin('builtin:clear', '', '')).toEqual({
      action: 'client',
      clientAction: 'clear'
    })
    expect(resolveBuiltin('builtin:compact', '', '')).toEqual({
      action: 'client',
      clientAction: 'compact'
    })
    expect(resolveBuiltin('builtin:compact', 'keep auth rewrite', '')).toEqual({
      action: 'client',
      clientAction: 'compact',
      trailingText: 'keep auth rewrite'
    })
    expect(resolveBuiltin('builtin:create-rule', 'security', '')).toEqual({
      action: 'client',
      clientAction: 'create_rule',
      trailingText: 'security'
    })
    expect(resolveBuiltin('builtin:create-skill', 'personal review', '')).toEqual({
      action: 'client',
      clientAction: 'create_skill',
      trailingText: 'personal review'
    })
  })

  it('resolves /goal and /loop', () => {
    expect(BUILTIN_COMMANDS.map((c) => c.trigger)).toEqual(
      expect.arrayContaining(['goal', 'loop'])
    )
    expect(BUILTIN_COMMANDS).toHaveLength(15)
    const send = resolveBuiltin('builtin:goal', 'fix flaky tests', '')
    expect(send?.action).toBe('send')
    if (send?.action === 'send') {
      expect(send.message).toContain('[Goal]')
      expect(send.message).toContain('fix flaky tests')
      expect(send.message).toContain('create_goal')
    }
    expect(resolveBuiltin('builtin:goal', 'pause', '')).toEqual({
      action: 'client',
      clientAction: 'goal_pause'
    })
    expect(resolveBuiltin('builtin:goal', 'resume', '')).toEqual({
      action: 'client',
      clientAction: 'goal_resume'
    })
    expect(resolveBuiltin('builtin:goal', 'complete', '')).toEqual({
      action: 'client',
      clientAction: 'goal_complete'
    })
    expect(resolveBuiltin('builtin:goal', '', '')).toEqual({
      action: 'client',
      clientAction: 'goal_usage'
    })
    expect(resolveBuiltin('builtin:loop', '', '')).toEqual({
      action: 'client',
      clientAction: 'loop_status'
    })
    expect(resolveBuiltin('builtin:loop', 'stop', '')).toEqual({
      action: 'client',
      clientAction: 'loop_stop'
    })
    expect(resolveBuiltin('builtin:loop', '30s check CI', '')).toEqual({
      action: 'client',
      clientAction: 'loop_set',
      trailingText: '30s check CI'
    })
    const usage = resolveBuiltin('builtin:loop', 'check CI', '')
    expect(usage?.action).toBe('send')
  })

  it('resolves help as a send message', () => {
    const help = buildHelpMessage(BUILTIN_COMMANDS)
    const result = resolveBuiltin('builtin:help', '', help)
    expect(result).toEqual({ action: 'send', message: help })
    expect(help).toContain('/compact')
    expect(help).toContain('/clear')
  })
})

describe('resolveMcpCommand overrides', () => {
  it('sends when the server is enabled under overrides', () => {
    const result = resolveMcpCommand('mcp:mcp__fetch__fetch', 'https://example.com', {
      mcp: { fetch: true }
    })
    expect(result?.action).toBe('send')
  })

  it('opens marketplace when workspace Force-off disables the server', () => {
    const result = resolveMcpCommand('mcp:mcp__fetch__fetch', 'https://example.com', {
      mcp: { fetch: false }
    })
    expect(result).toEqual({
      action: 'client',
      clientAction: 'open_marketplace',
      mcpServerId: 'fetch'
    })
  })
})
