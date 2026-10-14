import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPTION_STALL_MS, CaptionPacer } from '@renderer/features/voice/captionPacer'

function pacer(sounding = false) {
  const shown: string[] = []
  const state = { sounding }
  const p = new CaptionPacer({ reveal: (_c, text) => shown.push(text), sounding: () => state.sounding })
  return { p, shown, state }
}

describe('captions in step with the voice', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a provider that can’t mark sentences: waiting captions show as the next audio plays', () => {
    const { p, shown } = pacer()
    p.say('c', 'One.', true)
    p.audio('c', undefined, 0)
    expect(shown).toEqual(['One.'])
    p.say('c', 'Two.', true)
    p.audio('c', undefined, 200)
    expect(shown).toEqual(['One.'])
    vi.advanceTimersByTime(200)
    expect(shown).toEqual(['One.', 'Two.'])
  })

  it('a caption behind a long sentence still playing waits; it shows once the voice goes quiet without it', () => {
    const { p, shown, state } = pacer(true)
    p.say('c', 'Long first sentence.', true)
    p.audio('c', 0, 0)
    p.say('c', 'Second.', true)
    vi.advanceTimersByTime(CAPTION_STALL_MS)
    // Still speaking the first: the second's audio may be right behind it.
    expect(shown).toEqual(['Long first sentence.'])
    state.sounding = false
    vi.advanceTimersByTime(CAPTION_STALL_MS)
    expect(shown).toEqual(['Long first sentence.', 'Second.'])
  })

  it('an older main that doesn’t say whether audio follows: shown at once', () => {
    const { p, shown } = pacer()
    p.say('c', 'Hello.', undefined)
    expect(shown).toEqual(['Hello.'])
  })

  it('drained shows what is left; dropped shows nothing more; clear cancels everything', () => {
    const { p, shown } = pacer()
    p.say('a', 'A.', true)
    p.drained('a')
    p.say('b', 'B.', true)
    p.drop('b')
    p.say('c', 'C.', true)
    p.clear()
    vi.advanceTimersByTime(CAPTION_STALL_MS * 3)
    expect(shown).toEqual(['A.'])
  })
})
