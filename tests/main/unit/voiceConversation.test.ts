import { describe, expect, it, vi } from 'vitest'
import { CUE_DELAY_MS, RUN_FAILED_LINE, ReplySpeaker, cueForTool, type ReplySpeakerDeps } from '@main/voice/replySpeaker'
import { VoiceSession, type VoiceSessionDeps } from '@main/voice/session'
import { openFixtureStt, openFixtureTts, type FixtureSttSession, type FixtureTtsStream } from '@main/voice/providers/fixture'
import { addRunEventTap, tapRunEvent } from '@main/agent/runEventTap'
import { isVoiceReplyActive, setVoiceReplyWorkspace } from '@main/voice/voiceReply'
import { formatVoiceReply } from '@main/agent/context/userRules'
import { DEFAULT_VOICE_SETTINGS, type VoiceEvent, type VoiceSettings } from '@shared/ipc/schemas/voice'
import type { AgentEvent } from '@shared/ipc'

const R = 'run1'
const delta = (text: string): AgentEvent => ({ type: 'text_delta', runId: R, text }) as AgentEvent
const final = (content: string): AgentEvent => ({ type: 'assistant_message', runId: R, content }) as AgentEvent
const narration = (content: string): AgentEvent =>
  ({ type: 'assistant_message', runId: R, content, toolCalls: [{ id: 't', name: 'x', arguments: '{}' }] }) as AgentEvent
const status = (s: 'running' | 'done' | 'error' | 'cancelled'): AgentEvent => ({ type: 'status', runId: R, status: s }) as AgentEvent
const toolStart = (id: string, name: string, summary = ''): AgentEvent =>
  ({ type: 'tool_start', runId: R, toolCallId: id, name, summary }) as AgentEvent
const toolResult = (id: string): AgentEvent =>
  ({ type: 'tool_result', runId: R, toolCallId: id, name: 'x', summary: '', ok: true }) as AgentEvent

function speakerHarness(over: Partial<ReplySpeakerDeps> = {}) {
  const streams: FixtureTtsStream[] = []
  const said: string[] = []
  const timers: Array<{ fn: () => void; ms: number }> = []
  let clock = 0
  let n = 0
  const deps: ReplySpeakerDeps = {
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
      streams.push(s)
      return s
    },
    say: (_c, text) => said.push(text),
    onToolStart: vi.fn(),
    onRunEnd: vi.fn(),
    speakProgress: () => true,
    newId: () => `c${++n}`,
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, ms }
      timers.push(t)
      return t
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number])
      if (i >= 0) timers.splice(i, 1)
    },
    ...over
  }
  const speaker = new ReplySpeaker(deps)
  return {
    speaker,
    deps,
    streams,
    said,
    timers,
    tick: (ms: number) => {
      clock += ms
      for (const t of timers.splice(0)) t.fn()
    }
  }
}

