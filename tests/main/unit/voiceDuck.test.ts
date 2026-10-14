import { describe, expect, it } from 'vitest'
import { DUCK_CONFIRM_MS, DUCK_GIVE_UP_MS, VoiceSession } from '@main/voice/session'
import { openFixtureStt, openFixtureTts, type FixtureSttSession, type FixtureTtsStream } from '@main/voice/providers/fixture'
import { DEFAULT_VOICE_SETTINGS, type VoiceEvent } from '@shared/ipc/schemas/voice'
import type { AgentEvent } from '@shared/ipc'

const R = 'run1'

function tone(ms: number, amp = 8000): Int16Array {
  const n = Math.round((ms / 1000) * 16000)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin(i / 3) * amp)
  return out
}
const silence = (ms: number) => new Int16Array(Math.round((ms / 1000) * 16000))

/** A session with the agent mid-reply: its audio is playing. */
async function speaking() {
  let clock = 0
  const events: VoiceEvent[] = []
  const stt: FixtureSttSession[] = []
  const tts: FixtureTtsStream[] = []
  let tap: ((e: AgentEvent) => void) | null = null
  let n = 0
  const session = new VoiceSession({
    emit: (e) => events.push(e),
    settings: () => DEFAULT_VOICE_SETTINGS,
    keys: () => ({ voice: { deepgram: true }, chat: {} }),
    readKey: () => 'k',
    sttProvider: (id) => ({
      id,
      open: async (o) => {
        const s = await openFixtureStt(o)
        stt.push(s)
        return s
      }
    }),
    openTts: (contextId) => {
      const s = openFixtureTts({
        apiKey: '',
        model: '',
        voiceId: '',
        speed: 1,
        contextId,
        signal: new AbortController().signal,
        onAudio: () => {},
        onError: () => {}
      })
      tts.push(s)
      return s
    },
    tapRun: (_runId, fn) => {
      tap = fn
      return () => {
        tap = null
      }
    },
    now: () => clock,
    setTimer: () => null,
    clearTimer: () => {},
    newId: () => `id${++n}`
  })
  await session.start()
  stt.at(-1)!.say('explain the failure')
  session.follow(R)
  tap!({ type: 'text_delta', runId: R, text: '<spoken>The build broke on a missing import. It keeps going. ' } as AgentEvent)
  const contextId = (events.find((e) => e.kind === 'say') as { contextId: string }).contextId
  session.playback(contextId, 'started')
  // Feed audio in 20 ms frames, moving the clock with it.
  const feed = (pcm: Int16Array) => {
    for (let i = 0; i < pcm.length; i += 320) {
      session.pushAudio(pcm.subarray(i, i + 320))
      clock += 20
    }
  }
  const ducks = () => events.filter((e) => e.kind === 'duck').map((e) => (e as { on: boolean }).on)
  const flushed = () => events.some((e) => e.kind === 'flush')
  return { session, events, stt: () => stt.at(-1)!, tts, feed, ducks, flushed, contextId }
}

describe('barge-in dips first, then stops (D-33)', () => {
  it('a sound over the agent dips its voice without stopping it', async () => {
    const h = await speaking()
    h.feed(tone(320))
    expect(h.ducks()).toEqual([true])
    expect(h.flushed()).toBe(false)
    expect(h.session.state).toBe('speaking')
  })

  it('a cough: the voice comes back once nothing more is heard', async () => {
    const h = await speaking()
    h.feed(tone(320))
    h.feed(silence(DUCK_GIVE_UP_MS + 100))
    expect(h.ducks()).toEqual([true, false])
    expect(h.flushed()).toBe(false)
    expect(h.tts[0]!.cancelled).toBe(false)
    expect(h.session.state).toBe('speaking')
  })

  it('keeping talking stops the agent', async () => {
    const h = await speaking()
    h.feed(tone(DUCK_CONFIRM_MS + 100))
    expect(h.ducks()).toEqual([true, false])
    expect(h.flushed()).toBe(true)
    expect(h.tts[0]!.cancelled).toBe(true)
    expect(h.session.state).toBe('hearing')
  })

  it('your words from the listener stop it at once; the agent’s own words bring it back', async () => {
    const h = await speaking()
    h.feed(tone(320))
    h.stt().say('the build broke on a missing import', false)
    expect(h.flushed()).toBe(false)
    expect(h.ducks().at(-1)).toBe(false)
    h.feed(silence(40))
    h.feed(tone(320))
    h.stt().say('wait, check the lockfile', false)
    expect(h.flushed()).toBe(true)
    expect(h.session.state).toBe('hearing')
  })

  it('if the agent finishes while you’re talking, your turn carries on', async () => {
    const h = await speaking()
    h.feed(tone(320))
    h.session.playback(h.contextId, 'drained')
    expect(h.ducks()).toEqual([true, false])
    // The run is still going: nothing is cut off for a sound (B1); your words still make a turn.
    expect(h.session.state).toBe('working')
    h.stt().say('and check the lockfile too')
    expect(h.events).toContainEqual(expect.objectContaining({ kind: 'turn', text: 'and check the lockfile too' }))
  })
})
