import { describe, expect, it, vi } from 'vitest'
import { MAX_VOICED_ZCR, MIN_SPEECH_MS, PauseDetector, SILENCE_MS, settleMs, zeroCrossingRate } from '@main/voice/pauseDetector'
import { RECONNECT_DELAYS_MS, VoiceSession, type VoiceSessionDeps } from '@main/voice/session'
import { FixtureSttSession, openFixtureStt } from '@main/voice/providers/fixture'
import type { SttOpenOptions, SttProvider } from '@main/voice/providers/types'
import { DEFAULT_VOICE_SETTINGS, type VoiceEvent, type VoiceSettings } from '@shared/ipc/schemas/voice'
import type { VoiceKeyAvailability } from '@shared/voice'

function tone(ms: number, amp = 8000): Int16Array {
  const n = Math.round((ms / 1000) * 16000)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin(i / 3) * amp)
  return out
}
const silence = (ms: number) => new Int16Array(Math.round((ms / 1000) * 16000))

describe('PauseDetector', () => {
  it('reports speech after 300 ms and a pause after the patience window', () => {
    const d = new PauseDetector('normal')
    expect(d.push(silence(500))).toEqual([])
    expect(d.push(tone(320))).toEqual([{ kind: 'speech_start' }])
    expect(d.push(silence(SILENCE_MS.normal - 200))).toEqual([{ kind: 'settling' }])
    const out = d.push(silence(400))
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ kind: 'pause', speechMs: 320, silenceMs: SILENCE_MS.normal })
  })

  it('says when the turn has probably ended, and when talking resumes after that (B10)', () => {
    const d = new PauseDetector('normal')
    d.push(tone(400))
    expect(d.push(silence(settleMs('normal') - 40))).toEqual([])
    expect(d.push(silence(60))).toEqual([{ kind: 'settling' }])
    expect(d.push(tone(100))).toEqual([{ kind: 'resumed' }])
    // Once per quiet stretch, and the turn still ends on the full pause.
    const rest = [...d.push(silence(SILENCE_MS.normal + 100))].map((e) => e.kind)
    expect(rest).toEqual(['settling', 'pause'])
    expect(settleMs('quick')).toBe(500)
    expect(settleMs('patient')).toBe(600)
  })

  it('hiss, breath and key clicks are not speech, however loud (B3)', () => {
    let seed = 7
    const noise = (ms: number, amp: number) => {
      const out = new Int16Array(Math.round((ms / 1000) * 16000))
      for (let i = 0; i < out.length; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        out[i] = Math.round(((seed / 0x7fffffff) * 2 - 1) * amp)
      }
      return out
    }
    const d = new PauseDetector('normal')
    expect([...d.push(silence(300)), ...d.push(noise(2000, 6000)), ...d.push(silence(2000))]).toEqual([])
    expect(zeroCrossingRate(noise(20, 6000), 0, 320)).toBeGreaterThan(MAX_VOICED_ZCR)
    // A voice-like tone at the same loudness still is.
    expect(zeroCrossingRate(tone(20), 0, 320)).toBeLessThan(MAX_VOICED_ZCR)
    expect(d.push(tone(320))).toEqual([{ kind: 'speech_start' }])
  })

  it('a pause between two sentences doesn’t end the turn (D-43)', () => {
    // "Hello." [0.8 s] "Can you hear me?" was two messages at 0.75 s.
    const d = new PauseDetector('normal')
    const events = [...d.push(tone(400)), ...d.push(silence(800)), ...d.push(tone(900)), ...d.push(silence(SILENCE_MS.normal + 100))]
    expect(events.map((e) => e.kind).filter((k) => k === 'speech_start' || k === 'pause')).toEqual(['speech_start', 'pause'])
  })

  it('a sound under 300 ms is never speech', () => {
    const d = new PauseDetector('normal')
    expect([...d.push(tone(MIN_SPEECH_MS - 40)), ...d.push(silence(2000))]).toEqual([])
  })

  it('ignores a click too short to be speech', () => {
    const d = new PauseDetector('quick')
    expect([...d.push(tone(60)), ...d.push(silence(1000))]).toEqual([])
  })

  it('is stricter while the agent speaks', () => {
    const d = new PauseDetector('normal')
    d.push(silence(400))
    d.setAgentSpeaking(true)
    expect(d.push(tone(300, 150))).toEqual([])
  })
})

type Harness = {
  session: VoiceSession
  events: VoiceEvent[]
  stt: () => FixtureSttSession
  opens: SttOpenOptions[]
  settings: VoiceSettings
  timers: Array<{ fn: () => void; ms: number }>
  runTimers: () => Promise<void>
}

