import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceSession } from '@main/voice/session'
import { openFixtureStt, openFixtureTts, type FixtureSttSession } from '@main/voice/providers/fixture'
import { answerableByVoice, describeQuestion, questionAnswer } from '@main/voice/questionByVoice'
import {
  askQuestionThroughRenderer,
  dismissPendingQuestions,
  registerQuestionSender,
  resetAgentQuestionForTests,
  resolveAgentQuestion,
  watchAgentQuestions
} from '@main/agent/agentQuestion'
import { DEFAULT_VOICE_SETTINGS, type VoiceEvent } from '@shared/ipc/schemas/voice'
import type { AgentEvent, AgentQuestionItem, AgentQuestionRequest } from '@shared/ipc'

const R = 'run1'

const single = (over: Partial<AgentQuestionItem> = {}): AgentQuestionItem => ({
  id: 'q1',
  prompt: 'Which database should I use?',
  type: 'single',
  options: ['Postgres', 'SQLite', 'MySQL'],
  ...over
})

const request = (questions: AgentQuestionItem[], over: Partial<AgentQuestionRequest> = {}): AgentQuestionRequest => ({
  requestId: 'qr1',
  runId: R,
  toolCallId: 't1',
  questions,
  ...over
})

describe('reading a question out', () => {
  it('asks a single choice with its options', () => {
    expect(describeQuestion(request([single()]))).toBe('Which database should I use? Postgres, SQLite or MySQL.')
  })

  it('asks yes or no for a boolean, and leaves long option lists on screen', () => {
    expect(describeQuestion(request([{ id: 'b', prompt: 'Keep the old API', type: 'boolean' }]))).toBe(
      'Keep the old API? Yes or no?'
    )
    const many = single({ options: ['a', 'b', 'c', 'd', 'e'] })
    expect(describeQuestion(request([many]))).toBe('Which database should I use? The options are on screen.')
  })

  it('points a form with several questions at the screen', () => {
    const req = request([single(), single({ id: 'q2' })])
    expect(describeQuestion(req)).toBe('It has 2 questions for you. They’re on screen, or just tell me what you want.')
    expect(answerableByVoice(req)).toBe(false)
  })

  it('makes code in the prompt speakable', () => {
    const text = describeQuestion(request([{ id: 't', prompt: 'Rename `runAgentLoop` to what?', type: 'text' }]))
    expect(text).toBe('Rename run agent loop to what?')
  })
})

describe('a spoken reply as an answer', () => {
  it('matches an option by name, case and punctuation aside', () => {
    expect(questionAnswer(single(), 'sqlite.')).toEqual(['SQLite'])
    expect(questionAnswer(single(), "let's go with postgres")).toEqual(['Postgres'])
  })

  it('matches by position', () => {
    expect(questionAnswer(single(), 'the second one')).toEqual(['SQLite'])
    expect(questionAnswer(single(), 'option 3')).toEqual(['MySQL'])
    expect(questionAnswer(single(), 'the last one')).toEqual(['MySQL'])
    expect(questionAnswer(single(), 'the fifth one')).toBeNull()
  })

  it('leaves an unclear single choice to the agent', () => {
    expect(questionAnswer(single(), 'postgres or maybe sqlite')).toBeNull()
    expect(questionAnswer(single(), 'whatever is fastest')).toBeNull()
  })

  it('takes several options for a multi choice', () => {
    const item = single({ type: 'multi', options: ['lint', 'tests', 'build'] })
    expect(questionAnswer(item, 'tests and build please')).toEqual(['tests', 'build'])
  })

  it('takes a short free-form pick only when the question allows one', () => {
    const item = single({ allowCustom: true })
    expect(questionAnswer(item, 'DuckDB')).toEqual(['DuckDB'])
    expect(questionAnswer(item, 'none of those because we already have a hosted cluster we pay for')).toBeNull()
  })

  it('answers yes/no and free text', () => {
    const yesNo: AgentQuestionItem = { id: 'b', prompt: 'Keep it?', type: 'boolean' }
    expect(questionAnswer(yesNo, 'yeah')).toEqual(['Yes'])
    expect(questionAnswer(yesNo, 'nope')).toEqual(['No'])
    expect(questionAnswer(yesNo, 'keep it but rename it')).toBeNull()
    expect(questionAnswer({ id: 't', prompt: 'Name?', type: 'text' }, 'call it loader ')).toEqual(['call it loader'])
  })
})