describe('ReplySpeaker', () => {
  it('speaks the <spoken> block as it streams, sentence by sentence, and not the written part', () => {
    const h = speakerHarness()
    h.speaker.beginTurn()
    // A word split across deltas ("pa" + "ss") must come out whole.
    for (const piece of ['<spo', 'ken>I fixed the race. ', 'Tests pa', 'ss now.</spo', 'ken>\n\n## Details\nlong text'])
      h.speaker.handle(delta(piece))
    expect(h.said).toEqual(['I fixed the race.'])
    h.speaker.handle(final('<spoken>I fixed the race. Tests pass now.</spoken>\n\n## Details\nlong text'))
    expect(h.said).toEqual(['I fixed the race.', 'Tests pass now.'])
    expect(h.streams).toHaveLength(1)
    expect(h.streams[0]!.spoken).toEqual(['I fixed the race.', 'Tests pass now.'])
  })

  it('falls back to a short summary when the answer has no <spoken> block', () => {
    const h = speakerHarness()
    h.speaker.beginTurn()
    h.speaker.handle(delta('All green. Nothing else changed.'))
    h.speaker.handle(final('All green. Nothing else changed.'))
    expect(h.said.join(' ')).toBe('All green. Nothing else changed.')
  })

  it('stays quiet through narration between tool calls', () => {
    const h = speakerHarness()
    h.speaker.beginTurn()
    h.speaker.handle(delta('Let me look at the loop first.'))
    h.speaker.handle(narration('Let me look at the loop first.'))
    expect(h.said).toEqual([])
  })

  it('says one short cue for a tool still running after the delay, and none for quick ones', () => {
    const h = speakerHarness()
    h.speaker.beginTurn()
    h.speaker.handle(toolStart('a', 'run_terminal', 'pnpm test'))
    h.speaker.handle(toolResult('a'))
    h.tick(CUE_DELAY_MS)
    expect(h.said).toEqual([])
    h.speaker.handle(toolStart('b', 'run_terminal', 'pnpm test'))
    h.tick(CUE_DELAY_MS)
    expect(h.said).toEqual(['Running the tests.'])
    h.speaker.handle(toolStart('c', 'run_terminal', 'pnpm test'))
    h.tick(CUE_DELAY_MS)
    expect(h.said).toEqual(['Running the tests.'])
    expect(h.deps.onToolStart).toHaveBeenCalledTimes(3)
  })

  it('no cues when spoken progress is off', () => {
    const h = speakerHarness({ speakProgress: () => false })
    h.speaker.beginTurn()
    h.speaker.handle(toolStart('a', 'grep', 'TODO'))
    expect(h.timers).toHaveLength(0)
  })

  it('goes quiet on barge-in until the next turn', () => {
    const h = speakerHarness()
    h.speaker.beginTurn()
    h.speaker.handle(delta('<spoken>First sentence here. '))
    const flushed = h.speaker.interrupt()
    expect(flushed).toBe('c1')
    expect(h.streams[0]!.cancelled).toBe(true)
    h.speaker.handle(delta('More words. </spoken>'))
    expect(h.said).toEqual(['First sentence here.'])
    h.speaker.beginTurn()
    h.speaker.handle(delta('<spoken>Okay, switching. '))
    expect(h.said.at(-1)).toBe('Okay, switching.')
  })

  it('says the run failed, and reports the end', () => {
    const h = speakerHarness()
    h.speaker.beginTurn()
    h.speaker.handle(status('error'))
    expect(h.said).toEqual([RUN_FAILED_LINE])
    expect(h.deps.onRunEnd).toHaveBeenCalled()
    expect(h.speaker.runActive).toBe(false)
  })

  it('redacts secrets before they reach the speech vendor', () => {
    const h = speakerHarness()
    h.speaker.beginTurn()
    h.speaker.handle(delta('<spoken>Use the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 now. </spoken>'))
    expect(h.said.join(' ')).not.toContain('abcdefghijklmnopqrstuvwxyz')
  })

  it('maps tools to cues', () => {
    expect(cueForTool('run_terminal', 'pnpm vitest run')).toBe('Running the tests.')
    expect(cueForTool('edit_file', 'src/a.ts')).toBe('Making the change.')
    expect(cueForTool('grep', 'TODO')).toBe('Looking through the code.')
    expect(cueForTool('ask_question', '')).toBeNull()
  })
})

describe('run event tap', () => {
  it('delivers a run’s events to its listeners only, and survives a throwing one', () => {
    const got: string[] = []
    const off = addRunEventTap(R, (e) => got.push(e.type))
    const offBad = addRunEventTap(R, () => {
      throw new Error('boom')
    })
    tapRunEvent(delta('x'))
    tapRunEvent({ ...delta('y'), runId: 'other' } as AgentEvent)
    off()
    offBad()
    tapRunEvent(delta('z'))
    expect(got).toEqual(['text_delta'])
  })
})

