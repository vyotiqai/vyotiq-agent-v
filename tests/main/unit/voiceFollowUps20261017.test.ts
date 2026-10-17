/**
 * The follow-ups to the 2026-10-17 voice audit (docs/voice-mode.md §27.14):
 * words said while an approval waits no longer cancel it, a dropped "One
 * moment." isn't shown as cut off, the agent can read spend and other tasks,
 * a detail to type goes in a form, and streaming listeners get the app's words.
 */
import { describe, expect, it } from 'vitest'
import { ACK_LINES, ACK_MS, VoiceSession, heldLine } from '@main/voice/session'
import { openFixtureStt, type FixtureSttSession } from '@main/voice/providers/fixture'
import type { SttOpenOptions, TtsStream } from '@main/voice/providers/types'
import { workAsk } from '@main/voice/work'
import { formatAppContext, formatSpend, spentOf, spokenAgo, type AppSnapshot } from '@main/voice/appContext'
import { VOICE_APP_TERMS, voiceKeyterms } from '@main/dictation/keywords'
import { readSpendSoFar } from '@main/agent/spendBudget'
import { runAppAction, type AppControlDeps } from '@main/appControl/runner'
import { VOICE_REPLY_TEXT } from '@main/agent/context/userRules'
import { describeAppActions } from '@shared/appActions'
import { DEFAULT_VOICE_SETTINGS, type VoiceEvent } from '@shared/ipc/schemas/voice'
import type { AgentEvent, AgentQuestionAnswer, AgentQuestionRequest, ToolApprovalRequest } from '@shared/ipc'

const tick = () => new Promise((r) => setTimeout(r, 0))
const R = 'run-1'

