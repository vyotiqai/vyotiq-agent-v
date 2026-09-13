import { describe, expect, it } from 'vitest'
import {
  buildSlashMenuSections,
  clusterMcpByServer,
  partitionSlashGroupByAvailability,
  slashCommandRowCopy,
  slashGroupDisplayName,
  truncateSlashDescription
} from '@renderer/features/chat/components/composer/slashCommandPresentation'
import type { SlashCommandDescriptor } from '@shared/ipc'

function cmd(
  partial: Pick<SlashCommandDescriptor, 'id' | 'trigger' | 'group'> &
    Partial<SlashCommandDescriptor>
): SlashCommandDescriptor {
  return {
    label: partial.trigger,
    description: '',
    kind: 'builtin',
    availability: 'ready',
    ...partial
  }
}

describe('slashCommandPresentation', () => {
  it('maps data groups to clear category titles', () => {
    expect(slashGroupDisplayName('App')).toBe('Built-in')
    expect(slashGroupDisplayName('Commands')).toBe('Workspace')
    expect(slashGroupDisplayName('Skills')).toBe('Skills')
  })

  it('pairs a human label with the /trigger even when they share a token', () => {
    const copy = slashCommandRowCopy(
      cmd({
        id: 'builtin:create-rule',
        trigger: 'create-rule',
        group: 'App',
        label: 'Create rule'
      })
    )
    expect(copy.primary).toBe('Create rule')
    expect(copy.secondary).toBe('/create-rule')
  })

  it('pairs a distinct label with the /trigger', () => {
    const copy = slashCommandRowCopy(
      cmd({
        id: 'builtin:compact',
        trigger: 'compact',
        group: 'App',
        label: 'Compact context'
      })
    )
    expect(copy.primary).toBe('Compact context')
    expect(copy.secondary).toBe('/compact')
  })

  it('hides long MCP triggers from the secondary line', () => {
    const copy = slashCommandRowCopy(
      cmd({
        id: 'mcp:x',
        trigger: 'alpha-graph-build-or-update-graph-tool',
        group: 'MCP',
        kind: 'mcp',
        label: 'Build or update graph tool',
        mcpServerId: 'alpha-graph'
      })
    )
    expect(copy.primary).toBe('Build or update graph tool')
    expect(copy.secondary).toBeNull()
    expect(copy.title).toContain('/alpha-graph-build-or-update-graph-tool')
  })

  it('keeps ready commands ahead of install/enable rows', () => {
    const items = [
      cmd({
        id: 'skill:off',
        trigger: 'zzz',
        group: 'Skills',
        availability: 'not_installed'
      }),
      cmd({ id: 'skill:on', trigger: 'aaa', group: 'Skills', availability: 'ready' })
    ]
    expect(partitionSlashGroupByAvailability(items).map((c) => c.id)).toEqual([
      'skill:on',
      'skill:off'
    ])
  })

  it('clusters MCP tools by server', () => {
    const items = [
      cmd({
        id: 'mcp:a1',
        trigger: 'a-tool',
        group: 'MCP',
        kind: 'mcp',
        mcpServerId: 'alpha'
      }),
      cmd({
        id: 'mcp:b1',
        trigger: 'b-tool',
        group: 'MCP',
        kind: 'mcp',
        mcpServerId: 'beta'
      }),
      cmd({
        id: 'mcp:a2',
        trigger: 'a-other',
        group: 'MCP',
        kind: 'mcp',
        mcpServerId: 'alpha'
      })
    ]
    expect(clusterMcpByServer(items).map((c) => c.id)).toEqual(['mcp:a1', 'mcp:a2', 'mcp:b1'])
  })

  it('builds MCP server blocks under the MCP section', () => {
    const sections = buildSlashMenuSections([
      cmd({
        id: 'mcp:1',
        trigger: 't1',
        group: 'MCP',
        kind: 'mcp',
        label: 'Tool one',
        mcpServerId: 'alpha-graph'
      }),
      cmd({
        id: 'mcp:2',
        trigger: 't2',
        group: 'MCP',
        kind: 'mcp',
        label: 'Tool two',
        mcpServerId: 'alpha-graph'
      })
    ])
    expect(sections).toHaveLength(1)
    expect(sections[0]!.blocks).toHaveLength(1)
    expect(sections[0]!.blocks[0]!.serverLabel).toBe('Alpha graph')
    expect(sections[0]!.blocks[0]!.items).toHaveLength(2)
  })

  it('truncates descriptions to a short scannable blurb', () => {
    const long =
      'Build or update the code graph. Uses asyncio.to_thread. See: #46, #136 for details about full_rebuild=True and other parameters that make this hard to scan.'
    const short = truncateSlashDescription(long)
    expect(short.length).toBeLessThanOrEqual(140)
    expect(short.startsWith('Build or update the code graph.')).toBe(true)
  })
})
