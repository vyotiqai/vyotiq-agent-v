import { describe, expect, it, vi } from 'vitest'
import { VoiceSession } from '@main/voice/session'
import { openFixtureStt, openFixtureTts, ScriptedFixtureSttSession, fixtureTurnsFromEnv, type FixtureSttSession, type FixtureTtsStream } from '@main/voice/providers/fixture'
import { DEFAULT_VOICE_SETTINGS, type VoiceEvent, type VoiceSettings } from '@shared/ipc/schemas/voice'
import type { AgentEvent, ToolApprovalRequest } from '@shared/ipc'

/*
  Session wiring the GUI e2e (tests/gui-e2e/voice.spec.ts) found broken in the
  real app, pinned here so they stay fixed without a built app.
*/

const R = 'run1'

function harness(over: Partial<VoiceSettings> = {}, deps: { pending?: ToolApprovalRequest[] } = {}) {
  const events: VoiceEvent[] = []
  const stt: FixtureSttSession[] = []
  const tts: FixtureTtsStream[] = []
  let tap: ((e: AgentEvent) => void) | null = null
  let n = 0
  const resolveApproval = vi.fn(() => true)
  const session = new VoiceSession({
    emit: (e) => events.push(e),
    settings: () => ({ ...DEFAULT_VOICE_SETTINGS, ...over }),
    keys: () => ({ voice: { deepgram: true, elevenlabs: true }, chat: {} }),
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
    tapRun: (_id, fn) => {
      tap = fn
      return () => {
        tap = null
      }
    },
    watchApprovals: () => () => {},
    pendingAsks: (runId) => ({ approvals: (deps.pending ?? []).filter((p) => p.runId === runId), questions: [] }),
    resolveApproval,
    setTimer: () => null,
    clearTimer: () => {},
    newId: () => `id${++n}`
  })
  const said = () => events.filter((e) => e.kind === 'say').map((e) => (e as { text: string }).text)
  return { session, events, stt: () => stt.at(-1)!, tts, run: (e: AgentEvent) => tap?.(e), said, resolveApproval }
}

const approval: ToolApprovalRequest = {
  requestId: 'a1',
  runId: R,
  toolCallId: 't1',
  name: 'terminal',
  summary: 'pnpm test',
  argsPreview: '{"command":"pnpm test"}',
  mutating: true
} as ToolApprovalRequest

describe('voice session wiring found in the real app', () => {
  it('with Captions off the reply is still announced to the window, so its audio plays (D-38)', async () => {
    const h = harness({ captions: false })
    await h.session.start()
    h.stt().say('explain it')
    h.session.follow(R)
    h.run({ type: 'text_delta', runId: R, text: '<spoken>It is fixed. ' } as AgentEvent)
    expect(h.said()).toEqual(['It is fixed.'])
  })

  it('an approval asked before the session followed the run is read out on follow (D-36)', async () => {
    const h = harness({}, { pending: [approval] })
    await h.session.start()
    h.stt().say('run the tests')
    h.session.follow(R)
    expect(h.session.state).toBe('waiting_on_you')
    expect(h.said()).toContain('Can I run pnpm test? Yes or no?')
    h.stt().say('yes')
    expect(h.resolveApproval).toHaveBeenCalledWith({ requestId: 'a1', runId: R, decision: 'once' })
  })

  it('answering while the question is still being read stops the reading, not the reply that follows', async () => {
    const h = harness({}, { pending: [approval] })
    await h.session.start()
    h.stt().say('run the tests')
    h.session.follow(R)
    const askId = (h.events.filter((e) => e.kind === 'say').at(-1) as { contextId: string }).contextId
    h.session.playback(askId, 'started')
    h.stt().say('yes')
    expect(h.events).toContainEqual(expect.objectContaining({ kind: 'flush', contextId: askId }))
    // The run carries on and its summary is still spoken (not silenced as a barge-in would).
    h.run({ type: 'text_delta', runId: R, text: '<spoken>Tests pass. ' } as AgentEvent)
    expect(h.said()).toContain('Tests pass.')
  })

  it('the reply audio starting after the run ended still counts as speaking (D-37)', async () => {
    const h = harness()
    await h.session.start()
    h.stt().say('explain it')
    h.session.follow(R)
    h.run({ type: 'status', runId: R, status: 'running' } as AgentEvent)
    h.run({ type: 'text_delta', runId: R, text: '<spoken>It is fixed. </spoken>' } as AgentEvent)
    h.run({ type: 'assistant_message', runId: R, content: '<spoken>It is fixed. </spoken>' } as AgentEvent)
    h.run({ type: 'status', runId: R, status: 'done' } as AgentEvent)
    expect(h.session.state).toBe('listening')
    const id = (h.events.find((e) => e.kind === 'say') as { contextId: string }).contextId
    h.session.playback(id, 'started')
    expect(h.session.state).toBe('speaking')
    h.session.playback(id, 'drained')
    expect(h.session.state).toBe('listening')
  })
})

describe('the scripted e2e listener', () => {
  it('reads its turns from the environment', () => {
    expect(fixtureTurnsFromEnv({ VYOTIQ_VOICE_FIXTURE_TURNS: '["a", 2, "b"]' })).toEqual(['a', 'b'])
    expect(fixtureTurnsFromEnv({ VYOTIQ_VOICE_FIXTURE_TURNS: 'not json' })).toBeNull()
    expect(fixtureTurnsFromEnv({})).toBeNull()
  })

  it('hears the next sentence for each stretch of sound followed by a pause', () => {
    const events: Array<{ kind: string; text?: string }> = []
    const s = new ScriptedFixtureSttSession((e) => events.push(e as never), ['first', 'second'])
    const tone = (ms: number) => Int16Array.from({ length: (ms / 1000) * 16000 }, (_, i) => Math.round(Math.sin(i / 3) * 8000))
    const quiet = (ms: number) => new Int16Array((ms / 1000) * 16000)
    s.pushAudio(tone(600))
    s.pushAudio(quiet(1100))
    s.pushAudio(tone(600))
    s.pushAudio(quiet(1100))
    expect(events.filter((e) => e.kind === 'end_of_turn').map((e) => e.text)).toEqual(['first', 'second'])
  })
})

describe('a listener that closes while you are muted (D-39)', () => {
  it('reconnects when you unmute, so talking works again', async () => {
    const timers: Array<() => void> = []
    const stt: FixtureSttSession[] = []
    const events: VoiceEvent[] = []
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
      setTimer: (fn) => {
        timers.push(fn)
        return fn
      },
      clearTimer: () => {}
    })
    await session.start()
    session.setMuted(true)
    expect(session.state).toBe('paused')
    await stt[0]!.close() // the vendor closes the idle connection
    expect(session.state).toBe('paused')
    session.setMuted(false)
    expect(session.state).toBe('reconnecting')
    // The reconnect timer fires; a fresh listener opens.
    timers.splice(0).forEach((fn) => fn())
    await vi.waitFor(() => expect(session.state).toBe('listening'))
    expect(stt).toHaveLength(2)
    stt[1]!.say('hello again')
    expect(events.filter((e) => e.kind === 'turn').at(-1)).toMatchObject({ text: 'hello again' })
  })
})
