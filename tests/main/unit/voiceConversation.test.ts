import { describe, expect, it, vi } from 'vitest'
import { CUE_DELAY_MS, RUN_FAILED_LINE, ReplySpeaker, cueForTool, runFailedLine, type ReplySpeakerDeps } from '@main/voice/replySpeaker'
import { HAND_OFF_FAILED_LINE, VoiceSession, emptyProgress, trackProgress, type VoiceSessionDeps } from '@main/voice/session'
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

  it('falls back to a short summary when the answer has no <spoken> block and no voice can report it', () => {
    const h = speakerHarness()
    h.speaker.beginTurn()
    h.speaker.handle(delta('All green. Nothing else changed.'))
    h.speaker.handle(final('All green. Nothing else changed.'))
    // Settled when the run ends: a check after the answer can still send the agent back to work.
    expect(h.said).toEqual([])
    h.speaker.handle(status('done'))
    expect(h.said.join(' ')).toBe('All green. Nothing else changed.')
  })

  it('an answer with no <spoken> block is reported by the voice, not read off a table (B7)', () => {
    const onResult = vi.fn()
    const reportResult = vi.fn(() => true)
    const h = speakerHarness({ onResult, reportResult })
    h.speaker.beginTurn()
    const table = ['**Sessions**', '| Session | Started |', '| --- | --- |', '| This chat | today |'].join('\n')
    h.speaker.handle(delta(table))
    h.speaker.handle(final(table))
    h.speaker.handle(status('done'))
    expect(onResult).toHaveBeenCalledWith(table)
    expect(reportResult).toHaveBeenCalledTimes(1)
    expect(h.said).toEqual([])
  })

  it('the final answer reaches the voice even when it was silenced, and a spoken one is not reported twice (B5)', () => {
    const onResult = vi.fn()
    const reportResult = vi.fn(() => true)
    const h = speakerHarness({ onResult, reportResult })
    h.speaker.beginTurn()
    h.speaker.interrupt()
    h.speaker.handle(final('Six sessions ran.'))
    h.speaker.handle(status('done'))
    expect(onResult).toHaveBeenCalledWith('Six sessions ran.')
    expect(reportResult).not.toHaveBeenCalled()
    const spoken = speakerHarness({ onResult, reportResult })
    spoken.speaker.beginTurn()
    spoken.speaker.handle(delta('<spoken>Done. </spoken> More.'))
    spoken.speaker.handle(final('<spoken>Done. </spoken> More.'))
    spoken.speaker.handle(status('done'))
    expect(reportResult).not.toHaveBeenCalled()
    expect(spoken.said).toEqual(['Done.'])
  })

  it('only the last answer of a run is settled: a check that sends the agent back to work comes first', () => {
    const onResult = vi.fn()
    const h = speakerHarness({ onResult })
    h.speaker.beginTurn()
    h.speaker.handle(final('Done, I think.'))
    h.speaker.handle(toolStart('v', 'run_terminal', 'pnpm test'))
    h.speaker.handle(final('Verified: all tests pass.'))
    h.speaker.handle(status('done'))
    expect(onResult.mock.calls).toEqual([['Verified: all tests pass.']])
  })

  it('says one answer per run: the one the verification gate sent back is shown and kept, not said again', () => {
    const onResult = vi.fn()
    const reportResult = vi.fn(() => true)
    const h = speakerHarness({ onResult, reportResult })
    h.speaker.beginTurn()
    h.speaker.handle(status('running'))
    const first = '<spoken>I renamed the setting. </spoken> Details.'
    h.speaker.handle(delta(first))
    h.speaker.handle(final(first))
    // The gate's nudge: a check, then the answer written again.
    h.speaker.handle(toolStart('v', 'run_tests', 'voiceWork'))
    h.speaker.handle(toolResult('v'))
    const second = '<spoken>I renamed the setting, and the tests pass. </spoken> Details.'
    h.speaker.handle(delta(second))
    h.speaker.handle(final(second))
    h.speaker.handle(status('done'))
    expect(h.said).toEqual(['I renamed the setting.'])
    expect(reportResult).not.toHaveBeenCalled()
    expect(onResult.mock.calls).toEqual([[second]])
  })

  it('an answer with no <spoken> block, sent back by the gate, is reported once, from the last answer', () => {
    const onResult = vi.fn()
    const reportResult = vi.fn(() => true)
    const h = speakerHarness({ onResult, reportResult })
    h.speaker.beginTurn()
    h.speaker.handle(final('Renamed it.'))
    h.speaker.handle(toolStart('v', 'read_file', 'settings.ts'))
    h.speaker.handle(toolResult('v'))
    h.speaker.handle(final('Renamed it; the file reads back as expected.'))
    h.speaker.handle(status('done'))
    expect(reportResult).toHaveBeenCalledTimes(1)
    expect(onResult.mock.calls).toEqual([['Renamed it; the file reads back as expected.']])
    expect(h.said).toEqual([])
  })

  it('a follow-up applied mid-run, or the next invoke, is a new turn whose answer is said', () => {
    const h = speakerHarness()
    h.speaker.beginTurn()
    h.speaker.handle(final('<spoken>First. </spoken>'))
    h.speaker.handle({ type: 'follow_up_applied', runId: R, ids: ['f'], messages: [{ role: 'user', content: 'and?' }] } as AgentEvent)
    h.speaker.handle(final('<spoken>Second. </spoken>'))
    h.speaker.handle(status('done'))
    // A turn typed in the task: no beginTurn, only the run starting again.
    h.speaker.handle(status('running'))
    h.speaker.handle(final('<spoken>Third. </spoken>'))
    expect(h.said).toEqual(['First.', 'Second.', 'Third.'])
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

  it('no spoken cues when spoken progress is off; a slow step gets the soft sound instead', () => {
    const quietCue = vi.fn()
    const h = speakerHarness({ speakProgress: () => false, quietCue })
    h.speaker.beginTurn()
    h.speaker.handle(toolStart('a', 'grep', 'TODO'))
    h.tick(CUE_DELAY_MS)
    expect(h.said).toEqual([])
    expect(h.streams).toHaveLength(0)
    expect(quietCue).toHaveBeenCalledTimes(1)
    const silent = speakerHarness({ speakProgress: () => false })
    silent.speaker.beginTurn()
    silent.speaker.handle(toolStart('a', 'grep', 'TODO'))
    expect(silent.timers).toHaveLength(0)
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

  it('says why the run failed, from its error code, and keeps the provider’s words for the voice', () => {
    const onRunFailed = vi.fn()
    const h = speakerHarness({ onRunFailed })
    h.speaker.beginTurn()
    h.speaker.handle({
      type: 'error',
      runId: R,
      message: 'Prompt tokens limit exceeded: 133397 > 4780. To increase, visit https://openrouter.ai/settings/credits',
      code: 'PROVIDER_BILLING'
    } as AgentEvent)
    h.speaker.handle(status('error'))
    expect(h.said).toEqual([runFailedLine('PROVIDER_BILLING')])
    expect(h.said[0]).toContain('out of credit')
    expect(onRunFailed).toHaveBeenCalledWith(expect.stringContaining('Prompt tokens limit exceeded'))
  })

  it('forgets an earlier invoke’s error once the run starts again', () => {
    const onRunFailed = vi.fn()
    const h = speakerHarness({ onRunFailed })
    h.speaker.beginTurn()
    h.speaker.handle({ type: 'error', runId: R, message: 'boom', code: 'PROVIDER_AUTH' } as AgentEvent)
    h.speaker.handle(status('running'))
    h.speaker.handle(status('error'))
    expect(h.said).toEqual([RUN_FAILED_LINE])
    expect(onRunFailed).not.toHaveBeenCalled()
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

describe('run progress for the voice (B6)', () => {
  it('counts steps, names the running one, keeps the last narration, and records how it ended', () => {
    let p = trackProgress(emptyProgress(), status('running'), 0)
    p = trackProgress(p, toolStart('a', 'run_terminal', 'git for-each-ref refs/heads'), 1)
    expect(p).toMatchObject({ running: true, steps: 1, current: 'run_terminal: git for-each-ref refs/heads' })
    p = trackProgress(p, toolResult('a'), 2)
    expect(p.current).toBeUndefined()
    p = trackProgress(p, narration('Now the branches.'), 3)
    p = trackProgress(p, toolStart('b', 'grep', 'TODO'), 4)
    p = trackProgress(p, final('All done.'), 5)
    expect(p).toMatchObject({ steps: 2, narration: 'Now the branches.' })
    p = trackProgress(p, status('done'), 9)
    expect(p).toMatchObject({ running: false, steps: 2, ended: { at: 9, outcome: 'done' } })
    expect(p.current).toBeUndefined()
    // A new run starts counting afresh.
    expect(trackProgress(p, status('running'), 10)).toEqual({ running: true, steps: 0 })
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

  it('still announces each spoken piece with captions off: the window plays only what it was told of (A-09)', async () => {
    const h = sessionHarness({ captions: false })
    await h.session.start()
    h.stt().say('what failed?')
    h.session.follow(R)
    h.run(status('running'))
    h.run(delta('<spoken>The lint step failed. </spoken>'))
    h.run(final('<spoken>The lint step failed. </spoken> details'))
    expect(h.events.find((e) => e.kind === 'say')).toMatchObject({ text: 'The lint step failed.' })
  })

  it('a reply that arrives whole, with no deltas, speaks its block and never the tags (A-20)', async () => {
    const h = sessionHarness()
    await h.session.start()
    h.stt().say('what failed?')
    h.session.follow(R)
    h.run(status('running'))
    h.run(final('<spoken>The lint step failed. </spoken> details'))
    const said = h.events.flatMap((e) => (e.kind === 'say' ? [e.text] : []))
    expect(said).toEqual(['The lint step failed.'])
  })

  it('a speaking failure is a note with its reason, once a session (D-40)', async () => {
    const h = sessionHarness()
    let fail: ((code: 'engine_failed', message: string) => void) | null = null
    h.session['deps'].openTts = (contextId, onError) => {
      fail = onError
      return openFixtureTts({ apiKey: '', model: '', voiceId: '', speed: 1, contextId, signal: new AbortController().signal, onAudio: () => {}, onError })
    }
    await h.session.start()
    h.stt().say('what failed?')
    h.session.follow(R)
    h.run(status('running'))
    h.run(final('<spoken>Done. </spoken>'))
    fail!('engine_failed', 'OpenRouter (404): model not found')
    fail!('engine_failed', 'again')
    const errors = h.events.filter((e) => e.kind === 'error')
    expect(errors).toEqual([
      expect.objectContaining({ side: 'speak', code: 'engine_failed', detail: 'OpenRouter (404): model not found' })
    ])
    expect(h.session.state).not.toBe('error')
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

  it('a breath while the agent works doesn’t silence its result (B1)', async () => {
    const h = sessionHarness()
    await h.session.start()
    h.stt().say('list the sessions')
    h.session.follow(R)
    h.run(status('running'))
    h.run(toolStart('a', 'run_terminal', 'git branch'))
    expect(h.session.state).toBe('working')
    // A sound that turns out to be no words, several times over.
    for (let i = 0; i < 3; i++) {
      h.stt().say('', false)
      expect(h.session.state).toBe('working')
      h.stt().endTurn()
    }
    expect(h.events.some((e) => e.kind === 'flush')).toBe(false)
    h.run(delta('<spoken>Six kinds of sessions have run. </spoken>'))
    h.run(final('<spoken>Six kinds of sessions have run. </spoken> details'))
    expect(h.events).toContainEqual(expect.objectContaining({ kind: 'say', text: 'Six kinds of sessions have run.' }))
  })

  it('real words while the agent works are a turn, and its result is still spoken after them', async () => {
    const h = sessionHarness()
    await h.session.start()
    h.stt().say('list the sessions')
    h.session.follow(R)
    h.run(status('running'))
    h.run(toolStart('a', 'run_terminal', 'git branch'))
    h.stt().say('and the branches too')
    expect(h.events).toContainEqual(expect.objectContaining({ kind: 'turn', text: 'and the branches too' }))
    h.session.follow(R)
    h.run(final('<spoken>Here they are. </spoken>'))
    expect(h.events).toContainEqual(expect.objectContaining({ kind: 'say', text: 'Here they are.' }))
  })

  it('a hand-off the task never took is said out loud, and the session moves on (R3)', async () => {
    const h = sessionHarness()
    await h.session.start()
    h.stt().say('run the tests')
    const handOff = h.events.find((e) => e.kind === 'hand_off') as { handOffId: string }
    // No voice model here: the words were the brief. The task refused it.
    expect(h.session.state).toBe('thinking')
    h.session.handOffFailed(handOff.handOffId, 'refused')
    const say = h.events.filter((e) => e.kind === 'say').at(-1) as { contextId: string; text: string }
    expect(say.text).toBe(HAND_OFF_FAILED_LINE.refused)
    h.session.playback(say.contextId, 'started')
    h.session.playback(say.contextId, 'drained')
    expect(h.session.state).toBe('listening')
  })

  it('with nothing that can speak, a failed hand-off still leaves Thinking (R3)', async () => {
    const h = sessionHarness()
    h.session['deps'].openTts = undefined
    await h.session.start()
    h.stt().say('run the tests')
    const handOff = h.events.find((e) => e.kind === 'hand_off') as { handOffId: string }
    h.session.handOffFailed(handOff.handOffId, 'no_task')
    expect(h.events).toContainEqual(expect.objectContaining({ kind: 'say', text: HAND_OFF_FAILED_LINE.no_task }))
    expect(h.session.state).toBe('listening')
  })

  it('the voice is told the work never went, so it doesn’t claim the agent is on it (R3)', async () => {
    const h = sessionHarness()
    const seen: Array<{ status: string; messages: Array<{ role: string; content: unknown }> }> = []
    let handOffNext = true
    h.session['deps'].responder = () => async function* (req) {
      seen.push({ status: req.status, messages: req.messages as never })
      if (handOffNext) {
        handOffNext = false
        yield { type: 'tool_call' as const, name: 'hand_to_agent', arguments: JSON.stringify({ brief: 'Run the tests' }) }
      } else {
        yield { type: 'text' as const, text: 'Sure. ' }
      }
      yield { type: 'done' as const }
    }
    await h.session.start()
    h.stt().say('run the tests')
    await vi.waitFor(() => expect(h.events.some((e) => e.kind === 'hand_off')).toBe(true))
    const handOff = h.events.find((e) => e.kind === 'hand_off') as { handOffId: string }
    h.session.handOffFailed(handOff.handOffId, 'refused')
    h.stt().say('is it running?')
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    expect(seen[1]!.status).toBe('The agent is idle.')
    expect(JSON.stringify(seen[1]!.messages)).toContain('Nothing was handed to the agent.')
  })

  it('keeps the conversation: each turn, each reply by who said it, and what became of each request (§24.8)', async () => {
    const h = sessionHarness()
    const kept: Array<Record<string, unknown>> = []
    h.session['deps'].record = (e) => kept.push(e)
    await h.session.start()
    h.stt().say('run the tests')
    const handOff = h.events.find((e) => e.kind === 'hand_off') as { handOffId: string }
    h.session.follow(R, handOff.handOffId)
    h.run(status('running'))
    h.run(final('<spoken>All tests pass. </spoken> details'))
    h.stt().say('and lint')
    const second = h.events.filter((e) => e.kind === 'hand_off').at(-1) as { handOffId: string }
    h.session.handOffFailed(second.handOffId, 'refused')
    h.stt().say('', true)
    await h.session.stop()
    expect(kept.map((e) => e.kind)).toEqual([
      'start',
      'you',
      'hand_off',
      'followed',
      'agent',
      'you',
      'hand_off',
      'not_sent',
      'voice',
      'dropped'
    ])
    expect(kept[0]).toMatchObject({ listener: 'deepgram' })
    expect(kept[1]).toMatchObject({ text: 'run the tests' })
    expect(kept[3]).toMatchObject({ runId: R, handOffId: handOff.handOffId })
    expect(kept[4]).toMatchObject({ text: 'All tests pass.' })
    expect(kept[7]).toMatchObject({ handOffId: second.handOffId, reason: 'refused' })
    expect(kept[9]).toEqual({ kind: 'dropped', reason: 'empty', chars: 0 })
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
        name: 'terminal',
        summary: 'pnpm test',
        argsPreview: '{}',
        mutating: true,
        alwaysAllowCommand: 'pnpm test',
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
    expect(h.said.at(-1)).toBe('It wants to run pnpm test. Say yes, no, or always allow.')
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
    expect(h.events).toContainEqual(expect.objectContaining({ kind: 'turn', text: 'yes but use the other script' }))
    // No voice model in this harness: the words go to the agent as they are.
    expect(h.events.at(-1)).toMatchObject({ kind: 'hand_off', brief: 'yes but use the other script' })
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

  it('"always allow" grants what the card’s Always allow would, and says what it remembers', async () => {
    const h = approvalHarness()
    await h.session.start()
    h.session.follow(R)
    h.ask()
    const turnsBefore = h.events.filter((e) => e.kind === 'turn').length
    h.stt().say('Always allow.')
    expect(h.resolveApproval).toHaveBeenCalledWith({ requestId: 'a1', runId: R, decision: 'always' })
    expect(h.events.filter((e) => e.kind === 'turn')).toHaveLength(turnsBefore)
    expect(h.said.at(-1)).toBe('Allowed. It won’t ask again for pnpm test in this workspace.')
  })

  it('an approval answered by voice is kept with what was said and decided', async () => {
    const h = approvalHarness()
    const kept: Array<Record<string, unknown>> = []
    h.session['deps'].record = (e) => kept.push(e)
    await h.session.start()
    h.session.follow(R)
    h.ask()
    h.stt().say('Yes.')
    expect(kept.find((e) => e.kind === 'answered')).toEqual({ kind: 'answered', what: 'approval', text: 'Yes.', decision: 'once', tool: 'terminal' })
  })

  it('never says always where the card wouldn’t offer it: an unscoped command, or a risky one', async () => {
    const h = approvalHarness()
    await h.session.start()
    h.session.follow(R)
    // A command that chains: main gives no command to remember, and the card offers no Always.
    h.ask({ alwaysAllowCommand: null, summary: 'pnpm test && rm -rf out' })
    expect(h.said.at(-1)).toMatch(/Say yes or no\.$/)
    h.stt().say('always allow')
    expect(h.resolveApproval).not.toHaveBeenCalled()
    expect(h.said.at(-1)).toBe('That one can only be allowed once. Say yes or no.')
    // Still waiting: a yes now allows it once.
    h.stt().say('yes')
    expect(h.resolveApproval).toHaveBeenCalledWith(expect.objectContaining({ decision: 'once' }))
    h.resolveApproval.mockClear()
    h.ask({ requestId: 'a2', danger: 'force-pushes over the remote branch' })
    h.stt().say('always allow')
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
    expect(approvalAnswer('Always allow it.')).toBe('always')
    expect(approvalAnswer("Yes, and don't ask again")).toBe('always')
    expect(approvalAnswer('always allow the tests but not lint')).toBeNull()
  })
})

describe('turn latency (§14)', () => {
  it('logs end-of-turn → sent → first sentence → first audio, and no words', async () => {
    let clock = 1000
    const logged: unknown[] = []
    const taps = new Map<string, (e: AgentEvent) => void>()
    const stt: FixtureSttSession[] = []
    const session = new VoiceSession({
      emit: () => {},
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
      tapRun: (runId, fn) => {
        taps.set(runId, fn)
        return () => taps.delete(runId)
      },
      logLatency: (t) => logged.push(t),
      now: () => clock,
      setTimer: () => null,
      clearTimer: () => {},
      newId: () => `id${Math.random()}`
    })
    await session.start()
    stt[0]!.say('secret plan words')
    clock += 40
    session.follow(R)
    clock += 900
    taps.get(R)!(delta('<spoken>Done. </spoken>'))
    clock += 150
    session.playback('ctx', 'started')
    expect(logged).toEqual([{ listener: 'deepgram', submitMs: 40, firstTextMs: 940, firstAudioMs: 1090 }])
    expect(JSON.stringify(logged)).not.toContain('secret')
    // Only the first audio of a turn is timed.
    session.playback('ctx2', 'started')
    expect(logged).toHaveLength(1)
  })
})

describe('whole-turn latency (B10)', () => {
  it('logs the quiet waited out, the listener’s time and the total from your last word', async () => {
    let clock = 0
    const logged: unknown[] = []
    const dropped: unknown[] = []
    const taps = new Map<string, (e: AgentEvent) => void>()
    const stt: FixtureSttSession[] = []
    const tone = (ms: number) => Int16Array.from({ length: (ms / 1000) * 16000 }, (_, i) => Math.round(Math.sin(i / 3) * 8000))
    const session = new VoiceSession({
      emit: () => {},
      settings: () => DEFAULT_VOICE_SETTINGS,
      // OpenRouter listens: it has no turn model, so the session's own pause ends the turn.
      keys: () => ({ voice: {}, chat: { openrouter: true } }),
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
        openFixtureTts({ apiKey: '', model: '', voiceId: '', speed: 1, contextId, signal: new AbortController().signal, onAudio: () => {}, onError: () => {} }),
      tapRun: (runId, fn) => {
        taps.set(runId, fn)
        return () => taps.delete(runId)
      },
      logLatency: (t) => logged.push(t),
      onTurnDropped: (reason, chars, stats) => dropped.push({ reason, chars, ...stats }),
      now: () => clock,
      setTimer: () => null,
      clearTimer: () => {},
      newId: () => `id${Math.random()}`
    })
    await session.start()
    // A breath-length sound that comes back as no words.
    session.pushAudio(tone(400))
    clock += 400
    session.pushAudio(new Int16Array(16000 * 1.4))
    expect(dropped).toEqual([{ reason: 'empty', chars: 0, speechMs: 400, sttMs: 0 }])
    // A real turn.
    session.pushAudio(tone(400))
    stt[0]!.say('what failed', false)
    clock += 400
    session.pushAudio(new Int16Array(16000 * 1.4))
    clock += 1000
    session.follow(R)
    taps.get(R)!(delta('<spoken>The lint step. </spoken>'))
    clock += 200
    session.playback('ctx', 'started')
    expect(logged).toEqual([
      expect.objectContaining({ listener: 'openrouter', waitMs: 1300, sttMs: 0, firstTextMs: 1000, firstAudioMs: 1200, totalMs: 2500 })
    ])
  })

  it('says what the listener did: audio sent, request time, early start, retries (a 12 s turn logged none of it)', async () => {
    const logged: unknown[] = []
    const dropped: unknown[] = []
    const taps = new Map<string, (e: AgentEvent) => void>()
    const stt: FixtureSttSession[] = []
    const session = new VoiceSession({
      emit: () => {},
      settings: () => DEFAULT_VOICE_SETTINGS,
      keys: () => ({ voice: {}, chat: { openrouter: true } }),
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
        openFixtureTts({ apiKey: '', model: '', voiceId: '', speed: 1, contextId, signal: new AbortController().signal, onAudio: () => {}, onError: () => {} }),
      tapRun: (runId, fn) => {
        taps.set(runId, fn)
        return () => taps.delete(runId)
      },
      logLatency: (t) => logged.push(t),
      onTurnDropped: (reason, chars, stats) => dropped.push({ reason, chars, ...stats }),
      setTimer: () => null,
      clearTimer: () => {},
      newId: () => `id${Math.random()}`
    })
    await session.start()
    const emit = (stt[0] as unknown as { emit: (e: unknown) => void }).emit
    emit({ kind: 'end_of_turn', text: '', listen: { audioMs: 61_000, requestMs: 12_000, earlyUsed: false, attempts: 2 } })
    expect(dropped).toEqual([expect.objectContaining({ reason: 'empty', audioMs: 61_000, requestMs: 12_000, earlyUsed: false, attempts: 2 })])
    emit({ kind: 'end_of_turn', text: 'what failed', listen: { audioMs: 2400, requestMs: 900, earlyUsed: true } })
    session.follow(R)
    taps.get(R)!(delta('<spoken>The lint step. </spoken>'))
    session.playback('ctx', 'started')
    expect(logged).toEqual([expect.objectContaining({ audioMs: 2400, requestMs: 900, earlyUsed: true })])
  })
})

describe('voice_reply and helper instances', () => {
  it('is never asked of a helper instance, whose answer goes to the parent agent', async () => {
    const { voiceReplyWanted } = await import('@main/voice/voiceReply')
    setVoiceReplyWorkspace('s2', '/repo')
    const spoken = [{ role: 'user', spoken: true as const }]
    try {
      expect(voiceReplyWanted({ workspacePath: '/repo', messages: spoken })).toBe(true)
      expect(voiceReplyWanted({ workspacePath: '/repo/.worktrees/x', memoryWorkspacePath: '/repo', messages: spoken })).toBe(true)
      expect(voiceReplyWanted({ workspacePath: '/repo', inlineInstance: true, messages: spoken })).toBe(false)
    } finally {
      setVoiceReplyWorkspace('s2', null)
    }
  })
})

describe('voice_reply only for turns said out loud (D-32)', () => {
  it('a typed message, or another task in the same folder, gets a written answer', async () => {
    const { voiceReplyWanted, lastTurnWasSpoken } = await import('@main/voice/voiceReply')
    setVoiceReplyWorkspace('s3', '/repo')
    try {
      const said = { role: 'user', spoken: true as const }
      const typed = { role: 'user' }
      expect(voiceReplyWanted({ workspacePath: '/repo', messages: [typed] })).toBe(false)
      expect(voiceReplyWanted({ workspacePath: '/repo', messages: [said, { role: 'assistant' }, { role: 'tool' }] })).toBe(true)
      // The latest thing you said decides; a loop-injected turn doesn't count.
      expect(lastTurnWasSpoken([said, { role: 'assistant' }, typed])).toBe(false)
      expect(lastTurnWasSpoken([said, { role: 'user', synthetic: true }])).toBe(true)
      expect(voiceReplyWanted({ workspacePath: '/elsewhere', messages: [said] })).toBe(false)
    } finally {
      setVoiceReplyWorkspace('s3', null)
    }
  })
})