describe('voice_reply prompt section', () => {
  it('is on only for workspaces with an open session', () => {
    expect(isVoiceReplyActive(['/repo'])).toBe(false)
    setVoiceReplyWorkspace('s1', '/Repo/')
    expect(isVoiceReplyActive([null, '/repo'])).toBe(true)
    expect(isVoiceReplyActive(['/other'])).toBe(false)
    setVoiceReplyWorkspace('s1', null)
    expect(isVoiceReplyActive(['/repo'])).toBe(false)
  })

  it('asks for a <spoken> block and is stable text', () => {
    expect(formatVoiceReply(false)).toBe('')
    const section = formatVoiceReply(true)
    expect(section).toContain('<spoken>')
    expect(section).toContain('voice_reply')
    expect(formatVoiceReply(true)).toBe(section)
  })
})

describe('VoiceSession conversation', () => {
  function sessionHarness(over: Partial<VoiceSettings> = {}) {
    const events: VoiceEvent[] = []
    const stt: FixtureSttSession[] = []
    const tts: FixtureTtsStream[] = []
    const taps = new Map<string, (e: AgentEvent) => void>()
    const settings: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS, ...over }
    let n = 0
    const deps: VoiceSessionDeps = {
      emit: (e) => events.push(e),
      settings: () => settings,
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
      tapRun: (runId, fn) => {
        taps.set(runId, fn)
        return () => taps.delete(runId)
      },
      setTimer: () => null,
      clearTimer: () => {},
      newId: () => `id${++n}`
    }
    const session = new VoiceSession(deps)
    return { session, events, stt: () => stt.at(-1)!, tts, run: (e: AgentEvent) => taps.get(R)?.(e), taps }
  }

  it('a whole exchange: turn → thinking → speaking → listening', async () => {
    const h = sessionHarness()
    await h.session.start()
    h.stt().say('what failed?')
    h.session.follow(R)
    h.run(status('running'))
    h.run(delta('<spoken>The lint step failed. </spoken>'))
    h.run(final('<spoken>The lint step failed. </spoken> details'))
    const say = h.events.find((e) => e.kind === 'say')
    expect(say).toMatchObject({ text: 'The lint step failed.' })
    const contextId = (say as { contextId: string }).contextId
    h.session.playback(contextId, 'started')
    expect(h.session.state).toBe('speaking')
    h.run(status('done'))
    expect(h.session.state).toBe('speaking')
    h.session.playback(contextId, 'drained')
    expect(h.session.state).toBe('listening')
  })

  it('tool work shows as working, and the end with nothing said returns to listening', async () => {
    const h = sessionHarness()
    await h.session.start()
    h.stt().say('run the tests')
    h.session.follow(R)
    h.run(status('running'))
    h.run(toolStart('a', 'run_terminal', 'pnpm test'))
    expect(h.session.state).toBe('working')
    h.run(status('done'))
    expect(h.session.state).toBe('listening')
  })

  it('barge-in flushes what is playing and stops the speech stream', async () => {
    const h = sessionHarness()
    await h.session.start()
    h.stt().say('explain it')
    h.session.follow(R)
    h.run(delta('<spoken>Here is a long answer. It keeps going. '))
    const contextId = (h.events.find((e) => e.kind === 'say') as { contextId: string }).contextId
    h.session.playback(contextId, 'started')
    h.stt().say('wait', false)
    expect(h.session.state).toBe('hearing')
    expect(h.events).toContainEqual(expect.objectContaining({ kind: 'flush', contextId }))
    expect(h.tts[0]!.cancelled).toBe(true)
  })

  it('stop drops the run tap', async () => {
    const h = sessionHarness()
    await h.session.start()
    h.session.follow(R)
    expect(h.taps.size).toBe(1)
    await h.session.stop()
    expect(h.taps.size).toBe(0)
  })
})