function harness(
  over: Partial<VoiceSettings> = {},
  keys: VoiceKeyAvailability = { voice: { deepgram: true }, chat: { openai: true } },
  provider?: (id: string) => SttProvider
): Harness {
  const events: VoiceEvent[] = []
  const sessions: FixtureSttSession[] = []
  const opens: SttOpenOptions[] = []
  const timers: Array<{ fn: () => void; ms: number }> = []
  const settings: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS, ...over }
  let n = 0
  const deps: VoiceSessionDeps = {
    emit: (e) => events.push(e),
    settings: () => settings,
    keys: () => keys,
    readKey: () => 'k',
    sttProvider:
      (provider as VoiceSessionDeps['sttProvider']) ??
      ((id) => ({
        id,
        open: async (o) => {
          opens.push(o)
          const s = await openFixtureStt(o)
          sessions.push(s)
          return s
        }
      })),
    keyterms: ['runAgent'],
    setTimer: (fn, ms) => {
      const t = { fn, ms }
      timers.push(t)
      return t
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number])
      if (i >= 0) timers.splice(i, 1)
    },
    newId: () => `id${++n}`
  }
  return {
    session: new VoiceSession(deps),
    events,
    stt: () => sessions.at(-1)!,
    opens,
    settings,
    timers,
    runTimers: async () => {
      const due = timers.splice(0)
      for (const t of due) t.fn()
      await Promise.resolve()
      await Promise.resolve()
    }
  }
}

const states = (events: VoiceEvent[]) => events.flatMap((e) => (e.kind === 'state' ? [e.state] : []))