describe('questions in a live session', () => {
  /** `timers`: collect what the session schedules, for the test to run; otherwise nothing scheduled ever runs. */
  function harness(opts: { timers?: Array<() => void> } = {}) {
    const events: VoiceEvent[] = []
    const said: string[] = []
    const stt: FixtureSttSession[] = []
    let watcher: { asked: (r: AgentQuestionRequest) => void; settled: (id: string, run: string) => void } | null = null
    const resolveQuestion = vi.fn(() => true)
    let tap: ((e: AgentEvent) => void) | null = null
    let n = 0
    const session = new VoiceSession({
      emit: (e) => {
        events.push(e)
        if (e.kind === 'say') said.push(e.text)
      },
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
      tapRun: (_runId, fn) => {
        tap = fn
        return () => {
          tap = null
        }
      },
      watchQuestions: (w) => {
        watcher = w
        return () => {
          watcher = null
        }
      },
      resolveQuestion,
      setTimer: opts.timers ? (fn) => opts.timers!.push(fn) : () => null,
      clearTimer: () => {},
      newId: () => `id${++n}`
    })
    const turns = () => events.filter((e) => e.kind === 'turn')
    return { session, said, stt: () => stt.at(-1)!, ask: (r: AgentQuestionRequest) => watcher!.asked(r), watcher: () => watcher, resolveQuestion, turns, events, tap: (e: AgentEvent) => tap!(e) }
  }

  it('the view hears the run’s steps and the question it waits on, a few at a time (§25)', async () => {
    const timers: Array<() => void> = []
    const h = harness({ timers })
    await h.session.start()
    h.session.follow(R)
    h.tap({ type: 'status', runId: R, status: 'running' } as AgentEvent)
    h.tap({ type: 'tool_start', runId: R, toolCallId: 'a', name: 'read', summary: 'db.ts' } as AgentEvent)
    h.ask(request([single()]))
    for (const fn of timers.splice(0)) fn()
    const works = h.events.filter((e) => e.kind === 'work')
    // Three changes, one event: steps can come many to a second.
    expect(works).toHaveLength(1)
    expect(works[0]).toMatchObject({
      work: {
        runId: R,
        state: 'needs',
        stepCount: 1,
        steps: [{ id: 'a', tool: 'read', summary: 'db.ts', state: 'running' }],
        ask: { kind: 'question', requestId: 'qr1', questionId: 'q1', options: ['Postgres', 'SQLite', 'MySQL'] }
      }
    })
    // Most run events (streamed text, usage) change nothing the view shows: no event for them.
    h.tap({ type: 'text_delta', runId: R, delta: 'Thinking it over…' } as unknown as AgentEvent)
    for (const fn of timers.splice(0)) fn()
    expect(h.events.filter((e) => e.kind === 'work')).toHaveLength(1)
    h.tap({ type: 'tool_result', runId: R, toolCallId: 'a', name: 'read', summary: '', ok: true } as AgentEvent)
    for (const fn of timers.splice(0)) fn()
    expect(h.events.filter((e) => e.kind === 'work').at(-1)).toMatchObject({ work: { steps: [{ id: 'a', state: 'done' }] } })
  })

  it('reads the question out and a clear pick answers it without a message', async () => {
    const h = harness()
    await h.session.start()
    h.session.follow(R)
    h.ask(request([single()]))
    expect(h.session.state).toBe('waiting_on_you')
    expect(h.said.at(-1)).toBe('Which database should I use? Postgres, SQLite or MySQL.')
    h.stt().say('SQLite')
    expect(h.resolveQuestion).toHaveBeenCalledWith({
      requestId: 'qr1',
      runId: R,
      answers: [{ questionId: 'q1', values: ['SQLite'] }]
    })
    expect(h.turns()).toHaveLength(0)
    expect(h.said.at(-1)).toBe('Got it.')
  })

  it('an unclear reply, a stop phrase, or a multi-question form goes on as a message', async () => {
    const h = harness()
    await h.session.start()
    h.session.follow(R)
    h.ask(request([single()]))
    h.stt().say('whichever is simplest')
    h.stt().say('stop')
    expect(h.resolveQuestion).not.toHaveBeenCalled()
    expect(h.turns().map((t) => t.kind === 'turn' && t.stop)).toEqual([false, true])
    h.ask(request([single(), single({ id: 'q2' })], { requestId: 'qr2' }))
    h.stt().say('postgres')
    expect(h.resolveQuestion).not.toHaveBeenCalled()
  })

  it('stays on "needs you" after a reply while the question still waits', async () => {
    const h = harness()
    await h.session.start()
    h.session.follow(R)
    h.tap({ type: 'status', runId: R, status: 'running' } as AgentEvent)
    h.ask(request([single()]))
    h.stt().say('how is it going')
    expect(h.turns()).toHaveLength(1)
    // The agent can't answer while it waits: you hear what it waits on, and those words play out.
    await vi.waitFor(() => expect(h.said.at(-1)).toBe('I still need your answer first. Which database should I use? Postgres, SQLite or MySQL.'))
    const say = h.events.findLast((e) => e.kind === 'say')!
    const contextId = say.kind === 'say' ? say.contextId : ''
    h.session.playback(contextId, 'started')
    expect(h.session.state).toBe('speaking')
    h.session.playback(contextId, 'drained')
    // Still blocked on you, so not "working".
    expect(h.session.state).toBe('waiting_on_you')
    h.watcher()!.settled('qr1', R)
    expect(h.session.state).toBe('thinking')
  })

  it('ignores other runs, and an answer on the card clears the wait', async () => {
    const h = harness()
    await h.session.start()
    h.session.follow(R)
    h.ask(request([single()], { runId: 'other' }))
    expect(h.session.state).toBe('listening')
    h.ask(request([single()]))
    h.watcher()!.settled('qr1', R)
    expect(h.session.state).toBe('thinking')
    await h.session.stop()
    expect(h.watcher()).toBeNull()
  })
})

describe('question watchers', () => {
  afterEach(() => resetAgentQuestionForTests())

  it('are told when a question is asked and when it settles, however it settles', async () => {
    const asked: string[] = []
    const settled: string[] = []
    watchAgentQuestions({ asked: (r) => asked.push(r.requestId), settled: (id) => settled.push(id) })
    registerQuestionSender(R, () => {})
    const ctrl = new AbortController()
    const answered = askQuestionThroughRenderer(request([single()]), ctrl.signal)
    expect(asked).toEqual(['qr1'])
    resolveAgentQuestion({ requestId: 'qr1', runId: R, answers: [{ questionId: 'q1', values: ['MySQL'] }] })
    await expect(answered).resolves.toEqual([{ questionId: 'q1', values: ['MySQL'] }])
    const dismissed = askQuestionThroughRenderer(request([single()], { requestId: 'qr2' }), ctrl.signal)
    dismissPendingQuestions(R)
    await expect(dismissed).rejects.toThrow()
    expect(settled).toEqual(['qr1', 'qr2'])
  })
})