function setup() {
  const events: VoiceEvent[] = []
  const stt: FixtureSttSession[] = []
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = []
  const streams: Array<{ contextId: string; cancelled: boolean }> = []
  const resolved: Array<{ requestId: string; decision: string }> = []
  const answered: Array<{ requestId: string; answers: AgentQuestionAnswer[] }> = []
  let tap: ((e: AgentEvent) => void) | null = null
  let approvals: { asked: (r: ToolApprovalRequest) => void; settled: (id: string, runId: string) => void } | null = null
  let questions: { asked: (r: AgentQuestionRequest) => void; settled: (id: string, runId: string) => void } | null = null
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
    watchQuestions: (w) => {
      questions = w
      return () => {
        questions = null
      }
    },
    resolveQuestion: (a) => {
      answered.push(a)
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
  return {
    session,
    say,
    fire,
    events,
    streams,
    resolved,
    answered,
    tap: (e: AgentEvent) => tap?.(e),
    approvals: () => approvals!,
    questions: () => questions!,
    handOffs: (): string[] => events.flatMap((e) => (e.kind === 'hand_off' ? [e.brief] : [])),
    spoken: (): string[] => events.flatMap((e) => (e.kind === 'say' ? [e.text] : []))
  }
}

const push = (over: Partial<ToolApprovalRequest> = {}): ToolApprovalRequest =>
  ({
    requestId: 'a1',
    runId: R,
    toolCallId: 't1',
    name: 'terminal',
    summary: 'git -C aether push -u origin local-changes-2026-10-17',
    argsPreview: '',
    timeoutMs: 0,
    mutating: true,
    danger: 'It commits or pushes code, which waits for a yes in voice mode',
    ...over
  }) as ToolApprovalRequest

describe('words said while an approval waits keep it waiting', () => {
  it('asked what it does: said from the approval, and the yes after it answers the push, then the words go on', async () => {
    const t = setup()
    await t.session.start()
    t.session.follow(R)
    t.approvals().asked(push())
    await t.say('What does that do?')
    expect(t.spoken().at(-1)).toBe("It would run git push in aether. It can't easily be undone. The whole command is on your screen. Yes or no?")
    expect(t.handOffs()).toEqual([])
    await t.say('Okay, yes.')
    expect(t.resolved).toEqual([{ requestId: 'a1', runId: R, decision: 'once' }])
    expect(t.handOffs()).toEqual(['What does that do?'])
  })

  it('a no answers it too, and what was said goes on to the agent with the refusal', async () => {
    const t = setup()
    await t.session.start()
    t.session.follow(R)
    t.approvals().asked(push())
    await t.say('Push it to main instead.')
    expect(t.spoken().at(-1)).toBe("I'm still waiting to run git push in aether. Yes or no first, or say it again to cancel it.")
    await t.say('No.')
    expect(t.resolved).toEqual([{ requestId: 'a1', runId: R, decision: 'deny' }])
    expect(t.handOffs()).toEqual(['Push it to main instead.'])
  })

  it('answered on screen: the words go on then', async () => {
    const t = setup()
    await t.session.start()
    t.session.follow(R)
    t.approvals().asked(push())
    await t.say('And then run the tests.')
    expect(t.handOffs()).toEqual([])
    t.approvals().settled('a1', R)
    expect(t.handOffs()).toEqual(['And then run the tests.'])
  })

  it('said again, they mean it: both go to the agent, which cancels the approval as typing would', async () => {
    const t = setup()
    await t.session.start()
    t.session.follow(R)
    t.approvals().asked(push())
    await t.say('Push it to main instead.')
    await t.say('I said push it to main.')
    expect(t.resolved).toEqual([])
    expect(t.handOffs()).toEqual(['Push it to main instead. I said push it to main.'])
  })

  it('"hold on" leaves it waiting and says nothing', async () => {
    const t = setup()
    await t.session.start()
    t.session.follow(R)
    t.approvals().asked(push())
    const said = t.spoken().length
    await t.say('Hold on.')
    expect(t.spoken()).toHaveLength(said)
    expect(t.handOffs()).toEqual([])
    expect(t.resolved).toEqual([])
  })

  it('the line names what a guard found', () => {
    expect(heldLine(push({ danger: 'Force-pushes, which rewrites history on the remote' }), 'why?')).toBe(
      'It would run git push in aether. Force-pushes, which rewrites history on the remote. The whole command is on your screen. Yes or no?'
    )
    expect(heldLine({ name: 'git_commit', summary: '' }, 'क्या है यह')).toBe('It would commit the changes. The details are on your screen. Yes or no?')
    expect(heldLine({ name: 'git_commit', summary: '' }, 'the readme too')).toBe("I'm still waiting to commit the changes. Yes or no first, or say it again to cancel it.")
  })
})

describe('a "One moment." that never played', () => {
  it('is flushed as unsaid, so the view drops it rather than marking it cut', async () => {
    const t = setup()
    await t.session.start()
    await t.say('Check it.')
    t.session.follow(R)
    t.tap({ type: 'status', runId: R, status: 'running' } as AgentEvent)
    t.fire(ACK_MS)
    expect(t.spoken()).toEqual([ACK_LINES[0]])
    const ack = t.streams.at(-1)!
    t.tap({ type: 'text_delta', runId: R, text: '<spoken>Done.</spoken>' } as unknown as AgentEvent)
    expect(t.events).toContainEqual(expect.objectContaining({ kind: 'flush', contextId: ack.contextId, unsaid: true }))
  })
})

describe('a detail to type', () => {
  const emailQuestion = (): AgentQuestionRequest => ({
    requestId: 'q1',
    runId: R,
    toolCallId: 't2',
    questions: [{ id: 'email', prompt: 'What email should the commits use?', type: 'text' }]
  })

  it('the view gets the whole form when no button can answer it, never for a pick', () => {
    const ask = workAsk(null, emailQuestion(), () => '')
    expect(ask).toMatchObject({ kind: 'question', options: [], form: { questions: [{ id: 'email', type: 'text' }] } })
    const pick = workAsk(null, { ...emailQuestion(), questions: [{ id: 'b', prompt: 'Which?', type: 'single', options: ['main', 'dev'] }] }, () => '')
    expect(pick).not.toHaveProperty('form')
  })

  it('"let me type it" keeps the form open; the words said next are the answer', async () => {
    const t = setup()
    await t.session.start()
    t.session.follow(R)
    t.questions().asked(emailQuestion())
    await t.say('Let me type it.')
    expect(t.answered).toEqual([])
    expect(t.spoken().at(-1)).toBe('Go ahead, it’s on your screen.')
    expect(t.handOffs()).toEqual([])
    await t.say('Hold on.')
    expect(t.answered).toEqual([])
    await t.say('singh raj veer at gmail dot com')
    expect(t.answered).toEqual([{ requestId: 'q1', runId: R, answers: [{ questionId: 'email', values: ['singh raj veer at gmail dot com'] }] }])
  })

  it('the voice prompt sends exact details to a form, never to the chat', () => {
    expect(VOICE_REPLY_TEXT).toContain('call ask_question with a text question: voice mode shows it as a field they can type in')
    expect(VOICE_REPLY_TEXT).toContain('another task, with read_task')
  })
})

describe('spend and other tasks for the agent', () => {
  const now = new Date('2026-10-17T09:30:00Z')
  const base: AppSnapshot = { now, workspace: { name: 'OS' }, others: [], settings: {}, rules: [], memory: [] }

  it('a bill and an estimate as one figure, labelled when any of it is an estimate', () => {
    expect(spentOf(0, 0.081613345)).toEqual({ usd: 0.081613345, estimated: true })
    expect(spentOf(1.5, 0)).toEqual({ usd: 1.5, estimated: false })
    expect(spentOf(undefined, undefined)).toBeUndefined()
    expect(formatSpend({ task: { usd: 0.0816, estimated: true } })).toBe(
      'Spend: this task about $0.082 so far. “About” is an estimate from published prices where the provider bills no figure. The Usage view has the breakdown.'
    )
    expect(formatSpend({ today: { usd: 3.1, estimated: false }, month: { usd: 40.2, estimated: false }, dailyBudget: 5 })).toBe(
      'Spend: today $3.10 of a $5.00 budget; this month $40.20 (today and this month across every workspace). The Usage view has the breakdown.'
    )
  })

  it('app_status lists the latest tasks here and the spend: "I don’t have a cost figure" (09:19:13)', () => {
    const text = formatAppContext({
      ...base,
      recent: [{ title: 'Commit the aether work', state: 'done', at: new Date('2026-10-17T09:18:00Z') }],
      spend: { task: { usd: 0.08, estimated: true }, today: { usd: 0.5, estimated: true } }
    })
    expect(text).toContain('Latest other tasks here: “Commit the aether work” (finished, 12 minutes ago). read_task reads one.')
    expect(text).toContain('Spend: this task about $0.08 so far; today about $0.5 (today')
  })

  it('says when, in words', () => {
    expect(spokenAgo(new Date('2026-10-17T09:29:50Z'), now)).toBe('just now')
    expect(spokenAgo(new Date('2026-10-17T08:30:00Z'), now)).toBe('1 hour ago')
    expect(spokenAgo(new Date('2026-10-15T09:30:00Z'), now)).toBe('2 days ago')
  })

  it('today and this month are the sums Usage adds, billed and estimated apart', async () => {
    const windows: number[] = []
    const sums = await readSpendSoFar(new Date(2026, 9, 17, 12), {
      workspacePaths: () => ['C:/work/os'],
      budget: () => ({ dailyUsd: 5, monthlyUsd: 0 }),
      collect: async (_p, _n, windowDays) => {
        windows.push(windowDays)
        return { totals: windowDays === 1 ? { billedCost: 0.2, estimatedCost: 0.3 } : { billedCost: 2, estimatedCost: 3 } } as never
      }
    })
    expect(windows.sort((a, b) => a - b)).toEqual([1, 17])
    expect(sums).toEqual({ today: { billed: 0.2, estimated: 0.3 }, month: { billed: 2, estimated: 3 }, dailyUsd: 5, monthlyUsd: 0 })
  })

  it('read_task finds a task by its words in any open workspace and reads it', async () => {
    const read: Array<[string, string]> = []
    const deps = {
      openWorkspaces: () => ['C:/work/os', 'C:/work/site'],
      activeWorkspace: () => 'C:/work/os',
      listTasks: async (path: string) => (path === 'C:/work/site' ? [{ runId: 'r9', title: 'Write the release notes', status: 'done' }] : []),
      window: () => null,
      cancelRun: () => false,
      runActive: () => false,
      startTask: () => ({ ok: false, error: '' }),
      sendToTask: async () => ({ ok: false, error: '' }),
      patchSettings: async () => {},
      settings: () => ({}),
      status: async () => '',
      readTask: async (path: string, runId: string) => {
        read.push([path, runId])
        return '“Write the release notes” in site: finished.'
      },
      openPath: async () => '',
      revealPath: () => {},
      openExternal: async () => {},
      quit: () => {}
    } as AppControlDeps
    expect(await runAppAction(deps, 'read_task', { task: 'release notes' }, { runId: 'r1', workspacePath: 'C:/work/os' })).toEqual({
      ok: true,
      message: '“Write the release notes” in site: finished.',
      runId: 'r9'
    })
    expect(read).toEqual([['C:/work/site', 'r9']])
    expect(await runAppAction(deps, 'read_task', { task: 'the new one' }, { runId: 'r1', workspacePath: 'C:/work/os' })).toEqual({
      ok: false,
      message: 'No task matches “the new one”.'
    })
    expect(describeAppActions()).toContain('read_task {task?}: Read another task')
  })
})

describe('a listener that takes hints hears the app’s words and the folders', () => {
  it('app words first, then top-level folders by use, then mixed-case names; build folders and repeats left out', () => {
    const files = [
      'aether/agentsd/src/main.rs',
      'aether/shell/src/lib.rs',
      'aether/README.md',
      'aether-ci/Containerfile',
      'node_modules/x/index.js',
      '.git/HEAD',
      'AETHER_OS_BLUEPRINT.md',
      'tools/runAgent.ts'
    ]
    const terms = voiceKeyterms(files)
    expect(terms.slice(0, VOICE_APP_TERMS.length)).toEqual([...VOICE_APP_TERMS])
    expect(terms).toContain('aether')
    expect(terms).toContain('aether-ci')
    expect(terms).toContain('runAgent')
    expect(terms).not.toContain('node_modules')
    expect(terms.indexOf('aether')).toBeLessThan(terms.indexOf('aether-ci'))
    expect(new Set(terms.map((x) => x.toLowerCase())).size).toBe(terms.length)
    expect(voiceKeyterms(files, 3)).toHaveLength(3)
  })
})
