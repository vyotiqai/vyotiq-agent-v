import { describe, expect, it } from 'vitest'
import { buildSlashDisplayList } from '../../../src/renderer/src/features/chat/components/composer/useSlashCommands'
import type { SlashCommandDescriptor } from '../../../src/shared/ipc'

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

describe('buildSlashDisplayList', () => {
  it('keeps GROUP_ORDER so activeIndex matches highlighted row', () => {
    const items = [
      cmd({ id: 'skill:a', trigger: 'alpha-skill', group: 'Skills', kind: 'skill' }),
      cmd({ id: 'builtin:compact', trigger: 'compact', group: 'App', kind: 'builtin' }),
      cmd({ id: 'mcp:x', trigger: 'mcp-tool', group: 'MCP', kind: 'mcp' })
    ]
    const display = buildSlashDisplayList('', items)
    expect(display.map((c) => c.group)).toEqual(['App', 'Skills', 'MCP'])
    expect(display[0]?.id).toBe('builtin:compact')
    expect(display[1]?.id).toBe('skill:a')
    expect(display[2]?.id).toBe('mcp:x')
  })

  it('hides Ask/Agent from the idle list and keeps them searchable', () => {
    const items = [
      cmd({ id: 'builtin:ask', trigger: 'ask', group: 'App', kind: 'builtin', label: 'Ask mode' }),
      cmd({ id: 'builtin:agent', trigger: 'agent', group: 'App', kind: 'builtin', label: 'Agent mode' }),
      cmd({ id: 'builtin:compact', trigger: 'compact', group: 'App', kind: 'builtin', label: 'Compact context' })
    ]
    expect(buildSlashDisplayList('', items).map((c) => c.trigger)).toEqual(['compact'])
    expect(buildSlashDisplayList('agent', items).map((c) => c.trigger)).toEqual(['agent'])
  })

  it('preserves fuzzy ranking within a group', () => {
    const items = [
      cmd({ id: 'skill:code', trigger: 'code-review', group: 'Skills', kind: 'skill' }),
      cmd({ id: 'skill:commit', trigger: 'commit-message', group: 'Skills', kind: 'skill' })
    ]
    const display = buildSlashDisplayList('code', items)
    expect(display[0]?.trigger).toBe('code-review')
  })

  it('lists ready commands before unavailable ones inside a group', () => {
    const items = [
      cmd({
        id: 'skill:b',
        trigger: 'beta',
        group: 'Skills',
        kind: 'skill',
        availability: 'not_installed'
      }),
      cmd({
        id: 'skill:a',
        trigger: 'alpha',
        group: 'Skills',
        kind: 'skill',
        availability: 'ready'
      })
    ]
    const display = buildSlashDisplayList('', items)
    expect(display.map((c) => c.id)).toEqual(['skill:a', 'skill:b'])
  })
})
