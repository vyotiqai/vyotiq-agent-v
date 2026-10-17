/**
 * What the kept voice conversations of 2026-10-17 08:04–09:29 got wrong
 * (workspaces/172161f4…/voice/*.jsonl, vyotiq.log): two voices at once, a
 * yes that wasn't heard as one, a question asked again, and whole command
 * lines read out.
 */
import { describe, expect, it } from 'vitest'
import { ACK_LINES, ACK_MS, VoiceSession, asksSomething, speakApproval, speakCommand } from '@main/voice/session'
import { openFixtureStt, type FixtureSttSession } from '@main/voice/providers/fixture'
import type { SttOpenOptions, TtsStream } from '@main/voice/providers/types'
import { approvalAnswer } from '@main/voice/speechText'
import { VOICE_REPLY_TEXT } from '@main/agent/context/userRules'
import { DEFAULT_VOICE_SETTINGS, type VoiceEvent } from '@shared/ipc/schemas/voice'
import type { AgentEvent, ToolApprovalRequest } from '@shared/ipc'

const tick = () => new Promise((r) => setTimeout(r, 0))
const R = 'run-1'

function setup() {
  const events: VoiceEvent[] = []
  const stt: FixtureSttSession[] = []
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = []
  const streams: Array<{ contextId: string; cancelled: boolean }> = []
  const resolved: Array<{ requestId: string; decision: string }> = []
  let tap: ((e: AgentEvent) => void) | null = null
  let approvals: { asked: (r: ToolApprovalRequest) => void; settled: (id: string, runId: string) => void } | null = null
  let n = 0
  const session = new VoiceSession({
    emit: (e) => events.push(e),
    settings: () => ({ ...DEFAULT_VOICE_SETTINGS, sttProvider: 'openrouter' }),
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
    openTts: (contextId) => {
      const s = { contextId, cancelled: false }
      streams.push(s)
      return {
        pushText: () => {},
        flush: () => {},
        end: () => {},
        cancel: () => {
          s.cancelled = true
        },
        done: () => Promise.resolve()
      } as unknown as TtsStream
    },
    tapRun: (_runId, fn) => {
      tap = fn
      return () => {
        tap = null
      }
    },
    watchApprovals: (w) => {
      approvals = w
      return () => {
        approvals = null
      }
    },
    resolveApproval: (a) => {
      resolved.push(a)
      return true
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true }
      timers.push(t)
      return t
    },
    clearTimer: (h) => {
      if (h) (h as { live: boolean }).live = false
    },
    newId: () => `id${++n}`
  })
  const say = async (text: string): Promise<void> => {
    stt.at(-1)!.say(text)
    for (let i = 0; i < 5; i++) await tick()
  }
  const fire = (ms: number): void => {
    for (const t of timers.splice(0)) {
      if (t.live && t.ms === ms) t.fn()
      else if (t.live) timers.push(t)
    }
  }
  const agentSays = (text: string): void => {
    tap?.({ type: 'text_delta', runId: R, text: `<spoken>${text}</spoken>` } as unknown as AgentEvent)
    tap?.({ type: 'assistant_message', runId: R, content: `<spoken>${text}</spoken>` } as unknown as AgentEvent)
  }
  const handOffs = (): string[] => events.flatMap((e) => (e.kind === 'hand_off' ? [e.brief] : []))
  const spoken = (): string[] => events.flatMap((e) => (e.kind === 'say' ? [e.text] : []))
  const flushed = (): string[] => events.flatMap((e) => (e.kind === 'flush' ? [e.contextId] : []))
  const unanswered = (): string[] => events.flatMap((e) => (e.kind === 'unanswered' && e.text ? [e.text] : []))
  return {
    session,
    say,
    fire,
    agentSays,
    handOffs,
    spoken,
    flushed,
    unanswered,
    streams,
    resolved,
    events,
    tap: (e: AgentEvent) => tap?.(e),
    approvals: () => approvals
  }
}

const pushApproval = (over: Partial<ToolApprovalRequest> = {}): ToolApprovalRequest =>
  ({
    requestId: 'a1',
    runId: R,
    toolCallId: 't1',
    name: 'terminal',
    summary: 'git -C aether push -u origin local-changes-2026-10-17 2>&1; echo push exit $LASTEXITCODE; exit 0',
    argsPreview: '',
    timeoutMs: 0,
    mutating: true,
    danger: 'pushes to a remote',
    ...over
  }) as ToolApprovalRequest

describe('one voice at a time', () => {
  it('"One moment." not yet heard is dropped when the agent’s words come (09:22:44: 0.27 s apart)', async () => {
    const t = setup()
    await t.session.start()
    await t.say('Check it.')
    t.session.follow(R)
    t.tap({ type: 'status', runId: R, status: 'running' } as AgentEvent)
    t.fire(ACK_MS)
    expect(t.spoken()).toEqual([ACK_LINES[0]])
    const ack = t.streams.at(-1)!
    t.agentSays('I can’t read the new task from here.')
    expect(ack.cancelled).toBe(true)
    expect(t.flushed()).toContain(ack.contextId)
    expect(t.spoken().at(-1)).toBe('I can’t read the new task from here.')
  })

  it('a short line already playing is left to finish: the window plays one line after the other', async () => {
    const t = setup()
    await t.session.start()
    await t.say('Check it.')
    t.session.follow(R)
    t.tap({ type: 'status', runId: R, status: 'running' } as AgentEvent)
    t.fire(ACK_MS)
    const ack = t.streams.at(-1)!
    t.session.playback(ack.contextId, 'started')
    t.agentSays('Done.')
    expect(ack.cancelled).toBe(false)
    expect(t.flushed()).not.toContain(ack.contextId)
  })

  it('"What does it do?" while the push waits is answered from the approval, which stays (09:28:44)', async () => {
    const t = setup()
    await t.session.start()
    t.session.follow(R)
    t.approvals()!.asked(pushApproval())
    await t.say('What does it do?')
    expect(t.handOffs()).toEqual([])
    expect(t.spoken().at(-1)).toBe('It would run git push in aether. Pushes to a remote. The whole command is on your screen. Yes or no?')
    expect(t.resolved).toEqual([])
  })
})

