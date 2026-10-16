/**
 * The 2026-10-14 voice audit, from Ajay's kept conversations: sound tags
 * ("[background noise]") were answered as if spoken, a bare "okay" kept a
 * noisy room talking, and a dropped connection lost or replayed turns. Since
 * §27 the agent answers every turn itself; these are the listening half.
 */
import { describe, expect, it, vi } from 'vitest'
import { ACK_MS, RECONNECT_DELAYS_MS, STOPPED_LINE, VoiceSession, asksSomething, type VoiceSessionDeps } from '@main/voice/session'
import { cleanTranscript, isBackchannel, isOtherScript, soundsUnfinished } from '@main/voice/speechText'
import { EchoGuard } from '@main/voice/echoGuard'
import { MIN_SPEECH_AGENT_TALKING_MS, PauseDetector, SILENCE_MS } from '@main/voice/pauseDetector'
import { openFixtureStt, type FixtureSttSession } from '@main/voice/providers/fixture'
import type { SttOpenOptions, TtsStream } from '@main/voice/providers/types'
import { DEFAULT_VOICE_SETTINGS, type VoiceEvent, type VoiceSettings } from '@shared/ipc/schemas/voice'
import type { AgentEvent } from '@shared/ipc'

const tick = () => new Promise((r) => setTimeout(r, 0))

/** Timers the test fires by hand. */
function manualTimers() {
  let clock = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  let next = 0
  return {
    now: () => clock,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++next
      timers.set(id, { at: clock + ms, fn })
      return id
    },
    clearTimer: (h: unknown) => void timers.delete(h as number),
    advance(ms: number) {
      clock += ms
      for (const [id, t] of [...timers]) {
        if (t.at <= clock && timers.has(id)) {
          timers.delete(id)
          t.fn()
        }
      }
    }
  }
}

function silentTts(): TtsStream {
  return { pushText: () => {}, flush: () => {}, end: () => {}, cancel: () => {}, done: () => Promise.resolve() } as unknown as TtsStream
}

describe('what the listener heard', () => {
  it('drops sound tags, keeps the words', () => {
    expect(cleanTranscript('[background noise]')).toBe('')
    expect(cleanTranscript('[clears throat] Can you, uh, run multiple sessions?')).toBe('Can you, uh, run multiple sessions?')
    expect(cleanTranscript('Can you run another task? [clears throat]')).toBe('Can you run another task?')
    expect(cleanTranscript('(laughs) ♪♪')).toBe('')
    expect(cleanTranscript('Okay (coughing) run it.')).toBe('Okay run it.')
    expect(cleanTranscript('Version (2) please')).toBe('Version (2) please')
  })

  it('a transcript in another script than your language is the listener inventing', () => {
    expect(isOtherScript('はい。', 'en')).toBe(true)
    expect(isOtherScript('Hello', 'en')).toBe(false)
    expect(isOtherScript('はい。', 'ja')).toBe(false)
    expect(isOtherScript('はい。', '')).toBe(false)
    expect(isOtherScript('123', 'en')).toBe(false)
  })

  it('Hindi and Punjabi are kept alongside English: they are spoken here (2026-10-16 decision)', () => {
    // Dropped as noise before: "क्या?" at 02:35:00 and 02:50:41 on 2026-10-16 went unanswered.
    expect(isOtherScript('क्या?', 'en')).toBe(false)
    expect(isOtherScript('ਕੀ ਹਾਲ ਹੈ', 'en')).toBe(false)
    expect(isOtherScript('Яндекс', 'en')).toBe(true)
  })

  it('knows a backchannel from a request, and an unfinished phrase from a finished one', () => {
    expect(isBackchannel('Okay.')).toBe(true)
    expect(isBackchannel('Thank you!')).toBe(true)
    expect(isBackchannel('Okay, run the tests.')).toBe(false)
    expect(isBackchannel('Stop.')).toBe(false)
    expect(soundsUnfinished('Can you')).toBe(true)
    expect(soundsUnfinished('Run the tests and')).toBe(true)
    expect(soundsUnfinished('So,')).toBe(true)
    expect(soundsUnfinished('Can you run the tests?')).toBe(false)
    expect(soundsUnfinished('Thank you')).toBe(false)
    expect(soundsUnfinished('Resume the session.')).toBe(false)
  })
})

