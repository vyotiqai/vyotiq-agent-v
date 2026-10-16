import { describe, expect, it, vi } from 'vitest'
import { VoiceSession, type VoiceSessionDeps } from '@main/voice/session'
import { openFixtureStt, openFixtureTts, type FixtureSttSession } from '@main/voice/providers/fixture'
import { DEFAULT_VOICE_SETTINGS, type VoiceEvent } from '@shared/ipc/schemas/voice'
import type { AgentQuestionRequest, ToolApprovalRequest } from '@shared/ipc'

/*
  Fourth voice audit (docs/voice-mode.md §24.9): what the session does with a
  run it didn't start (one already working when voice mode opened), and
  whether its short answers to approvals and questions are heard, not only
  shown.
*/

const R = 'run1'

const approval = (over: Partial<ToolApprovalRequest> = {}): ToolApprovalRequest =>
  ({ requestId: 'a1', runId: R, toolCallId: 't1', name: 'terminal', summary: 'pnpm test', args: '{}', ...over }) as ToolApprovalRequest

const question = (over: Partial<AgentQuestionRequest> = {}): AgentQuestionRequest => ({
  requestId: 'q1',
  runId: R,
  toolCallId: 't2',
  questions: [{ id: 'x', prompt: 'Keep the old API', type: 'boolean' }],
  ...over
})

function harness(extra: Partial<VoiceSessionDeps> = {}) {
  const events: VoiceEvent[] = []
  const spoken: string[] = []
  const stt: FixtureSttSession[] = []
  let approvals: { asked: (r: ToolApprovalRequest) => void; settled: (id: string, run: string) => void } | null = null
  let taps = 0
  let n = 0
  const resolveApproval = vi.fn(() => true)
  const resolveQuestion = vi.fn(() => true)
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
      const stream = openFixtureTts({
        apiKey: '',
        model: '',
        voiceId: '',
        speed: 1,
        contextId,
        signal: new AbortController().signal,
        onAudio: () => {},
        onError: () => {}
      })
      const push = stream.pushText.bind(stream)
      stream.pushText = (text: string) => {
        spoken.push(text)
        push(text)
      }
      return stream
    },
    tapRun: () => {
      taps++
      return () => {}
    },
    watchApprovals: (w) => {
      approvals = w
      return () => {
        approvals = null
      }
    },
    resolveApproval,
    watchQuestions: () => () => {},
    resolveQuestion,
    setTimer: () => null,
    clearTimer: () => {},
    newId: () => `id${++n}`,
    ...extra
  })
  const said = () => events.flatMap((e) => (e.kind === 'say' ? [e.text] : []))
  const states = () => events.flatMap((e) => (e.kind === 'state' ? [e.state] : []))
  return { session, events, spoken, said, states, stt: () => stt.at(-1)!, approvals: () => approvals!, resolveApproval, resolveQuestion, taps: () => taps }
}

describe('a run that was already working when voice mode opened', () => {
  it('picks up the approval it is already waiting on, and asks for it out loud', async () => {
    const pending = approval()
    const h = harness({ pendingAsks: (runId) => (runId === R ? { approvals: [pending], questions: [] } : { approvals: [], questions: [] }) })
    await h.session.start()
    h.session.follow(R)
    expect(h.session.state).toBe('waiting_on_you')
    expect(h.spoken.join(' ')).toContain('Can I run pnpm test?')
    // And a spoken yes answers it, as for an approval asked after the follow.
    h.stt().say('yes')
    expect(h.resolveApproval).toHaveBeenCalledWith({ requestId: 'a1', runId: R, decision: 'once' })
  })

  it('picks up a question it is already waiting on', async () => {
    const h = harness({ pendingAsks: () => ({ approvals: [], questions: [question()] }) })
    await h.session.start()
    h.session.follow(R)
    expect(h.session.state).toBe('waiting_on_you')
    h.stt().say('yes')
    expect(h.resolveQuestion).toHaveBeenCalledWith({ requestId: 'q1', runId: R, answers: [{ questionId: 'x', values: ['Yes'] }] })
  })

  it('following the same run again without a hand-off changes nothing (no new turn, no second tap)', async () => {
    const h = harness()
    await h.session.start()
    h.session.follow(R)
    const before = h.events.length
    h.session.follow(R)
    expect(h.taps()).toBe(1)
    expect(h.events.length).toBe(before)
  })

  it('"stop" stops a run that was only followed, never handed off', async () => {
    const h = harness()
    await h.session.start()
    h.session.follow(R)
    h.stt().say('stop')
    expect(h.events.some((e) => e.kind === 'stop_agent')).toBe(true)
  })
})

describe('short answers to approvals and questions are heard', () => {
  it('"Allowed." is spoken, not only captioned', async () => {
    const h = harness()
    await h.session.start()
    h.session.follow(R)
    h.approvals().asked(approval())
    h.stt().say('yes')
    expect(h.said()).toContain('Allowed.')
    expect(h.spoken).toContain('Allowed.')
  })

  it('"Denied." and "Got it." are spoken too', async () => {
    const h = harness({ pendingAsks: () => ({ approvals: [], questions: [question({ requestId: 'q9' })] }) })
    await h.session.start()
    h.session.follow(R)
    h.stt().say('no')
    expect(h.spoken).toContain('Got it.')
    h.approvals().asked(approval({ requestId: 'a2' }))
    h.stt().say('no')
    expect(h.spoken).toContain('Denied.')
  })

  it('with nothing that can speak, answering moves the orb back to the work instead of sitting on Thinking', async () => {
    // As in main: resolving an approval settles it for its watchers at once.
    const h: ReturnType<typeof harness> = harness({
      openTts: () => null,
      resolveApproval: (a) => {
        h.approvals().settled(a.requestId, R)
        return true
      }
    })
    await h.session.start()
    h.session.follow(R)
    h.approvals().asked(approval())
    h.stt().say('yes')
    expect(h.session.state).toBe('working')
  })
})

