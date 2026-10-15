/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { VoiceConversation, VoiceConversationEntry, VoiceConversationSummary } from '@shared/ipc/schemas/voiceConversations'
import { conversationRows, GAP_MS } from '@renderer/features/voice/history/conversationRows'
import { VoiceConversationsDialog } from '@renderer/features/voice/history/VoiceConversationsDialog'
import { requestVoiceConversations } from '@renderer/features/voice/history/voiceHistoryRequests'
import { voiceOriginFor } from '@renderer/features/voice/history/voiceConversationStore'

const at = (s: number): string => new Date(Date.UTC(2026, 9, 14, 16, 52, 0) + s * 1000).toISOString()

const ENTRIES: VoiceConversationEntry[] = [
  { at: at(0), kind: 'start', listener: 'openrouter', speaker: 'openrouter' },
  { at: at(1), kind: 'you', turnId: 't1', text: 'Explain this project.' },
  { at: at(2), kind: 'voice', contextId: 'c1', text: 'On it.' },
  { at: at(2), kind: 'voice', contextId: 'c1', text: 'Handing it over.' },
  { at: at(3), kind: 'hand_off', handOffId: 'h1', brief: 'Explore the codebase and explain it.' },
  { at: at(3), kind: 'followed', runId: 'run-1', handOffId: 'h1' },
  { at: at(4), kind: 'dropped', reason: 'echo', chars: 9 },
  { at: at(5), kind: 'agent', contextId: 'a1', text: 'It is an Electron app.' },
  { at: at(6), kind: 'answered', what: 'approval', text: 'yes', decision: 'once', tool: 'terminal' },
  { at: at(7), kind: 'hand_off', handOffId: 'h2', brief: 'Run the tests.' },
  { at: at(7), kind: 'not_sent', handOffId: 'h2', reason: 'refused' },
  { at: at(8 + GAP_MS / 1000), kind: 'you', turnId: 't2', text: 'Stop', stop: true },
  { at: at(9 + GAP_MS / 1000), kind: 'stop_agent', by: 'you' },
  { at: at(9 + GAP_MS / 1000), kind: 'error', side: 'listener', code: 'network' },
  { at: at(10 + GAP_MS / 1000), kind: 'end' }
]

const SUMMARY: VoiceConversationSummary = {
  id: '2026-10-14T16-52-00-000Z_s1',
  startedAt: at(0),
  endedAt: at(10 + GAP_MS / 1000),
  turns: 2,
  firstWords: 'Explain this project.',
  runIds: ['run-1'],
  sent: [{ runId: 'run-1', brief: 'Explore the codebase and explain it.' }],
  handOffs: 2,
  notSent: 1
}

describe('conversationRows', () => {
  it('joins a reply’s sentences, gives hand-offs their outcome, and keeps noise out of the exchange', () => {
    const { rows, quiet } = conversationRows(ENTRIES)
    expect(rows.map((r) => r.kind)).toEqual(['you', 'voice', 'hand_off', 'agent', 'answered', 'hand_off', 'gap', 'you', 'stop_agent'])
    expect(rows[1]).toMatchObject({ text: 'On it. Handing it over.' })
    expect(rows[2]).toMatchObject({ outcome: { kind: 'sent', runId: 'run-1' } })
    expect(rows[5]).toMatchObject({ outcome: { kind: 'not_sent', reason: 'refused' } })
    expect(quiet).toEqual({ dropped: 1, errors: [{ side: 'listener', code: 'network' }] })
  })

  it('a hand-off nothing answered says so; a followed with no hand-off is its own row', () => {
    const { rows } = conversationRows([
      { at: at(0), kind: 'hand_off', handOffId: 'h1', brief: 'one' },
      { at: at(1), kind: 'end' }
    ])
    expect(rows[0]).toMatchObject({ outcome: { kind: 'unknown' } })
    const steered = conversationRows([{ at: at(0), kind: 'followed', runId: 'r9' }]).rows
    expect(steered).toEqual([expect.objectContaining({ kind: 'followed', runId: 'r9' })])
  })

  it('two replies stay two lines', () => {
    const { rows } = conversationRows([
      { at: at(0), kind: 'voice', contextId: 'c1', text: 'One.' },
      { at: at(1), kind: 'voice', contextId: 'c2', text: 'Two.' }
    ])
    expect(rows.map((r) => (r.kind === 'voice' ? r.text : ''))).toEqual(['One.', 'Two.'])
  })

  it('marks your turn the voice stayed quiet on, and words that were never a turn (2026-10-15 audit)', () => {
    const { rows } = conversationRows([
      { at: at(0), kind: 'task', runId: 'run-1' },
      { at: at(1), kind: 'you', turnId: 't1', text: 'Good, good, good, good, good, good, good, good.' },
      { at: at(2), kind: 'unanswered', turnId: 't1' },
      { at: at(3), kind: 'unanswered', turnId: 'n1', text: 'Okay.' }
    ])
    expect(rows).toMatchObject([
      { kind: 'you', text: 'Good, good, good, good, good, good, good, good.', unanswered: true },
      { kind: 'you', text: 'Okay.', unanswered: true }
    ])
  })
})