describe('a yes is a yes', () => {
  it.each(['Yes, yes. Oh.', 'Yeah, go ahead.', 'Yes yes', 'Okay, okay.', 'I said yes.', 'Mm-hmm.', 'Yep, do it.', 'हाँ', 'हां जी', 'Haan ji'])('%s', (said) =>
    expect(approvalAnswer(said)).toBe('once')
  )

  it.each(['No, no.', 'Nope.', 'No, don’t.', 'नहीं'])('%s is a no', (said) => expect(approvalAnswer(said)).toBe('deny'))

  it.each(['yes but use the other file', 'Yes. No.', 'I said commit.', 'Hmm.', 'Oh.', 'please', 'it', 'Continue.'])('not an answer: %s', (said) =>
    expect(approvalAnswer(said)).toBeNull()
  )

  it('"Yes, yes. Oh." answers the push it was asked about (09:29:02), and says nothing more', async () => {
    const t = setup()
    await t.session.start()
    t.session.follow(R)
    t.approvals()!.asked(pushApproval())
    await t.say('Yes, yes. Oh.')
    expect(t.resolved).toEqual([{ requestId: 'a1', runId: R, decision: 'once' }])
    expect(t.handOffs()).toEqual([])
    expect(t.spoken().at(-1)).toBe('Allowed.')
  })
})

describe('a question asked earlier is still open', () => {
  it('"Yep." after "I\'m asking whether to ignore the three remaining tool folders." is a turn (09:06:34)', async () => {
    const t = setup()
    await t.session.start()
    await t.say('What did you say?')
    t.session.follow(R)
    t.tap({ type: 'status', runId: R, status: 'running' } as AgentEvent)
    t.agentSays('Nothing is committed yet, and I’m asking whether to ignore the three remaining tool folders.')
    t.tap({ type: 'status', runId: R, status: 'done' } as AgentEvent)
    await t.say('Yep.')
    expect(t.unanswered()).toEqual([])
    expect(t.handOffs().at(-1)).toBe('Yep.')
  })

  it('a question two replies back counts until your next turn answers it', async () => {
    const t = setup()
    await t.session.start()
    t.session.follow(R)
    t.tap({ type: 'status', runId: R, status: 'running' } as AgentEvent)
    t.agentSays('Should I ignore the three remaining tool folders too?')
    t.agentSays('The test suite has no test script.')
    await t.say('Yep.')
    expect(t.handOffs()).toEqual(['Yep.'])
    // Answered: "Okay." to the reply that follows, a statement, is a backchannel again.
    t.agentSays('Done, they’re ignored.')
    await t.say('Okay.')
    expect(t.unanswered()).toEqual(['Okay.'])
  })

  it.each([
    'I’m waiting on your call about the aether folder.',
    'I need you to pick one of two ways to handle it.',
    'Just say yes or no.',
    'Nothing is committed yet, and I’m asking whether to ignore the three remaining tool folders.'
  ])('asks: %s', (line) => expect(asksSomething(line)).toBe(true))

  it.each(['I haven’t changed anything.', 'Git now ignores them.', 'The gitignore and blueprint are committed.'])('states: %s', (line) =>
    expect(asksSomething(line)).toBe(false)
  )
})

describe('a command is said by what it runs', () => {
  it.each([
    ['git -C aether push -u origin local-changes-2026-10-17 2>&1; echo push exit $LASTEXITCODE; exit 0', 'git push in aether'],
    [
      'git -C aether checkout -b local-changes-2026-10-17; git -C aether add -A; git -C aether -c core.autocrlf=false commit -…',
      'git checkout, add and commit in aether'
    ],
    ["$env:GIT_TERMINAL_PROMPT='0'; git -C aether push -u origin local-changes-2026-10-17 2>&1; echo push exit $LASTEXITCODE;…", 'git push in aether'],
    ['pnpm install && pnpm test', 'pnpm install, then pnpm test'],
    ['rm -rf node_modules', 'rm'],
    ['echo hi; exit 0', 'a command']
  ])('%s', (command, said) => expect(speakCommand(command)).toBe(said))

  it('the approval asks "run git push in aether", never the command line', () => {
    expect(speakApproval(pushApproval())).toBe('run git push in aether')
    expect(speakApproval({ name: 'git_commit', summary: '' })).toBe('commit the changes')
  })

  it('the spoken ask says it short', async () => {
    const t = setup()
    await t.session.start()
    t.session.follow(R)
    t.approvals()!.asked(pushApproval())
    expect(t.spoken().at(-1)).toBe("I need your yes to run git push in aether. It can't easily be undone. Yes or no?")
  })
})

describe('the voice prompt', () => {
  it('never asks them to type, takes a short yes as the yes, and lets the app ask for a commit', () => {
    expect(VOICE_REPLY_TEXT).toContain('Never tell them to type in the chat')
    expect(VOICE_REPLY_TEXT).toContain('call ask_question with a text question')
    expect(VOICE_REPLY_TEXT).toContain('right after you asked or offered something is their yes')
    expect(VOICE_REPLY_TEXT).toContain('a commit or a push), call it at once')
  })
})
