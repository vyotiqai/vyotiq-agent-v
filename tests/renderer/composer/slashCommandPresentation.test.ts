import { describe, expect, it } from 'vitest'
import {
  buildSlashMenuBlocks,
  clusterMcpByServer,
  partitionSlashGroupByAvailability,
  slashAcceptHint,
  slashFooterDescription,
  slashFooterText,
  slashGroupDisplayName,
  slashOptionName,
  slashRowDetail,
  slashRowIcon,
  slashRowLabel
} from '@renderer/features/chat/components/composer/slashCommandPresentation'
import type { SlashCommandDescriptor, SlashMcpServer } from '@shared/ipc'

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

const linear: SlashMcpServer = { id: 'linear', name: 'Linear', iconUrl: 'data:image/svg+xml;base64,PHN2Zy8+', iconMono: true }
const servers = new Map([[linear.id, linear]])

const createIssue = cmd({
  id: 'mcp:mcp__linear__create_issue',
  trigger: 'linear-create-issue',
  group: 'MCP',
  kind: 'mcp',
  label: 'Create issue',
  description: 'Create a new issue in Linear',
  mcpServerId: 'linear',
  mcpToolName: 'create_issue'
})

describe('slashCommandPresentation', () => {
  it('labels builtins as Commands and workspace commands as their own group', () => {
    expect(slashGroupDisplayName('App')).toBe('Commands')
    expect(slashGroupDisplayName('Commands')).toBe('Workspace commands')
    expect(slashGroupDisplayName('Skills')).toBe('Skills')
  })

  it('names a command as typed, a skill or rule by name, an MCP tool by its own name', () => {
    expect(slashRowLabel(cmd({ id: 'builtin:goal', trigger: 'goal', group: 'App', label: 'Set goal' }))).toBe('/goal')
    expect(slashRowLabel(cmd({ id: 'workspace:ship', trigger: 'ship', group: 'Commands', kind: 'workspace' }))).toBe(
      '/ship'
    )
    expect(
      slashRowLabel(cmd({ id: 'skill:write-tests', trigger: 'write-tests', group: 'Skills', kind: 'skill', label: 'Write tests' }))
    ).toBe('write-tests')
    expect(slashRowLabel(createIssue)).toBe('create_issue')
  })

  it('keeps the human label and the trigger in the accessible name', () => {
    expect(slashOptionName(cmd({ id: 'builtin:compact', trigger: 'compact', group: 'App', label: 'Compact context' }))).toBe(
      'Compact context · /compact'
    )
  })

  it('details a row with the first sentence, and an MCP tool with its server', () => {
    const goal = cmd({
      id: 'builtin:goal',
      trigger: 'goal',
      group: 'App',
      description: 'Keep working toward an objective. /goal pause, resume or complete it'
    })
    expect(slashRowDetail(goal, servers)).toBe('Keep working toward an objective')
    expect(slashRowDetail(cmd({ id: 'r', trigger: 'r', group: 'Rules', kind: 'rule', description: 'Open rule .vyotiq/rules/r.md' }), servers)).toBe(
      'Open rule .vyotiq/rules/r.md'
    )
    expect(slashRowDetail(createIssue, servers)).toBe('Linear MCP')
    expect(slashRowDetail({ ...createIssue, mcpServerId: 'alpha-graph' }, servers)).toBe('Alpha graph MCP')
    expect(
      slashRowDetail(cmd({ id: 'mcp-server:linear', trigger: 'linear', group: 'MCP', kind: 'mcp', mcpServerId: 'linear' }), servers)
    ).toBe('MCP server')
  })

  it('gives each kind its glyph, and the builtins theirs', () => {
    expect(slashRowIcon(cmd({ id: 'builtin:goal', trigger: 'goal', group: 'App' }))).toBe('target')
    expect(slashRowIcon(cmd({ id: 'builtin:loop', trigger: 'loop', group: 'App' }))).toBe('repeat')
    expect(slashRowIcon(cmd({ id: 'builtin:compact', trigger: 'compact', group: 'App' }))).toBe('stack')
    expect(slashRowIcon(cmd({ id: 'skill:x', trigger: 'x', group: 'Skills', kind: 'skill' }))).toBe('skill')
    expect(slashRowIcon(cmd({ id: 'rule:x', trigger: 'x', group: 'Rules', kind: 'rule' }))).toBe('rules')
    expect(slashRowIcon(createIssue)).toBe('mcp')
  })

  it('says what accepting does, and when the command resolves', () => {
    expect(slashAcceptHint(cmd({ id: 'builtin:goal', trigger: 'goal', group: 'App' }))).toBe(
      'Tab to insert · runs when you send'
    )
    expect(slashAcceptHint(cmd({ id: 'skill:x', trigger: 'x', group: 'Skills', kind: 'skill' }))).toBe(
      'Tab to insert · runs with this instruction'
    )
    expect(slashAcceptHint(cmd({ id: 'rule:x', trigger: 'x', group: 'Rules', kind: 'rule' }))).toBe(
      'Tab to insert · opens the rule when you send'
    )
    expect(
      slashAcceptHint(cmd({ id: 'skill:y', trigger: 'y', group: 'Skills', kind: 'skill', availability: 'not_installed', packageId: 'y' }))
    ).toBe('Tab to install')
    expect(
      slashAcceptHint(cmd({ id: 'skill:z', trigger: 'z', group: 'Skills', kind: 'skill', availability: 'disabled', packageId: 'z' }))
    ).toBe('Tab to enable')
    expect(slashAcceptHint({ ...createIssue, availability: 'needs_auth' })).toBe('Tab to open it in Extensions')
  })

  it('ends a footer description on a stop and caps a long one at a word', () => {
    expect(slashFooterDescription('Summarize older steps to free context')).toBe('Summarize older steps to free context.')
    expect(slashFooterDescription('Reads the diff, then runs them.')).toBe('Reads the diff, then runs them.')
    expect(slashFooterDescription('Create a new workspace rule under .vyotiq/rules/')).toBe(
      'Create a new workspace rule under .vyotiq/rules/'
    )
    const long = `${'word '.repeat(60)}end`
    const capped = slashFooterDescription(long)
    expect(capped.length).toBeLessThanOrEqual(180)
    expect(capped.endsWith('word…')).toBe(true)
  })

  it('cuts the footer so the label, description and accept hint fit two lines', () => {
    const long = cmd({
      id: 'skill:accessibility',
      trigger: 'accessibility',
      group: 'Skills',
      kind: 'skill',
      availability: 'not_installed',
      packageId: 'accessibility',
      description:
        'Audit and improve UI accessibility: semantic HTML, keyboard navigation, focus, contrast, screen-reader names, and motion preferences. Use when reviewing a11y, fixing WCAG issues.'
    })
    const text = slashFooterText(long)
    expect(text.endsWith('…')).toBe(true)
    expect(`${slashRowLabel(long)} — ${text} ${slashAcceptHint(long)}`.length).toBeLessThanOrEqual(128)
    // A short one is left whole.
    expect(slashFooterText({ ...long, description: 'Audit UI accessibility' })).toBe('Audit UI accessibility.')
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

  it('labels each group, and each MCP server by its name with no MCP heading above', () => {
    const blocks = buildSlashMenuBlocks(
      [
        cmd({ id: 'skill:w', trigger: 'write-tests', group: 'Skills', kind: 'skill' }),
        cmd({ id: 'builtin:goal', trigger: 'goal', group: 'App' }),
        cmd({ id: 'builtin:loop', trigger: 'loop', group: 'App' }),
        createIssue,
        cmd({ id: 'mcp:2', trigger: 't2', group: 'MCP', kind: 'mcp', mcpServerId: 'alpha-graph', mcpToolName: 't2' })
      ],
      servers
    )
    expect(blocks.map((b) => [b.label, b.startIndex, b.items.length])).toEqual([
      ['Skills', 0, 1],
      ['Commands', 1, 2],
      ['Linear', 3, 1],
      ['Alpha graph', 4, 1]
    ])
  })
})
