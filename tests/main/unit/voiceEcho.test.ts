import { describe, expect, it, vi } from 'vitest'
import { ECHO_TAIL_MS, EchoGuard, echoWords } from '@main/voice/echoGuard'
import { VoiceSession } from '@main/voice/session'
import { openFixtureStt, openFixtureTts, type FixtureSttSession } from '@main/voice/providers/fixture'
import { DEFAULT_VOICE_SETTINGS, type VoiceEvent } from '@shared/ipc/schemas/voice'
import { nextVoiceState } from '@shared/voiceSession'
import type { AgentQuestionRequest } from '@shared/ipc'

describe('EchoGuard', () => {
  const said = 'I fixed the login bug and the tests pass now. The details are on screen.'

  it('normalises words for matching', () => {
    expect(echoWords('It’s on screen — the TESTS pass!')).toEqual(['its', 'on', 'screen', 'the', 'tests', 'pass'])
  })

  it('recognises the agent’s words while they play, even transcribed loosely', () => {
    const g = new EchoGuard()
    g.said(said, 0)
    g.setPlaying(true, 100)
    expect(g.isEcho('I fixed the log in bug and the tests pass', 2000)).toBe(true)
    expect(g.isEcho('fixed the login bug', 2000)).toBe(true)
  })

  it('lets your own words through, including ones that share a few of the agent’s', () => {
    const g = new EchoGuard()
    g.said(said, 0)
    g.setPlaying(true, 100)
    expect(g.isEcho('wait, use the other login provider instead', 2000)).toBe(false)
    expect(g.isEcho('run the tests again', 2000)).toBe(false)
  })

  it('counts for a short tail after the audio stops, then forgets', () => {
    const g = new EchoGuard()
    g.said(said, 0)
    g.setPlaying(true, 100)
    g.setPlaying(false, 3000)
    expect(g.isEcho('the tests pass now', 3000 + ECHO_TAIL_MS - 1)).toBe(true)
    expect(g.isEcho('the tests pass now', 3000 + ECHO_TAIL_MS + 1)).toBe(false)
  })

  it('a word or two is an echo only while audio plays, as an exact run', () => {
    const g = new EchoGuard()
    g.said('Keep the old API? Say yes or no.', 0)
    g.setPlaying(true, 10)
    expect(g.isEcho('yes or', 500)).toBe(true)
    expect(g.isEcho('no yes', 500)).toBe(false)
    g.setPlaying(false, 1000)
    // Your answer right after the question is yours.
    expect(g.isEcho('yes', 1200)).toBe(false)
  })

  it('starts a fresh memory for the next stretch of speech', () => {
    const g = new EchoGuard()
    g.said(said, 0)
    g.setPlaying(true, 0)
    g.setPlaying(false, 100)
    g.said('Running the tests.', 100 + ECHO_TAIL_MS + 10)
    g.setPlaying(true, 100 + ECHO_TAIL_MS + 20)
    expect(g.isEcho('I fixed the login bug and the tests pass', 100 + ECHO_TAIL_MS + 30)).toBe(false)
  })
})

describe('false start returns to the agent’s work', () => {
  it('goes back to working when a run is active, else listening', () => {
    expect(nextVoiceState('hearing', { type: 'false_start', runActive: true })).toBe('working')
    expect(nextVoiceState('hearing', { type: 'false_start' })).toBe('listening')
  })
})

describe('echo in a live session', () => {
  function harness() {
    let clock = 0
    const events: VoiceEvent[] = []
    const stt: FixtureSttSession[] = []
    let watcher: { asked: (r: AgentQuestionRequest) => void; settled: (id: string, run: string) => void } | null = null
    const resolveQuestion = vi.fn(() => true)
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
      openTts: (contextId) =>
        openFixtureTts({
          apiKey: '',
          model: '',
          voiceId: '',
          speed: 1,
          contextId,
          signal: new AbortController().signal,
          onAudio: () => {},
          onError: () => {}
        }),
      tapRun: () => () => {},
      watchQuestions: (w) => {
        watcher = w
        return () => {
          watcher = null
        }
      },
      resolveQuestion,
      now: () => clock,
      setTimer: () => null,
      clearTimer: () => {},
      newId: () => `id${++n}`
    })
    return {
      session,
      events,
      stt: () => stt.at(-1)!,
      ask: (r: AgentQuestionRequest) => watcher!.asked(r),
      resolveQuestion,
      tick: (ms: number) => {
        clock += ms
      },
      turns: () => events.filter((e) => e.kind === 'turn'),
      partials: () => events.filter((e) => e.kind === 'partial'),
      lastSay: () => [...events].reverse().find((e) => e.kind === 'say') as Extract<VoiceEvent, { kind: 'say' }>
    }
  }

  const question: AgentQuestionRequest = {
    requestId: 'qr1',
    runId: 'run1',
    toolCallId: 't1',
    questions: [{ id: 'q1', prompt: 'Which database should I use?', type: 'single', options: ['Postgres', 'SQLite', 'MySQL'] }]
  }

  it('the agent’s own voice coming back is neither a caption nor a message', async () => {
    const h = harness()
    await h.session.start()
    h.session.follow('run1')
    h.ask(question)
    h.session.playback(h.lastSay().contextId, 'started')
    h.tick(1500)
    h.stt().say('which database should I use postgres sqlite or mysql')
    expect(h.turns()).toHaveLength(0)
    expect(h.partials()).toHaveLength(0)
    expect(h.resolveQuestion).not.toHaveBeenCalled()
  })

  it('your answer after the agent finishes still counts', async () => {
    const h = harness()
    await h.session.start()
    h.session.follow('run1')
    h.ask(question)
    const id = h.lastSay().contextId
    h.session.playback(id, 'started')
    h.tick(2000)
    h.session.playback(id, 'drained')
    h.tick(400)
    h.stt().say('SQLite')
    expect(h.resolveQuestion).toHaveBeenCalledWith(expect.objectContaining({ answers: [{ questionId: 'q1', values: ['SQLite'] }] }))
  })
})

describe('the engine report names who speaks too', () => {
  it('reports no speaking provider when none has a key', async () => {
    const events: VoiceEvent[] = []
    const session = new VoiceSession({
      emit: (e) => events.push(e),
      settings: () => ({ ...DEFAULT_VOICE_SETTINGS, ttsProvider: 'elevenlabs' }),
      keys: () => ({ voice: { deepgram: true }, chat: { openai: true } }),
      readKey: () => 'k',
      sttProvider: (id) => ({ id, open: (o) => openFixtureStt(o) }),
      openTts: () => null,
      setTimer: () => null,
      clearTimer: () => {}
    })
    await session.start()
    // ElevenLabs was picked but has no key; OpenAI (the chat key) speaks instead.
    expect(events.find((e) => e.kind === 'engine')).toMatchObject({ stt: 'deepgram', tts: 'openai', ttsFellBackFrom: 'elevenlabs' })
  })
})

describe('how long the agent has been quiet (for the listener’s lead-in)', () => {
  it('is 0 while it plays, the time since it stopped after, and unbounded before it ever spoke', () => {
    const g = new EchoGuard()
    expect(g.msSinceVoice(5000)).toBe(Number.POSITIVE_INFINITY)
    g.setPlaying(true, 5000)
    expect(g.msSinceVoice(6000)).toBe(0)
    g.setPlaying(false, 6000)
    expect(g.msSinceVoice(6800)).toBe(800)
    g.reset()
    expect(g.msSinceVoice(7000)).toBe(Number.POSITIVE_INFINITY)
  })
})