describe('voiceOriginFor', () => {
  it('marks the instruction whose words the hand-off carried, in its own task only', () => {
    expect(voiceOriginFor([SUMMARY], 'run-1', 'Explore the codebase and explain it.')).toEqual({ conversationId: SUMMARY.id, turns: 2 })
    // A new task starts from what was typed, then the spoken words.
    expect(voiceOriginFor([SUMMARY], 'run-1', 'Read docs first.\n\nExplore the codebase  and explain it.')).not.toBeNull()
    expect(voiceOriginFor([SUMMARY], 'run-1', 'Something typed.')).toBeNull()
    expect(voiceOriginFor([SUMMARY], 'run-2', 'Explore the codebase and explain it.')).toBeNull()
    expect(voiceOriginFor([{ ...SUMMARY, sent: [{ runId: 'run-1', brief: '' }] }], 'run-1', 'anything')).toBeNull()
  })
})

describe('VoiceConversationsDialog', () => {
  const list = vi.fn()
  const read = vi.fn()

  beforeEach(() => {
    list.mockResolvedValue({ ok: true, data: [SUMMARY] })
    read.mockResolvedValue({ ok: true, data: { summary: SUMMARY, entries: ENTRIES, skipped: 0 } satisfies VoiceConversation })
    ;(window as unknown as { vyotiq: unknown }).vyotiq = { voiceConversationsList: list, voiceConversationRead: read }
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('lists a workspace’s conversations by day and opens one', async () => {
    render(<VoiceConversationsDialog />)
    await act(async () => {
      expect(requestVoiceConversations('C:/work')).toBe(true)
    })
    expect(list).toHaveBeenCalledWith({ workspacePath: 'C:/work' })
    expect(screen.getByRole('dialog', { name: 'Voice conversations' })).toBeTruthy()
    const item = document.querySelector(`[data-voice-history-item="${SUMMARY.id}"]`) as HTMLElement
    expect(item.textContent).toContain('Explain this project.')
    expect(item.textContent).toContain('2 turns')
    expect(item.textContent).toContain('1 task')
    expect(item.textContent).toContain('1 not sent')
    await act(async () => {
      fireEvent.click(item)
    })
    expect(read).toHaveBeenCalledWith({ workspacePath: 'C:/work', id: SUMMARY.id })
    const rows = [...document.querySelectorAll('[data-voice-history-row]')].map((r) => r.getAttribute('data-voice-history-row'))
    expect(rows).toEqual(['you', 'voice', 'hand_off', 'agent', 'answered', 'hand_off', 'gap', 'you', 'stop_agent'])
    expect(document.querySelector('[data-voice-history-outcome="not_sent"]')?.textContent).toContain('wasn’t ready')
    expect(document.querySelector('[data-voice-history-quiet]')?.textContent).toBe('1 sound not taken as a turn · 1 error (network)')
    // Back to the list.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'All voice conversations' }))
    })
    expect(document.querySelector('[data-voice-history-list]')).not.toBeNull()
  })

  it('opened from a brief goes straight to the conversation, and Open task opens the run', async () => {
    const onOpenTask = vi.fn()
    render(<VoiceConversationsDialog onOpenTask={onOpenTask} />)
    await act(async () => {
      requestVoiceConversations('C:/work', SUMMARY.id)
    })
    expect(list).not.toHaveBeenCalled()
    expect(document.querySelector(`[data-voice-history-detail="${SUMMARY.id}"]`)).not.toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open task' }))
    })
    expect(onOpenTask).toHaveBeenCalledWith('C:/work', 'run-1')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a turn left unanswered as the live view does: muted, "Not answered"', async () => {
    read.mockResolvedValue({
      ok: true,
      data: {
        summary: SUMMARY,
        entries: [
          { at: at(0), kind: 'you', turnId: 't1', text: 'Good, good, good.' },
          { at: at(1), kind: 'unanswered', turnId: 't1' }
        ],
        skipped: 0
      } satisfies VoiceConversation
    })
    render(<VoiceConversationsDialog />)
    await act(async () => {
      requestVoiceConversations('C:/work', SUMMARY.id)
    })
    const row = document.querySelector('[data-voice-history-row="you"]') as HTMLElement
    expect(row.textContent).toContain('Not answered')
    expect(row.querySelector('.text-muted')?.textContent).toBe('Good, good, good.')
  })

  it('says when a conversation is no longer kept', async () => {
    read.mockResolvedValue({ ok: false, error: 'That voice conversation is no longer kept' })
    render(<VoiceConversationsDialog />)
    await act(async () => {
      requestVoiceConversations('C:/work', SUMMARY.id)
    })
    expect(screen.getByRole('alert').textContent).toBe('That voice conversation is no longer kept')
  })

  it('nothing kept yet says so', async () => {
    list.mockResolvedValue({ ok: true, data: [] })
    render(<VoiceConversationsDialog />)
    await act(async () => {
      requestVoiceConversations('C:/Users/me/work')
    })
    expect(document.querySelector('[data-voice-history]')?.textContent).toContain('No voice conversations kept')
  })
})

describe('a brief said by voice', () => {
  afterEach(cleanup)

  it('links to its conversation; a typed brief says nothing', async () => {
    const { buildRecordModel } = await import('@renderer/features/task/recordModel')
    const { Brief } = await import('@renderer/features/task/record/Brief')
    const [run] = buildRecordModel(
      [{ kind: 'message', id: 'user-0', role: 'user', content: 'Explore the codebase and explain it.' }],
      { running: false }
    ).runs
    const onOpen = vi.fn()
    const { container, rerender } = render(<Brief run={run!} voice={{ turns: 12, onOpen }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Said by voice · 12 turns' }))
    expect(onOpen).toHaveBeenCalledOnce()
    rerender(<Brief run={run!} />)
    expect(container.querySelector('[data-brief-voice]')).toBeNull()
  })
})