describe('VoiceSession', () => {
  it('connects to the resolved listener with model, patience and key terms', async () => {
    const h = harness({ endOfTurnPatience: 'patient', language: '' })
    await h.session.start()
    expect(h.session.state).toBe('listening')
    expect(h.session.listener).toBe('deepgram')
    expect(h.opens[0]).toMatchObject({ apiKey: 'k', model: 'flux-general-en', patience: 'patient', keyterms: ['runAgent'] })
    expect(states(h.events)).toEqual(['connecting', 'listening'])
    expect(h.events).toContainEqual({ sessionId: 'id1', kind: 'engine', stt: 'deepgram' })
  })

  it('a finished turn is emitted for the renderer to send, and the session waits on the agent', async () => {
    const h = harness()
    await h.session.start()
    h.stt().say('fix the flaky test')
    expect(h.events.filter((e) => e.kind === 'partial')).toHaveLength(1)
    expect(h.events).toContainEqual({ sessionId: 'id1', kind: 'turn', turnId: 'id2', text: 'fix the flaky test', stop: false })
    expect(h.session.state).toBe('thinking')
  })

  it('flags a stop phrase so the renderer cancels instead of sending', async () => {
    const h = harness()
    await h.session.start()
    h.stt().say('Never mind.')
    expect(h.events.find((e) => e.kind === 'turn')).toMatchObject({ stop: true })
  })

  it('an empty turn is a false start, not a message', async () => {
    const h = harness()
    await h.session.start()
    h.stt().say('')
    expect(h.events.some((e) => e.kind === 'turn')).toBe(false)
    expect(h.session.state).toBe('listening')
  })

  it('ends turns on a local pause for listeners without turn detection', async () => {
    const h = harness({ sttProvider: 'openai' })
    await h.session.start()
    const endTurn = vi.spyOn(h.stt(), 'endTurn')
    h.session.pushAudio(tone(400))
    expect(h.session.state).toBe('hearing')
    h.session.pushAudio(silence(SILENCE_MS.normal + 100))
    expect(endTurn).toHaveBeenCalledTimes(1)
  })

  it('leaves turn-ending to listeners that detect turns themselves', async () => {
    const h = harness({ sttProvider: 'deepgram' })
    await h.session.start()
    const endTurn = vi.spyOn(h.stt(), 'endTurn')
    h.session.pushAudio(tone(400))
    h.session.pushAudio(silence(900))
    expect(endTurn).not.toHaveBeenCalled()
  })

  it('push-to-talk only: sends audio while held and ends the turn on release', async () => {
    const h = harness({ pushToTalkOnly: true })
    await h.session.start()
    h.session.pushAudio(tone(200))
    expect(h.stt().received).toHaveLength(0)
    h.session.ptt(true)
    h.session.pushAudio(tone(200))
    expect(h.stt().received).toHaveLength(1)
    const endTurn = vi.spyOn(h.stt(), 'endTurn')
    h.session.ptt(false)
    expect(endTurn).toHaveBeenCalledTimes(1)
  })

  it('mute stops audio and keeps the connection alive', async () => {
    const h = harness()
    await h.session.start()
    h.session.setMuted(true)
    expect(h.session.state).toBe('paused')
    h.session.pushAudio(tone(200))
    expect(h.stt().received).toHaveLength(0)
    expect(h.timers).toHaveLength(1)
    h.session.setMuted(false)
    expect(h.session.state).toBe('listening')
    expect(h.timers).toHaveLength(0)
  })

  it('reconnects after a dropped connection and replays the turn so far', async () => {
    const h = harness()
    await h.session.start()
    h.session.pushAudio(tone(300))
    h.stt().close()
    expect(h.session.state).toBe('reconnecting')
    expect(h.events).toContainEqual({ sessionId: 'id1', kind: 'reconnecting', attempt: 1 })
    h.session.pushAudio(tone(100))
    expect(h.timers[0]!.ms).toBe(RECONNECT_DELAYS_MS[0])
    await h.runTimers()
    await vi.waitFor(() => expect(h.session.state).toBe('listening'))
    expect(h.opens).toHaveLength(2)
    expect(h.stt().received.length).toBeGreaterThanOrEqual(2)
  })

  it('gives up after five failed reconnects and says it is offline', async () => {
    let calls = 0
    const h = harness({}, undefined, (id) => ({
      id: id as 'deepgram',
      open: async (o) => {
        calls++
        if (calls === 1) return openFixtureStt(o)
        throw new TypeError('fetch failed')
      }
    }))
    await h.session.start()
    h.session['onStt']({ kind: 'error', code: 'offline', message: 'x', retryable: true })
    for (let i = 0; i < RECONNECT_DELAYS_MS.length; i++) await h.runTimers()
    expect(h.session.state).toBe('error')
    expect(h.events.at(-1)).toMatchObject({ kind: 'error', code: 'offline', retryable: true })
  })

  it('a rejected key is an error at once, with no reconnecting', async () => {
    const h = harness()
    await h.session.start()
    h.session['onStt']({ kind: 'error', code: 'rejected_key', message: 'x', retryable: false })
    expect(h.session.state).toBe('error')
    expect(h.timers).toHaveLength(0)
  })

  it('without any listener key it fails with no_key', async () => {
    const h = harness({}, { voice: {}, chat: {} })
    await h.session.start()
    expect(h.session.state).toBe('error')
    expect(h.events.at(-1)).toMatchObject({ kind: 'error', code: 'no_key', retryable: false })
  })

  it('a session failure says which side failed and carries the provider’s reason (D-40)', async () => {
    const h = harness()
    await h.session.start()
    h.session['onStt']({ kind: 'error', code: 'rejected_key', message: 'Deepgram closed (1008)  invalid   key', retryable: false })
    expect(h.events.at(-1)).toMatchObject({ kind: 'error', side: 'session', detail: 'Deepgram closed (1008) invalid key' })
  })

  it('a whole-turn listener’s failed upload loses the turn, not the session (A-03)', async () => {
    const h = harness({}, { voice: {}, chat: { openrouter: true } })
    await h.session.start()
    expect(h.session.listener).toBe('openrouter')
    h.session.pushAudio(tone(300))
    expect(h.session.state).toBe('hearing')
    h.session['onStt']({ kind: 'error', code: 'provider_down', message: 'OpenRouter (502): bad gateway', retryable: true })
    expect(h.session.state).toBe('listening')
    expect(h.timers).toHaveLength(0)
    expect(states(h.events)).not.toContain('reconnecting')
    expect(h.events.at(-1)).toMatchObject({ kind: 'error', side: 'turn', code: 'provider_down', detail: 'OpenRouter (502): bad gateway' })
  })

  it('a whole-turn listener out of credit ends the session with the reason (A-03, A-04)', async () => {
    const h = harness({}, { voice: {}, chat: { openrouter: true } })
    await h.session.start()
    h.session['onStt']({ kind: 'error', code: 'out_of_credit', message: 'needs $0.50 in balance for audio', retryable: false })
    expect(h.session.state).toBe('error')
    expect(h.events.at(-1)).toMatchObject({ side: 'session', code: 'out_of_credit', retryable: false })
  })

  it('a listener that drops again right after reconnecting keeps backing off, then gives up (A-03)', async () => {
    const h = harness()
    await h.session.start()
    for (let i = 0; i < RECONNECT_DELAYS_MS.length; i++) {
      h.session['onStt']({ kind: 'error', code: 'offline', message: 'closed (1006)', retryable: true })
      expect(h.timers.at(-1)!.ms).toBe(RECONNECT_DELAYS_MS[i])
      await h.runTimers()
      await vi.waitFor(() => expect(h.session.state).toBe('listening'))
    }
    h.session['onStt']({ kind: 'error', code: 'offline', message: 'closed (1006)', retryable: true })
    expect(h.session.state).toBe('error')
    expect(h.events.at(-1)).toMatchObject({ code: 'offline', detail: 'Gave up reconnecting: closed (1006)' })
  })

  it('reports a fallback listener', async () => {
    const h = harness({ sttProvider: 'assemblyai' })
    await h.session.start()
    expect(h.events).toContainEqual({ sessionId: 'id1', kind: 'engine', stt: 'deepgram', sttFellBackFrom: 'assemblyai' })
  })

  it('stop closes the listener and ignores anything after', async () => {
    const h = harness()
    await h.session.start()
    const stt = h.stt()
    await h.session.stop()
    expect(stt.closed).toBe(true)
    expect(h.session.state).toBe('off')
    stt.say('late words')
    expect(h.events.some((e) => e.kind === 'turn')).toBe(false)
  })

  it('talking while the agent has the floor is a barge-in', async () => {
    const h = harness()
    await h.session.start()
    h.stt().say('first question')
    h.session.agentEvent({ type: 'audio_start' })
    expect(h.session.state).toBe('speaking')
    h.stt().say('wait, actually', false)
    expect(h.session.state).toBe('hearing')
  })
})
