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
  it('gives terminal tools a card when presentation is prominent', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'tool',
        id: 't1',
        tool: {
          id: 't1',
          name: 'terminal',
          summary: 'pnpm test',
          status: 'running',
          argsPreview: '{"command":"pnpm test"}',
          presentation: 'prominent'
        }
      }
    ])
    expect(rows[0]?.kind).toBe('card')
  })

  it('keeps read-only terminal commands in activity groups', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'tool',
        id: 't1',
        tool: {
          id: 't1',
          name: 'terminal',
          summary: 'cat README.md',
          status: 'done',
          argsPreview: '{"command":"cat README.md"}'
        }
      }
    ])
    expect(rows[0]?.kind).toBe('activity')
  })

  it('demotes read-only terminal via summary when argsPreview is missing', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'tool',
        id: 't1',
        tool: {
          id: 't1',
          name: 'terminal',
          summary: 'cat README.md',
          status: 'done'
        }
      }
    ])
    expect(rows[0]?.kind).toBe('activity')
  })

  it('treats card rows as turn work (collapsed turns hide them)', () => {
    expect(
      isTurnWorkRow({
        kind: 'card',
        id: 't-run',
        turnIndex: 0,
        item: {
          kind: 'tool',
          id: 't-run',
          tool: { id: 't-run', name: 'terminal', summary: 'npm test', status: 'running' }
        }
      })
    ).toBe(true)
  })
})