function sessionHarness(over: Partial<VoiceSettings> = {}, deps: Partial<VoiceSessionDeps> = {}) {
  const events: VoiceEvent[] = []
  let tap: ((ev: AgentEvent) => void) | null = null
  const stt: FixtureSttSession[] = []
  const ends: Array<(heard: boolean) => void> = []
  const t = manualTimers()
  let n = 0
  const settings: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS, sttProvider: 'openrouter', ...over }
  const session = new VoiceSession({
    emit: (e) => events.push(e),
    settings: () => settings,
    keys: () => ({ voice: {}, chat: { openrouter: true } }),
    readKey: () => 'k',
    sttProvider: (id) => ({
      id,
      open: async (o: SttOpenOptions) => {
        const s = await openFixtureStt(o)
        stt.push(s)
        return s
      }
    }),
    openTts: (_contextId, _onError, onEnd) => {
      if (onEnd) ends.push(onEnd)
      return silentTts()
    },
    tapRun: (_runId, fn) => {
      tap = fn
      return () => {
        tap = null
      }
    },
    now: t.now,
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
    newId: () => `id${++n}`,
    ...deps
  })
  const turns = () => events.flatMap((e) => (e.kind === 'turn' ? [e.text] : []))
  /** The agent answers out loud: its run's spoken block, as the run tap brings it. */
  const agentSays = (text: string): void => {
    if (!tap) session.follow('run-1', `h${events.length}`)
    tap!({ type: 'status', runId: 'run-1', status: 'running' } as AgentEvent)
    tap!({ type: 'text_delta', runId: 'run-1', text: `<spoken>${text}</spoken>` } as unknown as AgentEvent)
    tap!({ type: 'assistant_message', runId: 'run-1', content: `<spoken>${text}</spoken>` } as unknown as AgentEvent)
  }
  return { session, events, stt: () => stt.at(-1)!, ends, t, turns, agentSays }
}

describe('the voice in a session', () => {
  it('a sound tag is not a turn, and the words around one are', async () => {
    const h = sessionHarness()
    await h.session.start()
    h.stt().say('[background noise]')
    await tick()
    expect(h.turns()).toEqual([])
    expect(h.events.some((e) => e.kind === 'hand_off')).toBe(false)
    expect(h.session.state).toBe('listening')
    h.stt().say('[clears throat] Run the tests.')
    await tick()
    expect(h.turns()).toEqual(['Run the tests.'])
  })

  it('a stray "はい。" is not a turn when you speak English', async () => {
    const h = sessionHarness({ language: 'en' })
    await h.session.start()
    h.stt().say('はい。')
    await tick()
    expect(h.turns()).toEqual([])
  })

  it('"Okay" to nothing in particular gets no answer; after a question it is your answer', async () => {
    const h = sessionHarness()
    await h.session.start()
    h.stt().say('Okay.')
    await tick()
    expect(h.turns()).toEqual([])
    h.stt().say('Run the tests.')
    await tick()
    h.agentSays('Do you want the slow ones too?')
    expect(h.events.some((e) => e.kind === 'say')).toBe(true)
    h.stt().say('Okay.')
    await tick()
    expect(h.turns()).toEqual(['Run the tests.', 'Okay.'])
  })

  it('"Yes" after an offer with no question mark is your answer', async () => {
    expect(asksSomething('I can have it check that if you like.')).toBe(true)
    expect(asksSomething('Want me to run them? It takes a minute.')).toBe(true)
    expect(asksSomething('It is still running.')).toBe(false)
    const h = sessionHarness()
    await h.session.start()
    h.stt().say('Is the build broken?')
    await tick()
    h.agentSays('Not that I know. I can check it if you like.')
    expect(h.events.filter((e) => e.kind === 'say').length).toBeGreaterThan(0)
    h.stt().say('Yes.')
    await tick()
    expect(h.turns()).toEqual(['Is the build broken?', 'Yes.'])
  })

  it('a reply whose speech never makes a sound does not leave the session in Thinking', async () => {
    const h = sessionHarness()
    await h.session.start()
    h.stt().say('Hello, you there?')
    await tick()
    expect(h.session.state).toBe('thinking')
    // Nothing from the agent yet: the short line opens a speech that never sounds.
    h.t.advance(ACK_MS)
    await vi.waitFor(() => expect(h.ends).toHaveLength(1))
    h.ends[0]!(false)
    expect(h.session.state).toBe('listening')
  })

})

describe('the echo check', () => {
  it('words you finished before the agent spoke are never its echo', () => {
    const g = new EchoGuard()
    g.said('Run the tests and tell me what fails.', 5000)
    g.setPlaying(true, 5100)
    // A whole-turn listener's words, finished at 4000, arrive while it plays.
    expect(g.isEcho('run the tests and tell me what fails', 4000)).toBe(false)
    expect(g.isEcho('run the tests and tell me what fails', 5200)).toBe(true)
  })
})