describe('approvals by voice', () => {
  function approvalHarness(over: Partial<VoiceSettings> = {}) {
    const events: VoiceEvent[] = []
    const stt: FixtureSttSession[] = []
    const said: string[] = []
    let watcher: { asked: (r: never) => void; settled: (id: string, run: string) => void } | null = null
    const resolveApproval = vi.fn(() => true)
    const settings: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS, ...over }
    let n = 0
    const session = new VoiceSession({
      emit: (e) => {
        events.push(e)
        if (e.kind === 'say') said.push(e.text)
      },
      settings: () => settings,
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
      watchApprovals: (w) => {
        watcher = w as never
        return () => {
          watcher = null
        }
      },
      resolveApproval,
      setTimer: () => null,
      clearTimer: () => {},
      newId: () => `id${++n}`
    })
    const ask = (over2: Record<string, unknown> = {}) =>
      watcher!.asked({
        requestId: 'a1',
        runId: R,
        toolCallId: 't1',
        name: 'run_terminal',
        summary: 'pnpm test',
        argsPreview: '{}',
        mutating: true,
        ...over2
      } as never)
    return { session, events, said, stt: () => stt.at(-1)!, ask, resolveApproval, watcher: () => watcher }
  }

  it('reads the approval out and a spoken yes allows it once, without sending a message', async () => {
    const h = approvalHarness()
    await h.session.start()
    h.stt().say('run the tests')
    h.session.follow(R)
    h.ask()
    expect(h.session.state).toBe('waiting_on_you')
    expect(h.said.at(-1)).toBe('It wants to run pnpm test. Say yes or no.')
    const turnsBefore = h.events.filter((e) => e.kind === 'turn').length
    h.stt().say('Yes.')
    expect(h.resolveApproval).toHaveBeenCalledWith({ requestId: 'a1', runId: R, decision: 'once' })
    expect(h.events.filter((e) => e.kind === 'turn')).toHaveLength(turnsBefore)
    expect(h.said.at(-1)).toBe('Allowed.')
  })

  it('no denies; anything else is a message to the agent', async () => {
    const h = approvalHarness()
    await h.session.start()
    h.session.follow(R)
    h.ask()
    h.stt().say('no thanks')
    expect(h.resolveApproval).toHaveBeenCalledWith(expect.objectContaining({ decision: 'deny' }))
    h.ask({ requestId: 'a2' })
    h.resolveApproval.mockClear()
    h.stt().say('yes but use the other script')
    expect(h.resolveApproval).not.toHaveBeenCalled()
    expect(h.events.at(-1)).toMatchObject({ kind: 'turn', text: 'yes but use the other script' })
  })

  it('a risky action is never approved by voice', async () => {
    const h = approvalHarness()
    await h.session.start()
    h.session.follow(R)
    h.ask({ danger: 'deletes files outside the workspace' })
    expect(h.said.at(-1)).toContain('could be risky. Approve or deny it on screen.')
    h.stt().say('yes')
    expect(h.resolveApproval).not.toHaveBeenCalled()
  })

  it('respects Approve by voice being off, and ignores other runs', async () => {
    const h = approvalHarness({ approveByVoice: false })
    await h.session.start()
    h.session.follow(R)
    h.ask({ runId: 'someone-else' })
    expect(h.session.state).toBe('listening')
    h.ask()
    expect(h.said.at(-1)).toContain('Approve or deny it on screen.')
    h.stt().say('yes')
    expect(h.resolveApproval).not.toHaveBeenCalled()
  })

  it('a click on the card clears the wait', async () => {
    const h = approvalHarness()
    await h.session.start()
    h.session.follow(R)
    h.ask()
    h.watcher()!.settled('a1', R)
    expect(h.session.state).toBe('thinking')
  })

  it('stop stops watching', async () => {
    const h = approvalHarness()
    await h.session.start()
    await h.session.stop()
    expect(h.watcher()).toBeNull()
  })
})

describe('approval wording and answers', () => {
  it('describes approvals in a few words', async () => {
    const { describeApproval } = await import('@main/voice/session')
    expect(describeApproval({ name: 'edit_file', summary: 'src/main/loop.ts' })).toBe('change loop')
    expect(describeApproval({ name: 'web_fetch', summary: '' })).toBe('open a web page')
  })

  it('only takes a whole-utterance yes or no', async () => {
    const { approvalAnswer } = await import('@main/voice/speechText')
    expect(approvalAnswer('Yes!')).toBe('once')
    expect(approvalAnswer('go ahead')).toBe('once')
    expect(approvalAnswer("Don't")).toBe('deny')
    expect(approvalAnswer('yes, and also run lint')).toBeNull()
  })
})
