import { describe, expect, it, vi } from 'vitest'
import { PauseDetector } from '@main/voice/pauseDetector'
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
  it('reports speech after 200 ms and a pause after the patience window', () => {
    const d = new PauseDetector('normal')
    expect(d.push(silence(500))).toEqual([])
    expect(d.push(tone(300))).toEqual([{ kind: 'speech_start' }])
    expect(d.push(silence(500))).toEqual([])
    const out = d.push(silence(400))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'pause' })
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
    h.session.pushAudio(silence(900))
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
