import { describe, expect, it } from 'vitest'
import {
  compactActivityFromRows,
  deriveRunActivity,
  formatRunActivityLabel,
  turnSummaryActiveLabel
} from '@renderer/features/chat/utils/runActivity'
import type { TranscriptRow } from '@renderer/features/chat/utils/transcriptRows'

function thinkingRow(thinkingStreaming: boolean): TranscriptRow {
  return {
    kind: 'thinking',
    id: 'think-1',
    turnIndex: 0,
    item: {
      kind: 'message',
      id: 'a1',
      role: 'assistant',
      content: '',
      thinking: 'Let me think.',
      thinkingStreaming
    }
  }
}

function textRow(streaming: boolean): TranscriptRow {
  return {
    kind: 'text',
    id: 'text-1',
    turnIndex: 0,
    final: false,
    item: {
      kind: 'message',
      id: 'a1',
      role: 'assistant',
      content: 'Hello',
      streaming
    }
  }
}

function activityRow(
  tools: Array<{ id: string; name: string; summary: string; status: 'running' | 'done' }>
): TranscriptRow {
  return {
    kind: 'activity',
    id: 'activity-1',
    turnIndex: 0,
    tools: tools.map((tool) => ({
      kind: 'tool' as const,
      id: tool.id,
      tool: { id: tool.id, name: tool.name, summary: tool.summary, status: tool.status }
    }))
  }
}

describe('deriveRunActivity', () => {
  it('prefers writing over thinking when both are streaming', () => {
    const phase = deriveRunActivity([thinkingRow(true), textRow(true)])
    expect(phase).toEqual({ kind: 'writing' })
  })

  it('prefers running tools over thinking and writing when all are active', () => {
    const phase = deriveRunActivity([
      activityRow([{ id: 't1', name: 'grep', summary: 'foo', status: 'running' }]),
      thinkingRow(true),
      textRow(true)
    ])
    expect(phase).toEqual({ kind: 'tool', label: 'Grepping', detail: 'foo' })
  })

  it('prefers a running edit card over compact read activity and writing', () => {
    const phase = deriveRunActivity([
      activityRow([{ id: 't1', name: 'read', summary: 'a.ts', status: 'running' }]),
      {
        kind: 'card',
        id: 't2',
        turnIndex: 0,
        item: {
          kind: 'tool',
          id: 't2',
          tool: { id: 't2', name: 'edit', summary: 'src/foo.ts', status: 'running' }
        }
      },
      textRow(true)
    ])
    expect(phase).toEqual({ kind: 'tool', label: 'Editing', detail: 'foo.ts' })
  })

  it('uses compact activity labels when tools are running', () => {
    const phase = deriveRunActivity([
      activityRow([{ id: 't1', name: 'grep', summary: 'pattern', status: 'running' }])
    ])
    expect(phase).toEqual({ kind: 'tool', label: 'Grepping', detail: 'pattern' })
  })

  it('reports writing when assistant text is streaming', () => {
    const phase = deriveRunActivity([textRow(true)])
    expect(phase).toEqual({ kind: 'writing' })
  })



  it('reports awaiting approval when an approval row is pending', () => {
    const phase = deriveRunActivity([
      {
        kind: 'approval',
        id: 'approval:1',
        turnIndex: 0,
        approval: {
          requestId: 'req-1',
          toolName: 'edit',
          summary: 'edit file',
          argsPreview: '{}',
          mutating: true
        }
      }
    ])
    expect(phase).toEqual({ kind: 'awaiting_approval' })
  })



  it('reports awaiting_question when a question row is pending', () => {
    const phase = deriveRunActivity([
      {
        kind: 'question',
        id: 'question:1',
        turnIndex: 0,
        question: {
          requestId: 'q-1',
          toolCallId: 't1',
          questions: [{ id: 'q1', prompt: 'Continue?', type: 'boolean' }]
        }
      }
    ])
    expect(phase).toEqual({ kind: 'awaiting_question' })
    expect(formatRunActivityLabel({ kind: 'awaiting_question' })).toBe('Awaiting answer')
  })

  it('reports working when pendingRun is true with no rows yet', () => {
    expect(deriveRunActivity([], true)).toEqual({ kind: 'working' })
  })

  it('reports planning while a coalesced todo_write is running', () => {
    expect(deriveRunActivity([], true, { todoWriteRunning: true })).toEqual({ kind: 'planning' })
    expect(deriveRunActivity([], false, { todoWriteRunning: true })).toEqual({ kind: 'planning' })
  })

  it('reports working when pendingRun is true but turn already has work', () => {
    expect(deriveRunActivity([textRow(false)], true)).toEqual({ kind: 'working' })
  })

  it('reports working as the active-turn fallback between steps', () => {
    expect(deriveRunActivity([])).toEqual({ kind: 'working' })
  })
})

describe('turnSummaryActiveLabel', () => {
  it('keeps specific phase when collapsed', () => {
    expect(turnSummaryActiveLabel({ kind: 'tool', label: 'Reading', detail: 'a.ts' })).toBe(
      'Reading a.ts'
    )
  })

  it('keeps specific phase when expanded', () => {
    expect(turnSummaryActiveLabel({ kind: 'thinking' })).toBe('Thinking')
    expect(turnSummaryActiveLabel({ kind: 'tool', label: 'Reading', detail: '2 files' })).toBe(
      'Reading 2 files'
    )
    expect(turnSummaryActiveLabel({ kind: 'awaiting_approval' })).toBe('Awaiting approval')
  })

  it('keeps Planning when expanded before the first work row', () => {
    expect(turnSummaryActiveLabel({ kind: 'planning' })).toBe('Planning')
  })
})

describe('compactActivityFromRows', () => {
  it('reads verifying and retrying from the latest compact card', () => {
    expect(compactActivityFromRows([])).toEqual({ kind: 'compacting' })
    expect(
      compactActivityFromRows([
        {
          kind: 'compaction',
          id: 'c1',
          summary: 'draft',
          turnIndex: 0,
          verifyStatus: 'verifying'
        }
      ])
    ).toEqual({ kind: 'verifying_compact' })
    expect(
      compactActivityFromRows([
        {
          kind: 'compaction',
          id: 'c1',
          summary: 'draft',
          turnIndex: 0,
          verifyStatus: 'retrying'
        }
      ])
    ).toEqual({ kind: 'retrying_compact' })
  })
})

describe('formatRunActivityLabel', () => {
  it('joins tool verb and detail', () => {
    expect(
      formatRunActivityLabel({ kind: 'tool', label: 'Reading', detail: 'package.json' })
    ).toBe('Reading package.json')
  })

  it('formats non-tool phases', () => {
    expect(formatRunActivityLabel({ kind: 'thinking' })).toBe('Thinking')
    expect(formatRunActivityLabel({ kind: 'writing' })).toBe('Writing')
    expect(formatRunActivityLabel({ kind: 'planning' })).toBe('Planning')
    expect(formatRunActivityLabel({ kind: 'working' })).toBe('Working')
    expect(formatRunActivityLabel({ kind: 'compacting' })).toBe('Compacting…')
    expect(formatRunActivityLabel({ kind: 'verifying_compact' })).toBe('Verifying summary…')
    expect(formatRunActivityLabel({ kind: 'retrying_compact' })).toBe('Retrying summary…')
    expect(formatRunActivityLabel({ kind: 'awaiting_approval' })).toBe('Awaiting approval')
  })
})
