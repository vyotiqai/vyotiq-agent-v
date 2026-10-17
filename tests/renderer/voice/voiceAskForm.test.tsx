/** @vitest-environment jsdom */
/**
 * A question no button can answer (an email, several picks, several
 * questions) is the task's own question form in the voice view, to type in
 * as well as say: the agent said "Just type them here" and opened a new task
 * so there was a box (2026-10-17 09:09:36).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { DEFAULT_VOICE_SETTINGS, VoiceWorkSchema, type VoiceWork } from '@shared/ipc/schemas/voice'
import { VoiceMiniCommandSchema } from '@shared/ipc/schemas/voiceMini'
import { AskRow, StageContext, type StageApi } from '@renderer/features/voice/stage/kit'
import { hint, type WorkEntry } from '@renderer/features/voice/stage/model'
import { IDLE_VOICE } from '@renderer/features/voice/voiceSessionController'

afterEach(cleanup)

const noop = (): void => {}

function stage(over: Partial<StageApi> = {}): StageApi {
  return {
    v: IDLE_VOICE,
    settings: DEFAULT_VOICE_SETTINGS,
    startedAt: null,
    escArmed: false,
    level: () => 0,
    micLevel: () => 0,
    mute: noop,
    hold: noop,
    stopSpeaking: noop,
    stopTask: noop,
    end: noop,
    patchSettings: noop,
    respondApproval: async () => undefined,
    respondQuestion: async () => undefined,
    pickers: false,
    ...over
  }
}

const emailWork: VoiceWork = {
  runId: 'run-1',
  state: 'needs',
  startedAt: 0,
  stepCount: 0,
  steps: [],
  ask: {
    kind: 'question',
    requestId: 'q1',
    questionId: 'email',
    prompt: 'What email should the commits use?',
    options: [],
    form: { questions: [{ id: 'email', prompt: 'What email should the commits use?', type: 'text' }] }
  }
}

describe('a question to type in, in the voice view', () => {
  it('draws the task’s form and sends what was typed', async () => {
    const respondForm = vi.fn(async () => ({ ok: true }))
    const { container } = render(
      <StageContext.Provider value={stage({ respondForm })}>
        <AskRow work={emailWork} />
      </StageContext.Provider>
    )
    expect(container.querySelector('[data-voice-ask="form"]')).not.toBeNull()
    const field = container.querySelector<HTMLTextAreaElement | HTMLInputElement>('textarea, input[type="text"], input:not([type])')
    expect(field).not.toBeNull()
    // Not focused on arrival: Space stays push-to-talk until they click into it.
    expect(document.activeElement).not.toBe(field)
    fireEvent.change(field!, { target: { value: 'singhrajveer1597@gmail.com' } })
    fireEvent.submit(container.querySelector('form')!)
    await waitFor(() => expect(respondForm).toHaveBeenCalledWith('q1', [{ questionId: 'email', values: ['singhrajveer1597@gmail.com'] }], 'run-1'))
  })

  it('says so on the form when the answer didn’t reach the task, and lets it be sent again', async () => {
    const respondForm = vi.fn(async () => ({ ok: false }))
    const { container, findByRole } = render(
      <StageContext.Provider value={stage({ respondForm })}>
        <AskRow work={emailWork} />
      </StageContext.Provider>
    )
    const field = container.querySelector<HTMLTextAreaElement | HTMLInputElement>('textarea, input')!
    fireEvent.change(field, { target: { value: 'a@b.co' } })
    fireEvent.submit(container.querySelector('form')!)
    expect((await findByRole('alert')).textContent).toContain('didn’t reach the task')
  })

  it('where no form can be sent (an ended conversation), it points to the task as before', () => {
    const showTask = vi.fn()
    const { container, getByText } = render(
      <StageContext.Provider value={stage({ showTask })}>
        <AskRow work={emailWork} />
      </StageContext.Provider>
    )
    expect(container.querySelector('[data-voice-ask="form"]')).toBeNull()
    expect(getByText('Answer on the task')).toBeTruthy()
  })

  it('a pick a click can answer keeps its buttons', () => {
    const work: VoiceWork = { ...emailWork, ask: { kind: 'question', requestId: 'q2', questionId: 'x', prompt: 'Which one?', options: ['main', 'dev'] } }
    const { container, getByText } = render(
      <StageContext.Provider value={stage({ respondForm: async () => ({ ok: true }) })}>
        <AskRow work={work} />
      </StageContext.Provider>
    )
    expect(container.querySelector('[data-voice-ask="form"]')).toBeNull()
    expect(getByText('main')).toBeTruthy()
  })

  it('the hint says it can be typed', () => {
    const entry = { who: 'work', work: emailWork } as unknown as WorkEntry
    expect(hint({ ...IDLE_VOICE, state: 'waiting_on_you' }, DEFAULT_VOICE_SETTINGS, entry, 0)).toBe('Say your answer, or type it in')
  })

  it('the form passes the event schema, and the mini window can send one', () => {
    expect(VoiceWorkSchema.safeParse(emailWork).success).toBe(true)
    expect(VoiceMiniCommandSchema.safeParse({ kind: 'form', requestId: 'q1', runId: 'run-1', answers: [{ questionId: 'email', values: ['a@b.co'] }] }).success).toBe(true)
  })
})
