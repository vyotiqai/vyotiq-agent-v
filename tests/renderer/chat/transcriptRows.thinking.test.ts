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
  it('keeps activity batches split by thinking in step order', () => {
    const items: UiItem[] = [
      tool('r1', 'read'),
      tool('r2', 'read'),
      {
        kind: 'message',
        id: 'm1',
        role: 'assistant',
        thinking: 'Mapping the repository tree before edits.',
        content: ''
      },
      tool('r3', 'read'),
      tool('r4', 'read')
    ]
    const rows = buildTranscriptRows(items)
    expect(rows.map((row) => row.kind)).toEqual(['activity', 'thinking', 'activity'])
    const activities = rows.filter((row) => row.kind === 'activity')
    expect(activities).toHaveLength(2)
    if (activities[0]?.kind === 'activity' && activities[1]?.kind === 'activity') {
      expect(activities[0].tools).toHaveLength(2)
      expect(activities[1].tools).toHaveLength(2)
    }
  })

  it('keeps activity batches split by finished thinking separators', () => {
    const items: UiItem[] = [
      tool('r1', 'read'),
      tool('g1', 'grep'),
      {
        kind: 'message',
        id: 'm1',
        role: 'assistant',
        thinking: 'Mapping the repository tree before the next lookups.',
        content: ''
      },
      tool('r2', 'read'),
      tool('g2', 'grep')
    ]
    const rows = buildTranscriptRows(items)
    expect(rows.map((row) => row.kind)).toEqual(['activity', 'thinking', 'activity'])
    const activities = rows.filter((row) => row.kind === 'activity')
    expect(activities).toHaveLength(2)
    if (activities[0]?.kind === 'activity' && activities[1]?.kind === 'activity') {
      expect(activities[0].tools.map((item) => item.id)).toEqual(['r1', 'g1'])
      expect(activities[1].tools.map((item) => item.id)).toEqual(['r2', 'g2'])
    }
  })

  it('does not reorder live streaming thinking across activity merge', () => {
    const items: UiItem[] = [
      tool('r1', 'read'),
      tool('g1', 'grep'),
      {
        kind: 'message',
        id: 'm1',
        role: 'assistant',
        thinking: 'ok',
        thinkingStreaming: true,
        content: ''
      },
      tool('r2', 'read'),
      tool('g2', 'grep')
    ]
    const rows = buildTranscriptRows(items)
    expect(rows.map((row) => row.kind)).toEqual([
      'activity',
      'thinking',
      'activity'
    ])
    const thinking = rows[1]
    expect(thinking?.kind).toBe('thinking')
    if (thinking?.kind === 'thinking') {
      expect(thinking.item.thinkingStreaming).toBe(true)
    }
    const activities = rows.filter((row) => row.kind === 'activity')
    expect(activities).toHaveLength(2)
    if (activities[0]?.kind === 'activity' && activities[1]?.kind === 'activity') {
      expect(activities[0].tools.map((item) => item.id)).toEqual(['r1', 'g1'])
      expect(activities[1].tools.map((item) => item.id)).toEqual(['r2', 'g2'])
    }
  })

  it('keeps lookup batches chronological around a sandwiched terminal card', () => {
    const items: UiItem[] = [
      tool('r1', 'read'),
      tool('d1', 'list_dir'),
      tool('t1', 'terminal'),
      tool('r2', 'read'),
      tool('d2', 'list_dir')
    ]
    const rows = buildTranscriptRows(items)
    expect(rows.map((row) => row.kind)).toEqual(['activity', 'card', 'activity'])
    const first = rows[0]
    if (first?.kind === 'activity') {
      expect(first.tools.map((item) => item.id)).toEqual(['r1', 'd1'])
    }
    expect(rows[1]?.kind).toBe('card')
    expect(rows[1]?.id).toBe('t1')
    const second = rows[2]
    if (second?.kind === 'activity') {
      expect(second.tools.map((item) => item.id)).toEqual(['r2', 'd2'])
    }
  })

  it('places Files Changed after the closing answer, with turn summary after work', () => {
    const edit = tool('e1', 'edit')
    edit.tool.argsPreview = JSON.stringify({ path: 'src/a.ts', contents: 'x\n' })
    const kinds = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'edit' },
      edit,
      { kind: 'message', id: 'a1', role: 'assistant', content: 'Done.' }
    ]).map((row) => row.kind)
    expect(kinds).toEqual(['user', 'card', 'turn', 'text', 'changes'])
  })
})
