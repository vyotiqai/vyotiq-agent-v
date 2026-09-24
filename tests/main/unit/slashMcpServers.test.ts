import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SlashCommandDescriptor } from '../../../src/shared/ipc'

const catalogEntriesById = vi.fn()

vi.mock('../../../src/main/marketplace/catalog', () => ({
  catalogEntriesById: (ids: Iterable<string>) => catalogEntriesById([...ids])
}))

vi.mock('../../../src/main/marketplace/resolve', () => ({
  resolveEffectiveMcpServers: () => [
    { id: 'linear', name: 'linear-mcp', enabled: true, source: 'marketplace', packageId: 'linear' },
    { id: 'kit__fetch', name: 'Kit: Fetch', enabled: true, source: 'marketplace', packageId: 'kit' },
    { id: 'local', name: 'My local server', enabled: true, source: 'manual' },
    { id: 'unused', name: 'Unused', enabled: true, source: 'manual' }
  ]
}))

const { listSlashMcpServers } = await import('../../../src/main/agent/slashCommands/mcpServers')

function tool(serverId: string): SlashCommandDescriptor {
  return {
    id: `mcp:mcp__${serverId}__t`,
    trigger: `${serverId}-t`,
    label: 'T',
    description: '',
    kind: 'mcp',
    group: 'MCP',
    availability: 'ready',
    mcpServerId: serverId,
    mcpToolName: 't'
  }
}

beforeEach(() => {
  catalogEntriesById.mockReset()
  catalogEntriesById.mockReturnValue(
    new Map([
      ['linear', { id: 'linear', kind: 'mcp', name: 'Linear', iconUrl: 'data:image/svg+xml;base64,QQ==', iconMono: true }],
      ['kit', { id: 'kit', kind: 'plugin', name: 'Kit', iconUrl: 'data:image/png;base64,QQ==', iconMono: false }]
    ])
  )
})

describe('listSlashMcpServers', () => {
  it('names each server the way Extensions does, with its package mark', () => {
    const servers = listSlashMcpServers([tool('linear'), tool('kit__fetch'), tool('local')])
    expect(servers).toEqual([
      // Its own package: the catalog's name and art.
      { id: 'linear', name: 'Linear', iconUrl: 'data:image/svg+xml;base64,QQ==', iconMono: true },
      // Inside a plugin: its own name, the plugin's art.
      { id: 'kit__fetch', name: 'Kit: Fetch', iconUrl: 'data:image/png;base64,QQ==', iconMono: false },
      // Added by hand: no package, no art.
      { id: 'local', name: 'My local server' }
    ])
    expect(catalogEntriesById).toHaveBeenCalledWith(['linear', 'kit'])
  })

  it('reads nothing when no MCP command is listed', () => {
    const skill: SlashCommandDescriptor = { ...tool('x'), id: 'skill:x', kind: 'skill', group: 'Skills' }
    expect(listSlashMcpServers([skill])).toEqual([])
    expect(catalogEntriesById).not.toHaveBeenCalled()
  })
})
