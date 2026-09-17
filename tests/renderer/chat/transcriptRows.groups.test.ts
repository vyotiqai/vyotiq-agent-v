import { describe, expect, it } from 'vitest'
import {
  buildTranscriptRows,
  isTurnWorkRow,
  rowLeadingGap,
  stabilizeTranscriptRows,
  transcriptRowFingerprint,
  turnHasVisibleToolWork,
  TURN_GAP_PX,
  type TranscriptRow
} from '@renderer/features/chat/utils/transcriptRows'
import type { UiItem } from '@shared/transcript'

function tool(id: string, name = 'read', expanded = false): UiItem {
  return {
    kind: 'tool',
    id,
    toolExpanded: expanded,
    tool: { id, name, summary: id, status: 'done' }
  }
}

describe('buildTranscriptRows', () => {
  it('keeps inline agent instance tools in individual compact activity rows', () => {
    const spawn = tool('s1', 'spawn_agent_instance')
    spawn.tool.status = 'done'
    const awaitA = tool('a1', 'await_agent_instance')
    awaitA.tool.status = 'running'
    awaitA.toolExpanded = undefined
    awaitA.tool.argsPreview = JSON.stringify({ run_id: '584c0a1c-434a-4ddf-85c5-a05bb80fd696' })
    const awaitB = tool('a2', 'await_agent_instance')
    awaitB.tool.status = 'running'
    awaitB.toolExpanded = undefined
    awaitB.tool.argsPreview = JSON.stringify({ run_id: '7f2e9b1a-1111-2222-3333-444455556666' })
    const pull = tool('p1', 'pull_agent_instance')
    const merge = tool('m1', 'merge_agent_instance')

    const rows = buildTranscriptRows([spawn, awaitA, awaitB, pull, merge])
    expect(rows.map((row) => row.kind)).toEqual([
      'activity',
      'activity',
      'activity',
      'activity',
      'activity'
    ])
    expect(rows.every((row) => row.kind !== 'card')).toBe(true)
    for (const row of rows) {
      if (row.kind === 'activity') expect(row.tools).toHaveLength(1)
    }
    expect(rows[1]?.kind === 'activity' ? rows[1].tools[0]?.toolExpanded : undefined).toBe(false)
    expect(rows[2]?.kind === 'activity' ? rows[2].tools[0]?.toolExpanded : undefined).toBe(false)
  })

  it('assigns turn indices starting from user messages', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'hello' },
      { kind: 'message', id: 'u2', role: 'user', content: 'again' },
      { kind: 'message', id: 'a2', role: 'assistant', content: 'sure' }
    ]
    const rows = buildTranscriptRows(items)
    expect(rows[0]?.kind).toBe('user')
    expect(rows[0]?.turnIndex).toBe(0)
    expect(rows[2]?.kind).toBe('user')
    expect(rows[2]?.turnIndex).toBe(1)
  })

  it('groups consecutive tools into a single activity row', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'm1', role: 'assistant', content: 'go' },
      tool('t1'),
      tool('t2'),
      tool('t3'),
      { kind: 'message', id: 'm2', role: 'assistant', content: 'done' }
    ]
    const rows = buildTranscriptRows(items)
    const activityRows = rows.filter((row) => row.kind === 'activity')
    expect(activityRows).toHaveLength(1)
    if (activityRows[0]?.kind === 'activity') {
      expect(activityRows[0].tools).toHaveLength(3)
    }
  })

  it('does not emit a text row for whitespace-only streaming assistant content after tools', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'search' },
      {
        kind: 'tool',
        id: 't1',
        toolExpanded: false,
        tool: { id: 't1', name: 'web_search', summary: 'Searching', status: 'running' }
      },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: ' \n',
        streaming: true
      }
    ]
    const rows = buildTranscriptRows(items)
    expect(rows.some((row) => row.kind === 'text')).toBe(false)
    expect(rows.some((row) => row.kind === 'activity')).toBe(true)
  })

  it('breaks terminal and edit tools out as cards between lookups', () => {
    const rows = buildTranscriptRows([
      tool('r1', 'read'),
      tool('t1', 'terminal'),
      tool('r2', 'read'),
      tool('e1', 'edit')
    ])
    expect(rows.map((row) => row.kind)).toEqual(['activity', 'card', 'activity', 'card'])
    expect(rows.filter((row) => row.kind === 'activity').map((row) => {
      if (row.kind !== 'activity') return []
      return row.tools.map((item) => item.id)
    })).toEqual([['r1'], ['r2']])
    expect(rows.filter((row) => row.kind === 'card').map((row) => row.id)).toEqual(['t1', 'e1'])
  })

  it('gives a lone terminal call a card row', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'build it' },
      tool('t1', 'terminal'),
      { kind: 'message', id: 'u2', role: 'user', content: 'and read it' },
      tool('r1', 'read')
    ]
    expect(buildTranscriptRows(items).map((row) => row.kind)).toEqual([
      'user',
      'card',
      'turn',
      'user',
      'activity',
      'turn'
    ])
  })

  it('keeps mid-loop narration inline, in the order it happened', () => {
    const items: UiItem[] = [
      tool('a1'),
      { kind: 'message', id: 'm', role: 'assistant', content: 'now the router' },
      tool('b1')
    ]
    expect(buildTranscriptRows(items).map((row) => row.kind)).toEqual([
      'activity',
      'text',
      'activity'
    ])
  })

  it('does not split a tool stretch on assistant rows that render nothing', () => {
    // Splitting there produced a stack of identical group headers with no
    // visible separator between them.
    const items: UiItem[] = [
      tool('a1'),
      tool('a2'),
      { kind: 'message', id: 'm', role: 'assistant', content: '' },
      tool('b1')
    ]
    const rows = buildTranscriptRows(items)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('activity')
    if (rows[0]?.kind === 'activity') {
      expect(rows[0].tools.map((item) => item.id)).toEqual(['a1', 'a2', 'b1'])
    }
  })

  it('keeps a command as a card even mid-batch', () => {
    const items: UiItem[] = [
      tool('a1'),
      { kind: 'message', id: 'm', role: 'assistant', content: 'building' },
      tool('t1', 'terminal')
    ]
    expect(buildTranscriptRows(items).map((row) => row.kind)).toEqual([
      'activity',
      'text',
      'card'
    ])
  })

  it('splits a tool stretch across turns', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'first' },
      tool('a1'),
      { kind: 'message', id: 'u2', role: 'user', content: 'second' },
      tool('b1')
    ]
    const rows = buildTranscriptRows(items)
    expect(rows.map((row) => row.kind)).toEqual([
      'user',
      'activity',
      'turn',
      'user',
      'activity',
      'turn'
    ])
  })
})
