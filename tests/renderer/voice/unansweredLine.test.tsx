/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { DEFAULT_VOICE_SETTINGS } from '@shared/ipc/schemas/voice'
import { HistoryList, StageContext, type StageApi } from '@renderer/features/voice/stage/kit'
import { IDLE_VOICE, markUnanswered, type VoiceLine } from '@renderer/features/voice/voiceSessionController'

afterEach(cleanup)

const noop = (): void => {}

function stage(transcript: readonly VoiceLine[]): StageApi {
  return {
    v: { ...IDLE_VOICE, transcript },
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
    pickers: false
  }
}

describe('words the voice left unanswered', () => {
  it('show muted and say so in the conversation; answered ones do not', () => {
    let lines: readonly VoiceLine[] = [{ id: 't1', who: 'you', text: 'Run the tests.' }]
    lines = markUnanswered(lines, 'u1', 'Um.')
    const { container } = render(
      <StageContext.Provider value={stage(lines)}>
        <HistoryList />
      </StageContext.Provider>
    )
    const marked = container.querySelectorAll('[data-voice-unanswered]')
    expect(marked).toHaveLength(1)
    expect(marked[0]!.textContent).toContain('Um.')
    expect(marked[0]!.textContent).toContain('Not answered')
    expect(marked[0]!.querySelector('.text-muted')).not.toBeNull()
    const answered = [...container.querySelectorAll('[data-voice-line="you"]')].find((li) => !li.hasAttribute('data-voice-unanswered'))
    expect(answered?.textContent).toBe('YouRun the tests.')
  })
})
