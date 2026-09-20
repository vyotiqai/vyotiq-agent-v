import { describe, expect, it } from 'vitest'
import {
  compactActivityFromRows,
  deriveRunActivity,
  formatRunActivityLabel,
  runActivityVoiceLabel,
  turnSummaryVoiceLabel
} from '@renderer/features/chat/utils/runActivity'
import { RUN_VOICE_PHRASES } from '@renderer/features/chat/utils/runVoice'
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

describe('turnSummaryVoiceLabel', () => {
  it('keeps the tool verb and its detail exactly as the tool reported them', () => {
    expect(turnSummaryVoiceLabel({ kind: 'tool', label: 'Reading', detail: 'a.ts' }, 0)).toBe(
      'Reading a.ts'
    )
    expect(turnSummaryVoiceLabel({ kind: 'tool', label: 'Reading', detail: '2 files' }, 3)).toBe(
      'Reading 2 files'
    )
  })

  it('opens a voiced phase on the plain word, then rotates off it', () => {
    expect(turnSummaryVoiceLabel({ kind: 'thinking' }, 0)).toBe('Thinking')
    expect(turnSummaryVoiceLabel({ kind: 'planning' }, 0)).toBe('Planning')
    expect(turnSummaryVoiceLabel({ kind: 'writing' }, 0)).toBe('Writing')
    expect(turnSummaryVoiceLabel({ kind: 'thinking' }, 1)).toBe(RUN_VOICE_PHRASES.thinking[1])
  })

  it('speaks the working voice when a live turn has no phase yet', () => {
    expect(turnSummaryVoiceLabel(null, 0)).toBe('Working')
    expect(RUN_VOICE_PHRASES.working).toContain(turnSummaryVoiceLabel(undefined, 4))
  })

  it('leaves gates, failures and housekeeping literal at every tick', () => {
    expect(turnSummaryVoiceLabel({ kind: 'awaiting_approval' }, 9)).toBe('Awaiting approval')
    expect(turnSummaryVoiceLabel({ kind: 'awaiting_question' }, 9)).toBe('Awaiting answer')
    expect(turnSummaryVoiceLabel({ kind: 'compacting' }, 9)).toBe('Compacting…')
    expect(turnSummaryVoiceLabel({ kind: 'reconnecting', attempt: 2, maxAttempts: 5 }, 9)).toBe(
      'Reconnecting (2/5)'
    )
  })
})

describe('runActivityVoiceLabel', () => {
  const VOICED = ['working', 'thinking', 'planning', 'writing'] as const

  it('voices only the four phases that have no verb of their own', () => {
    for (const kind of VOICED) {
      // Tick 1 is the first rotation, and is past the plain word for any pool
      // of two or more — so this stays true however the pools are edited.
      expect(RUN_VOICE_PHRASES[kind]).toContain(runActivityVoiceLabel({ kind }, 1))
      expect(runActivityVoiceLabel({ kind }, 1)).not.toBe(formatRunActivityLabel({ kind }))
    }
  })

  it('agrees with the announced wording at the top of the rotation', () => {
    // The plain word is shown and announced at once, so the two copies of it
    // — the pool's first entry and the literal label — must not drift apart.
    for (const kind of VOICED) {
      expect(runActivityVoiceLabel({ kind }, 0)).toBe(formatRunActivityLabel({ kind }))
      expect(RUN_VOICE_PHRASES[kind][0]).toBe(formatRunActivityLabel({ kind }))
    }
  })

  it('never diverges from the literal label on a phase it does not voice', () => {
    const literal = [
      { kind: 'compacting' },
      { kind: 'verifying_compact' },
      { kind: 'retrying_compact' },
      { kind: 'awaiting_approval' },
      { kind: 'awaiting_question' }
    ] as const
    for (const phase of literal) {
      expect(runActivityVoiceLabel(phase, 2)).toBe(formatRunActivityLabel(phase))
    }
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

describe('reconnecting label', () => {
  it('keeps the counted form when there is an attempt ceiling', () => {
    expect(formatRunActivityLabel({ kind: 'reconnecting', attempt: 2, maxAttempts: 5 })).toBe(
      'Reconnecting (2/5)'
    )
  })

  it('does not print a "/0" ceiling for unbounded retries', () => {
    // Provider retries carry maxAttempts 0 by design (retry until recovery);
    // every real network_wait event measured used it, so "(17/0)" was what
    // users actually saw.
    const label = formatRunActivityLabel({ kind: 'reconnecting', attempt: 17, maxAttempts: 0 })
    expect(label).toBe('Reconnecting (attempt 17)')
    expect(label).not.toContain('/0')
  })

  it("shows the provider's own reason when it gave one", () => {
    expect(
      formatRunActivityLabel({
        kind: 'reconnecting',
        attempt: 3,
        maxAttempts: 0,
        reason: '5-hour usage limit reached. Resets in 3hr 16min.'
      })
    ).toBe('Reconnecting (attempt 3) — 5-hour usage limit reached. Resets in 3hr 16min.')
  })

  it('truncates a long provider reason instead of flooding the status line', () => {
    const long = 'x'.repeat(300)
    const label = formatRunActivityLabel({
      kind: 'reconnecting',
      attempt: 1,
      maxAttempts: 0,
      reason: long
    })
    expect(label.length).toBeLessThan(140)
    expect(label.startsWith('Reconnecting (attempt 1) — ')).toBe(true)
  })

  it('falls back to the plain label when the reason is blank', () => {
    expect(
      formatRunActivityLabel({ kind: 'reconnecting', attempt: 4, maxAttempts: 0, reason: '   ' })
    ).toBe('Reconnecting (attempt 4)')
  })
})
