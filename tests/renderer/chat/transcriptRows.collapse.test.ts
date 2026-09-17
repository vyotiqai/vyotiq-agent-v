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
  it('omits short finished thinking so padded empty gaps are not created', () => {
    const rows = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        thinking: 'OK',
        content: 'Done.'
      }
    ])
    expect(rows.map((row) => row.kind)).toEqual(['user', 'text'])
  })

  it('shows Thinking on the timeline when showThinking is false but reasoning is streaming', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'go' },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        thinking: 'Let me reason about this carefully.',
        thinkingStreaming: true,
        content: ''
      }
    ]
    const rows = buildTranscriptRows(items, { showThinking: false, running: true })
    expect(rows.some((row) => row.kind === 'thinking')).toBe(false)
    const summary = rows.find((row) => row.kind === 'turn')
    if (summary?.kind === 'turn') {
      expect(summary.span.activity?.kind).toBe('thinking')
    }
  })

  it('keeps approval rows visible when a turn is collapsed', () => {
    expect(
      isTurnWorkRow({
        kind: 'approval',
        id: 'a1',
        turnIndex: 0,
        approval: {
          requestId: 'r1',
          toolName: 'edit',
          summary: 'edit',
          mutating: true
        }
      })
    ).toBe(false)
  })

  it('detects visible tool work rows for a turn', () => {
    expect(
      turnHasVisibleToolWork(
        [
          {
            kind: 'activity',
            id: 'a-run',
            turnIndex: 0,
            tools: [
              {
                kind: 'tool',
                id: 't1',
                tool: { id: 't1', name: 'read', summary: 'a.ts', status: 'running' }
              }
            ]
          }
        ],
        0
      )
    ).toBe(true)
    expect(
      turnHasVisibleToolWork(
        [
          {
            kind: 'card',
            id: 'c1',
            turnIndex: 1,
            item: {
              kind: 'tool',
              id: 'c1',
              tool: { id: 'c1', name: 'terminal', summary: 'npm test', status: 'running' }
            }
          }
        ],
        1
      )
    ).toBe(true)
    expect(
      turnHasVisibleToolWork(
        [
          {
            kind: 'approval',
            id: 'apr',
            turnIndex: 0,
            approval: {
              requestId: 'r1',
              toolName: 'edit',
              summary: 'edit',
              mutating: true
            }
          }
        ],
        0
      )
    ).toBe(false)
    expect(
      turnHasVisibleToolWork(
        [
          {
            kind: 'thinking',
            id: 'th',
            turnIndex: 0,
            item: {
              kind: 'message',
              id: 'th',
              role: 'assistant',
              content: '',
              thinking: 'plan'
            }
          }
        ],
        0
      )
    ).toBe(false)
  })

  it('keeps question rows visible when a turn is collapsed', () => {
    expect(
      isTurnWorkRow({
        kind: 'question',
        id: 'q1',
        turnIndex: 0,
        question: {
          requestId: 'rq',
          toolCallId: 't1',
          questions: [{ id: 'q1', prompt: 'Continue?', type: 'boolean' }]
        }
      })
    ).toBe(false)
  })

  it('hides running tool activity when a turn is collapsed (timeline owns live phase)', () => {
    expect(
      isTurnWorkRow({
        kind: 'activity',
        id: 'a-run',
        turnIndex: 0,
        tools: [
          {
            kind: 'tool',
            id: 't-run',
            tool: { id: 't-run', name: 'terminal', summary: 'npm test', status: 'running' }
          }
        ]
      })
    ).toBe(true)
    expect(
      isTurnWorkRow({
        kind: 'activity',
        id: 'a-done',
        turnIndex: 0,
        tools: [
          {
            kind: 'tool',
            id: 't-done',
            tool: { id: 't-done', name: 'terminal', summary: 'npm test', status: 'done' }
          }
        ]
      })
    ).toBe(true)
  })
})
