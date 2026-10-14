/**
 * The 2026-10-14 voice audit, from Ajay's kept conversations: the voice knew
 * nothing of the task it opened on, some turns showed on screen and were
 * never answered, and sound tags ("[background noise]") were answered as if
 * spoken.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  EMPTY_LINE,
  FIRST_WORD_MS,
  QUIET_TOOL,
  STILL_THINKING_LINE,
  STILL_THINKING_MS,
  mayStayQuiet,
  VoiceResponder,
  type ResponderChat,
  type ResponderChunk,
  type ResponderDeps
} from '@main/voice/responder'
import { HOLD_MAX_MS, RECONNECT_DELAYS_MS, STOPPED_LINE, UNFINISHED_WAIT_MS, VoiceSession, asksSomething, type VoiceSessionDeps } from '@main/voice/session'
import { cleanTranscript, isBackchannel, isOtherScript, soundsUnfinished } from '@main/voice/speechText'
import { formatTaskContext } from '@main/voice/taskContext'
import { EchoGuard } from '@main/voice/echoGuard'
import { MIN_SPEECH_AGENT_TALKING_MS, PauseDetector, SILENCE_MS } from '@main/voice/pauseDetector'
import { openFixtureStt, type FixtureSttSession } from '@main/voice/providers/fixture'
import type { SttOpenOptions, TtsStream } from '@main/voice/providers/types'
import { DEFAULT_VOICE_SETTINGS, type VoiceEvent, type VoiceSettings } from '@shared/ipc/schemas/voice'
import type { ChatMessage } from '@shared/ipc'

function fakeModel() {
  type Call = { status: string; messages: ChatMessage[]; tools: Array<{ name: string }>; signal: AbortSignal; push: (c: ResponderChunk) => void; end: () => void }
  const calls: Call[] = []
  const chat: ResponderChat = (req) => {
    const queue: ResponderChunk[] = []
    let ended = false
    let wake: (() => void) | null = null
    calls.push({
      status: req.status,
      messages: req.messages,
      tools: req.tools as Array<{ name: string }>,
      signal: req.signal,
      push: (c) => {
        queue.push(c)
        wake?.()
      },
      end: () => {
        ended = true
        wake?.()
      }
    })
    return (async function* () {
      for (;;) {
        if (req.signal.aborted) return
        const next = queue.shift()
        if (next) {
          yield next
          continue
        }
        if (ended) return
        await new Promise<void>((r) => (wake = r))
        wake = null
      }
    })()
  }
  return { chat, calls }
}

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

function responder(over: Partial<ResponderDeps> = {}) {
  const model = fakeModel()
  const said: string[] = []
  const done: Array<Parameters<ResponderDeps['done']>[0]> = []
  const handOffs: string[] = []
  const t = manualTimers()
  let n = 0
  const deps: ResponderDeps = {
    chat: () => model.chat,
    openTts: () => silentTts(),
    say: (_c, text) => said.push(text),
    handOff: (b) => handOffs.push(b),
    stopAgent: vi.fn(),
    done: (r) => done.push(r),
    agentStatus: () => ({ working: false }),
    newId: () => `c${++n}`,
    now: t.now,
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
    ...over
  }
  return { r: new VoiceResponder(deps), model, said, done, handOffs, t }
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

describe('the task the voice is on', () => {
  it('reads what you asked and what the agent answered, never its steps', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Analyze the codebase.' },
      { role: 'assistant', content: 'Looking.', toolCalls: [{ id: 't', name: 'list_dir', arguments: '{}' }] },
      { role: 'tool', content: 'src/ tests/', toolCallId: 't' },
      { role: 'assistant', content: '<spoken>Done.</spoken>\nThe codebase has 3 parts.' },
      { role: 'user', content: 'continue', synthetic: true }
    ]
    expect(formatTaskContext(messages)).toBe('[You] Analyze the codebase.\n[Agent] The codebase has 3 parts.')
  })

  it('names how the task began when its start is out of reach', () => {
    const text = formatTaskContext([{ role: 'assistant', content: 'Half way.' }], { goal: 'Fix the login bug', earlier: true })
    expect(text.split('\n')[0]).toBe('(The task began with: Fix the login bug)')
  })

  it('says how its last run ended', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Analyze the codebase.' }]
    expect(formatTaskContext(messages, { ended: { status: 'error', error: 'Prompt tokens limit exceeded' } })).toBe(
      '[You] Analyze the codebase.\n(Its last run stopped with an error: Prompt tokens limit exceeded)'
    )
    expect(formatTaskContext(messages, { ended: { status: 'running' } })).toBe('[You] Analyze the codebase.')
    expect(formatTaskContext([], { ended: { status: 'done' } })).toBe('')
  })

  it('goes to the voice model with every turn', async () => {
    const h = responder({ taskContext: () => '[You] Fix the login bug.\n[Agent] Fixed in auth.ts.' })
    h.r.respond('Resume the session.')
    await tick()
    expect(h.model.calls[0]!.status).toContain('[Agent] Fixed in auth.ts.')
    expect(h.model.calls[0]!.status).toContain('The agent is idle.')
  })
})

describe('every turn gets an answer', () => {
  it('a model that says nothing is asked again, then the voice says it lost it', async () => {
    const h = responder()
    h.r.respond('Resume the session.')
    await tick()
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(h.model.calls).toHaveLength(2))
    h.model.calls[1]!.end()
    await vi.waitFor(() => expect(h.done).toHaveLength(1))
    expect(h.said.join(' ')).toContain(EMPTY_LINE.split('.')[0]!)
    expect(h.handOffs).toEqual([])
  })

  it('a model that never starts is asked again, then the turn goes to the agent', async () => {
    const h = responder()
    h.r.respond('Resume the session.')
    await tick()
    h.t.advance(FIRST_WORD_MS)
    await vi.waitFor(() => expect(h.model.calls).toHaveLength(2))
    expect(h.model.calls[0]!.signal.aborted).toBe(true)
    h.t.advance(FIRST_WORD_MS)
    await vi.waitFor(() => expect(h.done).toHaveLength(1))
    expect(h.handOffs).toEqual(['Resume the session.'])
  })

  it('an answer that started is never cut by the first-word wait', async () => {
    const h = responder()
    h.r.respond('How is it going?')
    await tick()
    h.model.calls[0]!.push({ type: 'text', text: 'Still working on it' })
    await tick()
    h.t.advance(FIRST_WORD_MS + 1000)
    h.model.calls[0]!.push({ type: 'text', text: ', nearly done.' })
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(h.done).toHaveLength(1))
    expect(h.model.calls).toHaveLength(1)
    expect(h.said.join(' ')).toBe('Still working on it, nearly done.')
  })

  it('stays quiet when the model says it heard only a sound', async () => {
    const h = responder()
    h.r.respond('Mm, the fan.')
    await tick()
    expect(h.model.calls[0]!.tools.map((t) => t.name)).toContain(QUIET_TOOL)
    h.model.calls[0]!.push({ type: 'tool_call', name: QUIET_TOOL, arguments: '{}' })
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(h.done).toHaveLength(1))
    expect(h.said).toEqual([])
    // The one turn that ends in silence says so, for the log.
    expect(h.done[0]).toEqual({ audible: false, handedOff: false, quiet: { chars: 'Mm, the fan.'.length, turnIds: [] } })
  })

  it('never stays quiet on a question or a real request: it is asked again, then says it lost it', async () => {
    expect(mayStayQuiet('Mm, the fan.')).toBe(true)
    expect(mayStayQuiet('What did it find?')).toBe(false)
    expect(mayStayQuiet('Have it look at the login page again')).toBe(false)
    const h = responder()
    h.r.respond('What did it find?')
    await tick()
    h.model.calls[0]!.push({ type: 'tool_call', name: QUIET_TOOL, arguments: '{}' })
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(h.model.calls).toHaveLength(2))
    h.model.calls[1]!.push({ type: 'text', text: 'It found two failing tests.' })
    h.model.calls[1]!.end()
    await vi.waitFor(() => expect(h.done).toHaveLength(1))
    expect(h.said.join(' ')).toBe('It found two failing tests.')
  })

  it('waits on "Can you" for the rest, and answers both as one turn', async () => {
    const h = responder()
    h.r.respond('Can you', { waitMs: UNFINISHED_WAIT_MS })
    await tick()
    expect(h.model.calls).toHaveLength(0)
    h.r.respond('spawn subagents for the audit?')
    await tick()
    expect(h.model.calls).toHaveLength(1)
    h.t.advance(UNFINISHED_WAIT_MS)
    await tick()
    expect(h.model.calls).toHaveLength(1)
  })
})

function sessionHarness(over: Partial<VoiceSettings> = {}, deps: Partial<VoiceSessionDeps> = {}) {
  const model = fakeModel()
  const events: VoiceEvent[] = []
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
    responder: () => model.chat,
    now: t.now,
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
    newId: () => `id${++n}`,
    ...deps
  })
  const turns = () => events.flatMap((e) => (e.kind === 'turn' ? [e.text] : []))
  return { session, events, model, stt: () => stt.at(-1)!, ends, t, turns }
}

describe('the voice in a session', () => {
  it('a sound tag is not a turn, and the words around one are', async () => {
    const h = sessionHarness()
    await h.session.start()
    h.stt().say('[background noise]')
    await tick()
    expect(h.turns()).toEqual([])
    expect(h.model.calls).toHaveLength(0)
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
    h.model.calls[0]!.push({ type: 'text', text: 'Do you want the slow ones too?' })
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(h.events.some((e) => e.kind === 'say')).toBe(true))
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
    h.model.calls[0]!.push({ type: 'text', text: 'Not that I know. I can have it check if you like.' })
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(h.events.filter((e) => e.kind === 'say')).toHaveLength(2))
    h.stt().say('Yes.')
    await tick()
    expect(h.turns()).toEqual(['Is the build broken?', 'Yes.'])
  })

  it('a reply whose speech never makes a sound does not leave the session in Thinking', async () => {
    const h = sessionHarness()
    await h.session.start()
    h.stt().say('Hello, you there?')
    await tick()
    h.model.calls[0]!.push({ type: 'text', text: 'Yes, I am here.' })
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(h.ends).toHaveLength(1))
    await tick()
    expect(h.session.state).toBe('thinking')
    h.ends[0]!(false)
    expect(h.session.state).toBe('listening')
  })

  it('reads the task it is on, and again when you start talking', async () => {
    const load = vi.fn(async (runId: string) => `[You] task ${runId}`)
    const h = sessionHarness({}, { loadTaskContext: load })
    await h.session.start()
    h.session.setTask('run1', 'C:/ws')
    expect(load).toHaveBeenCalledWith('run1', 'C:/ws')
    await tick()
    h.t.advance(6000)
    h.stt().say('Resume the session.')
    await tick()
    expect(load).toHaveBeenCalledTimes(2)
    expect(h.model.calls[0]!.status).toContain('[You] task run1')
  })

  it('a hold under steady noise lets go after HOLD_MAX_MS', async () => {
    const h = sessionHarness()
    await h.session.start()
    h.stt().say('What changed today?')
    await tick()
    // A sound while the voice works the answer out: it holds what it would say.
    ;(h.session as unknown as { onSpeechStart: () => void }).onSpeechStart()
    h.model.calls[0]!.push({ type: 'text', text: 'Two files changed.' })
    h.model.calls[0]!.end()
    await tick()
    await tick()
    expect(h.events.some((e) => e.kind === 'say')).toBe(false)
    h.t.advance(HOLD_MAX_MS)
    await vi.waitFor(() => expect(h.events.some((e) => e.kind === 'say')).toBe(true))
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
    // The model stayed quiet: the turn already on screen is marked.
    h.stt().say('Mm, the fan.')
    await tick()
    const turn = h.events.find((e) => e.kind === 'turn')
    h.model.calls[0]!.push({ type: 'tool_call', name: QUIET_TOOL, arguments: '{}' })
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(unanswered(h.events)).toHaveLength(2))
    expect(unanswered(h.events)[1]).toEqual({ sessionId: 'id1', kind: 'unanswered', turnId: turn && 'turnId' in turn ? turn.turnId : '' })
  })

  it('says "One moment." when the model has not started by STILL_THINKING_MS, once, and never after it has', async () => {
    const h = responder()
    h.r.respond('What changed in the build?')
    await tick()
    h.t.advance(STILL_THINKING_MS)
    expect(h.said).toEqual([STILL_THINKING_LINE])
    h.model.calls[0]!.push({ type: 'text', text: 'Two files changed.' })
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(h.done).toHaveLength(1))
    expect(h.said).toEqual([STILL_THINKING_LINE, 'Two files changed.'])
    // A quick answer gets no filler.
    const q = responder()
    q.r.respond('Hello?')
    await tick()
    q.model.calls[0]!.push({ type: 'text', text: 'Hi.' })
    q.model.calls[0]!.end()
    await vi.waitFor(() => expect(q.done).toHaveLength(1))
    q.t.advance(STILL_THINKING_MS)
    expect(q.said).toEqual(['Hi.'])
  })

  it('moving to another task starts the voice fresh; the task a hand-off just made does not', async () => {
    const h = sessionHarness({}, { loadTaskContext: async () => '' })
    await h.session.start()
    h.session.setTask(null)
    h.stt().say('Make the button blue.')
    await tick()
    h.model.calls[0]!.push({ type: 'text', text: 'Sure.' })
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(h.events.some((e) => e.kind === 'say')).toBe(true))
    // New task's brief → its run: same conversation.
    h.session.setTask('run-a')
    h.stt().say('Is it done yet?')
    await tick()
    expect(h.model.calls[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    h.model.calls[1]!.push({ type: 'text', text: 'Not yet.' })
    h.model.calls[1]!.end()
    await vi.waitFor(() => expect(h.events.filter((e) => e.kind === 'say')).toHaveLength(2))
    // Another task: fresh.
    h.session.setTask('run-b')
    h.stt().say('Is it done yet?')
    await tick()
    expect(h.model.calls[2]!.messages).toHaveLength(1)
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
    expect(h.model.calls).toHaveLength(0)
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
