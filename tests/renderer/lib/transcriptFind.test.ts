/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import {
  findTranscriptRowMatches,
  isChangesOrPrDockClaimingFind,
  transcriptRowSearchText,
  wrapMatchIndex
} from '@renderer/lib/chat/transcriptFind'
import type { TranscriptRow } from '@renderer/features/chat/utils/transcriptRows'

function userRow(id: string, content: string): TranscriptRow {
  return {
    kind: 'user',
    id,
    turnIndex: 0,
    item: { kind: 'message', id, role: 'user', content }
  }
}

function textRow(id: string, content: string): TranscriptRow {
  return {
    kind: 'text',
    id,
    turnIndex: 0,
    final: true,
    item: { kind: 'message', id, role: 'assistant', content }
  }
}

describe('transcriptRowSearchText', () => {
  it('reads user and assistant content, not empty turn rows', () => {
    expect(transcriptRowSearchText(userRow('u1', 'Fix the login bug'))).toBe('Fix the login bug')
    expect(transcriptRowSearchText(textRow('a1', 'Patched the handler'))).toBe(
      'Patched the handler'
    )
    expect(
      transcriptRowSearchText({
        kind: 'turn',
        id: 't0',
        turnIndex: 0,
        span: { startedAt: 1, endedAt: 2, active: false }
      })
    ).toBe('')
  })

  it('includes compaction, changes paths, tool summaries, and questions', () => {
    expect(
      transcriptRowSearchText({
        kind: 'compaction',
        id: 'c1',
        turnIndex: 1,
        summary: 'Kept JWT decision',
        verifyFailures: ['Missing decision: Use JWT']
      })
    ).toContain('Use JWT')
    expect(
      transcriptRowSearchText({
        kind: 'changes',
        id: 'ch1',
        turnIndex: 1,
        files: [{ path: 'src/auth.ts', added: 2, removed: 0 }]
      })
    ).toBe('src/auth.ts')
    expect(
      transcriptRowSearchText({
        kind: 'card',
        id: 'tool-1',
        turnIndex: 1,
        item: {
          kind: 'tool',
          id: 'tool-1',
          tool: { id: 'tool-1', name: 'read', summary: 'src/auth.ts', status: 'done' }
        }
      })
    ).toBe('src/auth.ts')
    expect(
      transcriptRowSearchText({
        kind: 'question',
        id: 'q1',
        turnIndex: 1,
        question: {
          requestId: 'r1',
          toolCallId: 'tc1',
          title: 'Pick a store',
          questions: [{ id: 'i1', prompt: 'Redis or SQLite?', type: 'single' }]
        }
      })
    ).toMatch(/Pick a store/)
  })
})

describe('wrapMatchIndex', () => {
  it('wraps negatives and overflow into the match range', () => {
    expect(wrapMatchIndex(-1, 2)).toBe(1)
    expect(wrapMatchIndex(2, 2)).toBe(0)
    expect(wrapMatchIndex(0, 0)).toBe(0)
  })
})

describe('findTranscriptRowMatches', () => {
  it('returns case-insensitive indices and skips empty queries', () => {
    const rows: TranscriptRow[] = [
      userRow('u1', 'Hello from the user'),
      textRow('a1', 'Reply about JWT auth'),
      textRow('a2', 'Unrelated closing note')
    ]
    expect(findTranscriptRowMatches(rows, 'jwt')).toEqual([1])
    expect(findTranscriptRowMatches(rows, '  ')).toEqual([])
    expect(findTranscriptRowMatches(rows, 'hello')).toEqual([0])
    expect(findTranscriptRowMatches(rows, 'closing')).toEqual([2])
    expect(findTranscriptRowMatches(rows, 'e')).toEqual([0, 1, 2])
  })
})

describe('isChangesOrPrDockClaimingFind', () => {
  it('is true only for a visible changes or PR dock', () => {
    expect(isChangesOrPrDockClaimingFind()).toBe(false)
    const panel = document.createElement('div')
    panel.id = 'dock-panel-changes'
    document.body.appendChild(panel)
    expect(isChangesOrPrDockClaimingFind()).toBe(true)
    panel.setAttribute('inert', '')
    expect(isChangesOrPrDockClaimingFind()).toBe(false)
    panel.removeAttribute('inert')
    panel.classList.add('hidden')
    expect(isChangesOrPrDockClaimingFind()).toBe(false)
    panel.remove()
  })
})
