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
  it('keeps step reasoning inline between tool batches', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'audit' },
      {
        kind: 'message',
        id: 'm1',
        role: 'assistant',
        thinking: 'First I will read the core files.',
        content: ''
      },
      tool('r1', 'read'),
      {
        kind: 'message',
        id: 'm2',
        role: 'assistant',
        thinking: 'Next I will grep for auth usage.',
        content: ''
      },
      tool('g1', 'grep'),
      {
        kind: 'message',
        id: 'm3',
        role: 'assistant',
        thinking: 'Finally I will run the tests.',
        content: ''
      },
      tool('t1', 'terminal')
    ]
    const rows = buildTranscriptRows(items)
    expect(rows.map((row) => row.kind)).toEqual([
      'user',
      'thinking',
      'activity',
      'thinking',
      'activity',
      'thinking',
      'card',
      'turn'
    ])
  })

  it('attaches tool activity to an active turn with a running tool', () => {
    const running = tool('t1', 'read')
    running.tool.status = 'running'
    running.tool.summary = 'package.json'
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'go' },
      running
    ]
    const summary = buildTranscriptRows(items, { running: true }).find(
      (row) => row.kind === 'turn'
    )
    expect(summary?.kind).toBe('turn')
    if (summary?.kind === 'turn') {
      expect(summary.span.activity).toEqual({
        kind: 'tool',
        label: 'Reading',
        detail: 'package.json'
      })
    }
  })

  it('attaches thinking activity while reasoning streams and no tools are running', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'go' },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: '',
        thinking: 'Let me reason about this carefully.',
        thinkingStreaming: true
      }
    ]
    const summary = buildTranscriptRows(items, { running: true }).find(
      (row) => row.kind === 'turn'
    )
    if (summary?.kind === 'turn') {
      expect(summary.span.activity).toEqual({ kind: 'thinking' })
    }
  })

  it('shows a working turn summary while pendingRun is true with no rows yet', () => {
    const items: UiItem[] = [{ kind: 'message', id: 'u1', role: 'user', content: 'go' }]
    const rows = buildTranscriptRows(items, { pendingRun: true })
    const summary = rows.find((row) => row.kind === 'turn')
    expect(summary?.kind).toBe('turn')
    if (summary?.kind === 'turn') {
      expect(summary.span.active).toBe(true)
      expect(summary.span.activity).toEqual({ kind: 'working' })
    }
  })

  it('keeps the turn summary live while running before the first stream event', () => {
    const items: UiItem[] = [{ kind: 'message', id: 'u1', role: 'user', content: 'go' }]
    const rows = buildTranscriptRows(items, { running: true })
    const summary = rows.find((row) => row.kind === 'turn')
    expect(summary?.kind).toBe('turn')
    if (summary?.kind === 'turn') {
      expect(summary.span.active).toBe(true)
      expect(summary.span.activity).toEqual({ kind: 'working' })
    }
  })

  it('shows Planning while a coalesced todo_write is running', () => {
    const running = tool('todo1', 'todo_write')
    running.tool.status = 'running'
    running.tool.summary = '1 task'
    const rows = buildTranscriptRows(
      [
        { kind: 'message', id: 'u1', role: 'user', content: 'ship the planning gate' },
        running
      ],
      { pendingRun: true }
    )
    const todoTools = rows.flatMap((row) =>
      row.kind === 'activity' ? row.tools.filter((item) => item.tool.name === 'todo_write') : []
    )
    expect(todoTools).toHaveLength(0)
    const summary = rows.find((row) => row.kind === 'turn')
    expect(summary?.kind).toBe('turn')
    if (summary?.kind === 'turn') {
      expect(summary.span.active).toBe(true)
      expect(summary.span.activity).toEqual({ kind: 'planning' })
    }
  })

  it('omits successful todo_write from the transcript (Tasks band owns the checklist)', () => {
    const first = tool('todo1', 'todo_write')
    first.tool.summary = '5 tasks'
    const second = tool('todo2', 'todo_write')
    second.tool.summary = '0/5 complete'
    second.tool.content = '0/5 complete\n[ ] Audit core library code'
    const rows = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'plan' },
      first,
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        thinking: 'Updating the checklist with the latest progress.',
        content: ''
      },
      second
    ])
    const todoTools = rows.flatMap((row) =>
      row.kind === 'activity'
        ? row.tools.filter((item) => item.tool.name === 'todo_write')
        : []
    )
    expect(todoTools).toHaveLength(0)
  })

  it('keeps failed todo_write inline so errors stay visible', () => {
    const failed = tool('todo-fail', 'todo_write')
    failed.tool.status = 'fail'
    failed.tool.summary = 'todos: Required'
    failed.tool.content = 'todos: Required'
    const rows = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'plan' },
      failed
    ])
    const todoTools = rows.flatMap((row) =>
      row.kind === 'activity'
        ? row.tools.filter((item) => item.tool.name === 'todo_write')
        : []
    )
    expect(todoTools).toHaveLength(1)
    expect(todoTools[0]?.id).toBe('todo-fail')
  })
})
