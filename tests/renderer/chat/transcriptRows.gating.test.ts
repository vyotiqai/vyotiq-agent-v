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
  it('emits an approval row instead of a card while an edit is gated', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'tool',
        id: 'w1',
        tool: { id: 'w1', name: 'edit', summary: 'a.ts', status: 'running' },
        approval: {
          requestId: 'req-1',
          toolName: 'edit',
          summary: 'a.ts',
          argsPreview: '{}',
          mutating: true
        }
      }
    ])
    expect(rows.map((row) => row.kind)).toEqual(['approval'])
    expect(rows.some((row) => row.kind === 'card')).toBe(false)
  })

  it('emits a question row and hides the gated ask_question tool card', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'tool',
        id: 'q1',
        tool: { id: 'q1', name: 'ask_question', summary: 'Pick?', status: 'running' }
      },
      {
        kind: 'question',
        id: 'question:req-q',
        question: {
          requestId: 'req-q',
          toolCallId: 'q1',
          questions: [
            { id: 'q1', prompt: 'Pick?', type: 'single', options: ['A', 'B'] }
          ]
        }
      }
    ])
    expect(rows.map((row) => row.kind)).toEqual(['question'])
    expect(rows.some((row) => row.kind === 'card')).toBe(false)
  })

  it('strips leaked tool JSON from assistant text rows', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: 'tool {"edits":[{"path":"api.ts","contents":"x"}]}\nVerified the routes.'
      }
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('text')
    if (rows[0]?.kind === 'text') {
      expect(rows[0].item.content).toBe('Verified the routes.')
    }
  })

  it('hides in-progress tool JSON while assistant text is still streaming', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: 'Checking routes.\ntool {"path":"api.ts"',
        streaming: true
      }
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('text')
    if (rows[0]?.kind === 'text') {
      expect(rows[0].item.content).toBe('Checking routes.')
    }
  })
})
