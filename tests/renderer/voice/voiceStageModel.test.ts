import { describe, expect, it } from 'vitest'
import { exchange, hint, latestWork, summaryTasks, summaryTitle } from '@renderer/features/voice/stage/model'
import { CURRENT_WORK_BRIEF, IDLE_VOICE, type VoiceSnapshot } from '@renderer/features/voice/voiceSessionController'
import type { VoiceWork } from '@shared/ipc/schemas/voice'

const snap = (over: Partial<VoiceSnapshot>): VoiceSnapshot => ({ ...IDLE_VOICE, state: 'listening', ...over })
const work = (over: Partial<VoiceWork>): VoiceWork => ({ runId: 'r1', state: 'running', startedAt: 0, stepCount: 0, steps: [], ...over })

describe('the current exchange', () => {
  it('your words as you say them are the live side', () => {
    expect(exchange(snap({ state: 'hearing', partial: 'fix the' }))).toMatchObject({ you: 'fix the', voice: '', live: 'you' })
  })

  it('your turn split by a pause reads as one; only the newest reply after it', () => {
    const x = exchange(
      snap({
        transcript: [
          { id: 'a', who: 'voice', text: 'Earlier reply.' },
          { id: 't1', who: 'you', text: 'Make a file' },
          { id: 't2', who: 'you', text: 'called todo.' },
          { id: 'c1', who: 'voice', text: 'On it.' },
          { id: 'h1', who: 'agent', text: 'Make todo.' },
          { id: 'c2', who: 'voice', text: 'Done.' }
        ]
      })
    )
    expect(x).toMatchObject({ you: 'Make a file called todo.', voice: 'Done.', voiceLineId: 'c2', live: null })
  })

  it('speaking makes its reply the live side, unless that reply was cut', () => {
    const transcript = [
      { id: 't1', who: 'you' as const, text: 'Hi.' },
      { id: 'c1', who: 'voice' as const, text: 'Hello there.' }
    ]
    expect(exchange(snap({ state: 'speaking', transcript })).live).toBe('voice')
    expect(exchange(snap({ state: 'speaking', transcript, cutLineId: 'c1' })).live).toBeNull()
  })

  it('words left unanswered say so', () => {
    expect(exchange(snap({ transcript: [{ id: 't1', who: 'you', text: 'Hmm.', unanswered: true }] })).unanswered).toBe(true)
  })
})

describe('the line under the headline', () => {
  const now = 75_000
  it('never repeats the brief or the step: how far, while it works', () => {
    const v = snap({ state: 'working', transcript: [{ id: 'h1', who: 'agent', text: 'Run the tests.', runId: 'r1' }], works: { r1: work({ stepCount: 3 }) } })
    expect(hint(v, { pushToTalkOnly: false }, latestWork(v), now)).toBe('3 steps · 1 min 15 s')
  })

  it('reconnecting says the try and that nothing is lost; push-to-talk says how to talk', () => {
    expect(hint(snap({ state: 'reconnecting', reconnectAttempt: 2 }), { pushToTalkOnly: false }, undefined, now)).toBe('Try 2 · what you say is kept')
    expect(hint(snap({ transcript: [{ id: 't', who: 'you', text: 'x' }] }), { pushToTalkOnly: true }, undefined, now)).toBe('Hold Space to talk')
  })

  it('waiting on you says how to answer, and a risky ask sends you to the task', () => {
    const at = (ask: VoiceWork['ask']) => {
      const v = snap({ state: 'waiting_on_you', transcript: [{ id: 'h1', who: 'agent', text: 'x', runId: 'r1' }], works: { r1: work({ state: 'needs', ask }) } })
      return hint(v, { pushToTalkOnly: false }, latestWork(v), now)
    }
    expect(at({ kind: 'approval', requestId: 'a', what: 'run x', risky: false })).toBe('Say yes or no, or use the buttons')
    expect(at({ kind: 'approval', requestId: 'a', what: 'run x', risky: true })).toBe('It could be risky: answer it on the task')
    expect(at({ kind: 'question', requestId: 'q', questionId: 'b', prompt: 'Which?', options: ['a', 'b'] })).toBe('Say your answer, or pick one')
  })
})

describe('the summary', () => {
  it('one row per run, newest last, with how it ended; a run still going says so', () => {
    const tasks = summaryTasks(
      [
        { id: 'h1', who: 'agent', text: 'Fix it.', runId: 'r1' },
        { id: 'h2', who: 'agent', text: 'Also lint.', runId: 'r1' },
        { id: 'run:r2', who: 'agent', text: CURRENT_WORK_BRIEF, runId: 'r2' },
        { id: 'h3', who: 'agent', text: 'Never sent.', failed: 'refused' }
      ],
      {
        r1: work({ state: 'done', endedAt: 100_000, result: '**All 14 pass.**\nMore detail.' }),
        r2: work({ runId: 'r2', state: 'failed', endedAt: 5_000 })
      },
      200_000
    )
    expect(tasks).toEqual([
      { runId: 'r1', brief: 'Fix it.', state: 'done', outcome: 'All 14 pass.', time: '1 min 40 s' },
      { runId: 'r2', brief: 'Its current work', state: 'failed', outcome: 'Stopped by an error.', time: '5 s' }
    ])
    expect(summaryTitle(tasks)).toBe('1 task done · 1 stopped')
    expect(summaryTitle([])).toBe('No work started')
  })
})