function tone(ms: number, amp = 8000): Int16Array {
  const n = Math.round((ms / 1000) * 16000)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin(i / 3) * amp)
  return out
}
const silence = (ms: number) => new Int16Array(Math.round((ms / 1000) * 16000))
const unanswered = (events: VoiceEvent[]) => events.flatMap((e) => (e.kind === 'unanswered' ? [e] : []))

describe("this round's choices (2026-10-14)", () => {
  it('words it chose not to answer stay on screen, marked', async () => {
    const h = sessionHarness()
    await h.session.start()
    // Dropped before the model: a new line, with its words.
    h.stt().say('Okay.')
    await tick()
    expect(unanswered(h.events)).toEqual([{ sessionId: 'id1', kind: 'unanswered', turnId: expect.any(String), text: 'Okay.' }])
  })

  it('"stop" with work running stops it and says so; with nothing running it stays silent', async () => {
    const h = sessionHarness()
    await h.session.start()
    h.stt().say('Stop.')
    await tick()
    expect(h.events.some((e) => e.kind === 'say')).toBe(false)
    h.session.follow('run-1')
    h.stt().say('Stop.')
    await tick()
    expect(h.events.some((e) => e.kind === 'stop_agent')).toBe(true)
    expect(h.events.filter((e) => e.kind === 'say').map((e) => ('text' in e ? e.text : ''))).toEqual([STOPPED_LINE])
    // "Stop" needs no model and goes to no one: it stops the work.
    expect(h.events.some((e) => e.kind === 'hand_off')).toBe(false)
  })

  function streamingHarness(endTurns: number[], answer = true) {
    return sessionHarness(
      { sttProvider: 'openai' },
      {
        keys: () => ({ voice: {}, chat: { openai: true } }),
        sttProvider: (id) => ({
          id,
          open: async (o: SttOpenOptions) => {
            const s = await openFixtureStt(o)
            const index = endTurns.length
            endTurns.push(0)
            const real = s.endTurn.bind(s)
            s.endTurn = () => {
              endTurns[index]!++
              if (answer) real()
            }
            received.push(s.received)
            return s
          }
        })
      }
    )
  }
  const received: Int16Array[][] = []

  it('after a reconnect, a turn already answered is not played again', async () => {
    const ends: number[] = []
    received.length = 0
    const h = streamingHarness(ends)
    await h.session.start()
    h.session.pushAudio(tone(400))
    h.session.pushAudio(silence(SILENCE_MS.normal + 100))
    expect(ends).toEqual([1])
    h.session['onStt']({ kind: 'closed', reason: 'drop' })
    expect(h.session.state).toBe('reconnecting')
    h.t.advance(RECONNECT_DELAYS_MS[0])
    await vi.waitFor(() => expect(h.session.state).toBe('listening'))
    // Nothing of the answered turn went to the new connection, and nothing was ended again.
    expect(received[1]!.some((pcm) => pcm.some((v) => v !== 0))).toBe(false)
    expect(ends).toEqual([1, 0])
  })

  it('after a reconnect, a turn whose answer the drop took is played and ended again', async () => {
    const ends: number[] = []
    received.length = 0
    const h = streamingHarness(ends, false)
    await h.session.start()
    h.session.pushAudio(tone(400))
    h.session.pushAudio(silence(SILENCE_MS.normal + 100))
    h.session['onStt']({ kind: 'closed', reason: 'drop' })
    // And one said entirely while it was down.
    h.session.pushAudio(tone(400))
    h.session.pushAudio(silence(SILENCE_MS.normal + 100))
    h.t.advance(RECONNECT_DELAYS_MS[0])
    await vi.waitFor(() => expect(h.session.state).toBe('listening'))
    expect(received[1]!.some((pcm) => pcm.some((v) => v !== 0))).toBe(true)
    expect(ends).toEqual([1, 2])
  })
})

describe('short words', () => {
  it('a crisp "Stop." (about 150 ms of voice) is speech, a knock is not; while the agent talks the bar stays at 300 ms', () => {
    const quiet = new PauseDetector('normal')
    quiet.push(silence(500))
    const heard = [...quiet.push(tone(150)), ...quiet.push(silence(SILENCE_MS.normal + 100))].map((e) => e.kind)
    expect(heard).toContain('speech_start')
    expect(heard).toContain('pause')
    const knock = new PauseDetector('normal')
    knock.push(silence(500))
    expect([...knock.push(tone(60)), ...knock.push(silence(2000))]).toEqual([])
    const talking = new PauseDetector('normal')
    talking.setAgentSpeaking(true)
    talking.push(silence(500))
    expect([...talking.push(tone(MIN_SPEECH_AGENT_TALKING_MS - 60)), ...talking.push(silence(2000))]).toEqual([])
  })
})
