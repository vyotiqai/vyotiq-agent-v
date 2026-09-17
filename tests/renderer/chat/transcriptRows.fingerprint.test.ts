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

describe('transcriptRowFingerprint / stabilizeTranscriptRows', () => {
  it('invalidates activity identity when tool content grows', () => {
    const base: UiItem = {
      kind: 'tool',
      id: 't1',
      tool: {
        id: 't1',
        name: 'read',
        summary: 'a.ts',
        status: 'done',
        content: 'short'
      }
    }
    const grown: UiItem = {
      ...base,
      tool: { ...base.tool, content: 'short'.repeat(40) }
    }
    const prev = buildTranscriptRows([base])
    const next = buildTranscriptRows([grown])
    expect(prev[0]?.kind).toBe('activity')
    expect(next[0]?.kind).toBe('activity')
    if (prev[0]?.kind !== 'activity' || next[0]?.kind !== 'activity') return
    expect(transcriptRowFingerprint(prev[0])).not.toBe(transcriptRowFingerprint(next[0]))
    const stable = stabilizeTranscriptRows(prev, next)
    expect(stable[0]).toBe(next[0])
    expect(stable[0]).not.toBe(prev[0])
  })

  it('reuses activity row identity when only unrelated fields are unchanged', () => {
    const item: UiItem = {
      kind: 'tool',
      id: 't1',
      tool: { id: 't1', name: 'read', summary: 'a.ts', status: 'done', content: 'body' }
    }
    const prev = buildTranscriptRows([item])
    const next = buildTranscriptRows([{ ...item }])
    const stable = stabilizeTranscriptRows(prev, next)
    expect(stable[0]).toBe(prev[0])
  })

  it('invalidates question identity when prompt/options change for the same requestId', () => {
    const prev = buildTranscriptRows([
      {
        kind: 'question',
        id: 'q-ui',
        question: {
          requestId: 'req-1',
          toolCallId: 't1',
          questions: [{ id: 'a', prompt: 'Pick one', type: 'single', options: ['A', 'B'] }]
        }
      }
    ])
    const next = buildTranscriptRows([
      {
        kind: 'question',
        id: 'q-ui',
        question: {
          requestId: 'req-1',
          toolCallId: 't1',
          questions: [
            { id: 'a', prompt: 'Pick one now', type: 'single', options: ['A', 'B', 'C'] }
          ]
        }
      }
    ])
    expect(prev[0]?.kind).toBe('question')
    expect(next[0]?.kind).toBe('question')
    if (prev[0]?.kind !== 'question' || next[0]?.kind !== 'question') return
    expect(transcriptRowFingerprint(prev[0])).not.toBe(transcriptRowFingerprint(next[0]))
    const stable = stabilizeTranscriptRows(prev, next)
    expect(stable[0]).toBe(next[0])
    expect(stable[0]).not.toBe(prev[0])
  })

  it('invalidates text identity when content changes at the same length', () => {
    const prev = buildTranscriptRows([
      {
        kind: 'message',
        id: 'm1',
        role: 'assistant',
        content: 'hello world!!!'
      }
    ])
    const next = buildTranscriptRows([
      {
        kind: 'message',
        id: 'm1',
        role: 'assistant',
        content: 'HELLO WORLD!!!'
      }
    ])
    const prevText = prev.find((row) => row.kind === 'text')
    const nextText = next.find((row) => row.kind === 'text')
    expect(prevText?.kind).toBe('text')
    expect(nextText?.kind).toBe('text')
    if (prevText?.kind !== 'text' || nextText?.kind !== 'text') return
    expect(prevText.item.content.length).toBe(nextText.item.content.length)
    expect(transcriptRowFingerprint(prevText)).not.toBe(transcriptRowFingerprint(nextText))
    const stable = stabilizeTranscriptRows(
      prev.filter((row) => row.kind === 'text'),
      next.filter((row) => row.kind === 'text')
    )
    expect(stable[0]).toBe(nextText)
  })

  it('invalidates text identity when only the middle changes at the same length', () => {
    const left = 'AAAAAAAAAAAAAAA_' // 16
    const right = '_BBBBBBBBBBBBBBB' // 16
    const midA = 'xxxxxxxxxxxxMIDDLExxxxxxxx' // 26
    const midB = 'yyyyyyyyyyyyMIDDLEyyyyyyyy' // 26
    const a = `${left}${midA}${right}`
    const b = `${left}${midB}${right}`
    expect(a.length).toBe(b.length)
    expect(a.length).toBeGreaterThan(48)
    const prev = buildTranscriptRows([{ kind: 'message', id: 'm1', role: 'assistant', content: a }])
    const next = buildTranscriptRows([{ kind: 'message', id: 'm1', role: 'assistant', content: b }])
    const prevText = prev.find((row) => row.kind === 'text')
    const nextText = next.find((row) => row.kind === 'text')
    if (prevText?.kind !== 'text' || nextText?.kind !== 'text') return
    expect(transcriptRowFingerprint(prevText)).not.toBe(transcriptRowFingerprint(nextText))
    const stable = stabilizeTranscriptRows([prevText], [nextText])
    expect(stable[0]).toBe(nextText)
  })

  it('treats thinkingStreaming as live and does not reuse a stale thinking row', () => {
    const prev = buildTranscriptRows([
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: '',
        thinking: 'plan A',
        thinkingStreaming: true
      }
    ])
    const next = buildTranscriptRows([
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: '',
        thinking: 'plan B',
        thinkingStreaming: true
      }
    ])
    const prevThinking = prev.find((row) => row.kind === 'thinking')
    const nextThinking = next.find((row) => row.kind === 'thinking')
    expect(prevThinking?.kind).toBe('thinking')
    expect(nextThinking?.kind).toBe('thinking')
    if (prevThinking?.kind !== 'thinking' || nextThinking?.kind !== 'thinking') return
    // Force a fingerprint collision so only the live-flag path rejects reuse.
    const collidingPrev = {
      ...prevThinking,
      item: { ...prevThinking.item, thinking: nextThinking.item.thinking }
    }
    expect(transcriptRowFingerprint(collidingPrev)).toBe(transcriptRowFingerprint(nextThinking))
    const stable = stabilizeTranscriptRows([collidingPrev], [nextThinking])
    expect(stable[0]).toBe(nextThinking)
    expect(stable[0]).not.toBe(collidingPrev)
  })

  it('emits a compaction row for summarized context', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      {
        kind: 'compaction',
        id: 'c1',
        summary: 'Folded the setup turns into a short brief.',
        tokenEstimate: 800
      }
    ]
    const rows = buildTranscriptRows(items)
    const compact = rows.find((row) => row.kind === 'compaction')
    expect(compact?.kind).toBe('compaction')
    if (compact?.kind !== 'compaction') return
    expect(compact.summary).toBe('Folded the setup turns into a short brief.')
    expect(compact.tokenEstimate).toBe(800)
    expect(compact.turnIndex).toBe(0)
    expect(isTurnWorkRow(compact)).toBe(false)
  })

  it('marks the live turn as Compacting when compacting option is set', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'hello' }
    ]
    const rows = buildTranscriptRows(items, { running: true, compacting: true })
    const turn = rows.find((row) => row.kind === 'turn')
    expect(turn?.kind).toBe('turn')
    if (turn?.kind !== 'turn') return
    expect(turn.span.active).toBe(true)
    expect(turn.span.activity).toEqual({ kind: 'compacting' })
  })

  it('uses the live compact card verify status for the timeline phase', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'hello' },
      {
        kind: 'compaction',
        id: 'compaction:in-flight',
        summary: 'draft',
        verifyStatus: 'verifying'
      }
    ]
    const rows = buildTranscriptRows(items, { running: true, compacting: true })
    const turn = rows.find((row) => row.kind === 'turn')
    expect(turn?.kind).toBe('turn')
    if (turn?.kind !== 'turn') return
    expect(turn.span.activity).toEqual({ kind: 'verifying_compact' })
  })

  it('invalidates compaction identity when verifyStatus changes', () => {
    const base: UiItem = {
      kind: 'compaction',
      id: 'compaction:in-flight',
      summary: 'Folded prior turns.',
      verifyStatus: 'verifying'
    }
    const retrying: UiItem = { ...base, verifyStatus: 'retrying' }
    const prev = buildTranscriptRows([base])
    const next = buildTranscriptRows([retrying])
    const prevRow = prev.find((row) => row.kind === 'compaction')
    const nextRow = next.find((row) => row.kind === 'compaction')
    expect(prevRow?.kind).toBe('compaction')
    expect(nextRow?.kind).toBe('compaction')
    if (prevRow?.kind !== 'compaction' || nextRow?.kind !== 'compaction') return
    expect(transcriptRowFingerprint(prevRow)).not.toBe(transcriptRowFingerprint(nextRow))
    const stable = stabilizeTranscriptRows(prev, next)
    const stableRow = stable.find((row) => row.kind === 'compaction')
    expect(stableRow).toBe(nextRow)
    expect(stableRow).not.toBe(prevRow)
  })

  it('does not reuse a verifying compaction row even on fingerprint collision', () => {
    const verifying: TranscriptRow = {
      kind: 'compaction',
      id: 'compaction:in-flight',
      summary: 'Folded prior turns.',
      turnIndex: 0,
      verifyStatus: 'verifying'
    }
    const retrying: TranscriptRow = {
      ...verifying,
      verifyStatus: 'retrying'
    }
    const collidingPrev: TranscriptRow = {
      ...verifying,
      verifyStatus: 'retrying'
    }
    expect(transcriptRowFingerprint(collidingPrev)).toBe(transcriptRowFingerprint(retrying))
    const stable = stabilizeTranscriptRows([collidingPrev], [retrying])
    expect(stable[0]).toBe(retrying)
    expect(stable[0]).not.toBe(collidingPrev)
  })
})
