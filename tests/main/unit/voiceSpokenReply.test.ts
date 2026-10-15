/**
 * What the voice says out loud (eighth audit, 2026-10-15 kept conversations):
 * a seven-sentence answer was read out in full, and "(Noted, staying quiet.)"
 * was spoken as if it were words.
 */
import { describe, expect, it } from 'vitest'
import { MAX_SPOKEN_SENTENCES, RESPONDER_SYSTEM, VoiceResponder, type ResponderChat, type ResponderChunk } from '@main/voice/responder'
import type { TtsStream } from '@main/voice/providers/types'

function harness(answer: string) {
  const said: Array<{ text: string; audible: boolean }> = []
  const spoken: string[] = []
  const done: unknown[] = []
  const chat: ResponderChat = () =>
    (async function* (): AsyncGenerator<ResponderChunk> {
      yield { type: 'text', text: answer }
      yield { type: 'done' }
    })()
  const tts = (): TtsStream =>
    ({ pushText: (t: string) => spoken.push(t), flush: () => {}, end: () => {}, cancel: () => {}, done: () => Promise.resolve() }) as unknown as TtsStream
  let n = 0
  const r = new VoiceResponder({
    chat: () => chat,
    openTts: () => tts(),
    say: (_c, text, audible) => said.push({ text, audible }),
    handOff: () => {},
    stopAgent: () => {},
    done: (d) => done.push(d),
    agentStatus: () => ({ working: false }),
    newId: () => `c${++n}`,
    now: () => 0,
    setTimer: () => null,
    clearTimer: () => {}
  })
  return { r, said, spoken, done }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('a spoken reply', () => {
  it(`says ${MAX_SPOKEN_SENTENCES} sentences; the rest is shown with it, never spoken`, async () => {
    const h = harness(
      'Vyotiq is an Electron app. It has three processes. Shared types sit in one module. It uses React. It has big files. The details are on your screen.'
    )
    h.r.respond('Summarize the code base.')
    await tick()
    await tick()
    expect(h.spoken).toEqual(['Vyotiq is an Electron app.', 'It has three processes.', 'Shared types sit in one module.'])
    // The rest is one more caption of the same reply, waiting behind the spoken ones.
    expect(h.said.at(-1)).toEqual({ text: 'It uses React. It has big files. The details are on your screen.', audible: true })
  })

  it('never says a note in brackets', async () => {
    const h = harness('(Noted, staying quiet.)')
    h.r.respond('Dear.')
    await tick()
    await tick()
    expect(h.spoken.join(' ')).not.toContain('Noted')
    // It meant to say nothing: no "Sorry, I lost that" either, and the turn is marked as left quiet.
    expect(h.said).toEqual([])
    expect(h.done).toEqual([expect.objectContaining({ quiet: expect.objectContaining({ chars: 5 }) })])
  })

  it('is told not to write notes or mention the app’s own context', () => {
    expect(RESPONDER_SYSTEM).toContain('Never write notes to yourself')
    expect(RESPONDER_SYSTEM).toContain('never say something is attached')
  })
})
