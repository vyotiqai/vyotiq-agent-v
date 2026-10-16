/**
 * Voice mode is the agent (docs/voice-mode.md §27): each turn goes to the
 * task as your words, so the view and the kept history show those words once,
 * with one work row per run, and a turn that didn't go still says why.
 */
import { describe, expect, it } from 'vitest'
import { buildEntries } from '@renderer/features/voice/view/parts'
import { conversationRows } from '@renderer/features/voice/history/conversationRows'
import type { VoiceLine } from '@renderer/features/voice/voiceSessionController'
import type { VoiceConversationEntry } from '@shared/ipc/schemas/voiceConversations'

describe('the live view', () => {
  it('one work row per run, on its latest turn; a turn that never went stays, with why', () => {
    const lines: VoiceLine[] = [
      { id: 't1', who: 'you', text: 'Run the tests.' },
      { id: 'h1', who: 'agent', text: 'Run the tests.', runId: 'r1' },
      { id: 't2', who: 'you', text: 'How is it going?' },
      { id: 'h2', who: 'agent', text: 'How is it going?', runId: 'r1' },
      { id: 't3', who: 'you', text: 'Also the lint.' },
      { id: 'h3', who: 'agent', text: 'Also the lint.', failed: 'refused' }
    ]
    const entries = buildEntries(lines, {})
    expect(entries.filter((e) => e.who === 'work').map((e) => e.id)).toEqual(['h2', 'h3'])
    expect(entries.find((e) => e.id === 'h2')).toMatchObject({ continued: false })
    expect(entries.find((e) => e.id === 'h3')).toMatchObject({ failed: 'refused' })
  })
})

describe('the kept history', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 16, 3, 0, s)).toISOString()

  it('a hand-off that was your words as said shows only what became of it', () => {
    const entries = [
      { at: at(0), kind: 'you', turnId: 't1', text: 'Can you' },
      { at: at(1), kind: 'you', turnId: 't2', text: 'open the terminal?' },
      { at: at(2), kind: 'hand_off', handOffId: 'h1', brief: 'Can you open the terminal?' },
      { at: at(3), kind: 'followed', runId: 'r1', handOffId: 'h1' }
    ] as VoiceConversationEntry[]
    const { rows } = conversationRows(entries)
    expect(rows.find((r) => r.kind === 'hand_off')).toMatchObject({ brief: '', outcome: { kind: 'sent', runId: 'r1' } })
  })

  it('a brief the old voice wrote in its own words is still shown', () => {
    const entries = [
      { at: at(0), kind: 'you', turnId: 't1', text: 'Search the models for me.' },
      { at: at(1), kind: 'voice', contextId: 'c1', text: 'Sure.' },
      { at: at(2), kind: 'hand_off', handOffId: 'h1', brief: 'Research online the fastest models.' }
    ] as VoiceConversationEntry[]
    const { rows } = conversationRows(entries)
    expect(rows.find((r) => r.kind === 'hand_off')).toMatchObject({ brief: 'Research online the fastest models.' })
  })
})
