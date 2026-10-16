/**
 * Voice mode is the agent (docs/voice-mode.md §27): every turn goes to the
 * task as you said it, nothing answers in between, a short line says it
 * heard you when the agent hasn't spoken yet, and the agent's app_control
 * reaches voice mode's own controls (mute until called, end) through the
 * session following its run.
 */
import { describe, expect, it } from 'vitest'
import { ACK_LINES, ACK_MS, UNFINISHED_WAIT_MS, VoiceSession } from '@main/voice/session'
import { openFixtureStt, type FixtureSttSession } from '@main/voice/providers/fixture'
import type { SttOpenOptions, TtsStream } from '@main/voice/providers/types'
import { afterWakeName } from '@main/voice/speechText'
import { DEFAULT_VOICE_SETTINGS, type VoiceEvent } from '@shared/ipc/schemas/voice'
import type { AgentEvent, ToolApprovalRequest } from '@shared/ipc'

const tick = () => new Promise((r) => setTimeout(r, 0))
const silentTts = (): TtsStream =>
  ({ pushText: () => {}, flush: () => {}, end: () => {}, cancel: () => {}, done: () => Promise.resolve() }) as unknown as TtsStream

const R = 'run-1'

function setup() {
  const events: VoiceEvent[] = []
  const stt: FixtureSttSession[] = []
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = []
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
    openTts: () => silentTts(),
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
    resolveApproval: () => true,
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
  /** Run the live timers set for this long. */
  const fire = (ms: number): void => {
    for (const t of timers.splice(0)) {
      if (t.live && t.ms === ms) t.fn()
      else if (t.live) timers.push(t)
    }
  }
  const handOffs = (): string[] => events.flatMap((e) => (e.kind === 'hand_off' ? [e.brief] : []))
  const spoken = (): string[] => events.flatMap((e) => (e.kind === 'say' ? [e.text] : []))
  return { session, say, fire, handOffs, spoken, events, tap: (e: AgentEvent) => tap?.(e), approvals: () => approvals }
}

describe('every turn goes to the agent as you said it', () => {
  it('your words are the message: nothing rewrites or answers them in between', async () => {
    const t = setup()
    await t.session.start()
    await t.say('Change the theme to dark and use Haiku for this task.')
    expect(t.handOffs()).toEqual(['Change the theme to dark and use Haiku for this task.'])
    // Nothing is said by the session itself before the agent speaks.
    expect(t.spoken()).toEqual([])
  })

  it('"Can you" waits a moment for the rest, and both go as one message', async () => {
    const t = setup()
    await t.session.start()
    await t.say('Can you')
    expect(t.handOffs()).toEqual([])
    await t.say('open the terminal?')
    expect(t.handOffs()).toEqual(['Can you open the terminal?'])
  })

  it('"Can you" alone still goes once the wait is over', async () => {
    const t = setup()
    await t.session.start()
    await t.say('Can you')
    t.fire(UNFINISHED_WAIT_MS)
    expect(t.handOffs()).toEqual(['Can you'])
  })

  it('says a short line when nothing has been said by then, and not when the agent spoke first', async () => {
    const t = setup()
    await t.session.start()
    await t.say('What branch am I on?')
    t.fire(ACK_MS)
    expect(t.spoken()).toEqual([ACK_LINES[0]])

    const u = setup()
    await u.session.start()
    await u.say('What branch am I on?')
    u.session.follow(R, 'id1')
    u.tap({ type: 'status', runId: R, status: 'running' } as AgentEvent)
    u.tap({ type: 'text_delta', runId: R, text: '<spoken>You’re on main.</spoken>' } as unknown as AgentEvent)
    u.tap({ type: 'assistant_message', runId: R, content: '<spoken>You’re on main.</spoken>' } as unknown as AgentEvent)
    u.fire(ACK_MS)
    expect(u.spoken()).toEqual(['You’re on main.'])
  })

  it('stopped on an approval, words that aren’t the answer hear what it waits on', async () => {
    const t = setup()
    await t.session.start()
    t.session.follow(R)
    t.approvals()!.asked({ requestId: 'a1', runId: R, toolCallId: 't1', name: 'terminal', summary: 'pnpm test', argsPreview: '', timeoutMs: 0, mutating: true, alwaysAllowCommand: 'pnpm test' } as ToolApprovalRequest)
    await t.say('How long will it take?')
    expect(t.handOffs()).toEqual(['How long will it take?'])
    expect(t.spoken().at(-1)).toBe('I still need your yes or no first: can I run pnpm test?')
  })
})

describe('the run your turn started is followed from main (2026-10-16 02:41:42)', () => {
  it('follows it as main starts it, tells the window, and the window’s later word changes nothing', async () => {
    const t = setup()
    await t.session.start()
    await t.say('Research the fastest voice models.')
    const handOff = t.events.find((e) => e.kind === 'hand_off') as { handOffId: string }
    expect(t.session.spokenRunStarted('run-new')).toBe(true)
    expect(t.session.followedRunId).toBe('run-new')
    expect(t.events).toContainEqual(expect.objectContaining({ kind: 'followed', handOffId: handOff.handOffId, runId: 'run-new' }))
    // The window took 17 s to learn the run, then said it couldn't follow: no failure is said.
    const saidBefore = t.spoken().length
    t.session.handOffFailed(handOff.handOffId, 'unfollowed')
    expect(t.spoken()).toHaveLength(saidBefore)
    // And its own follow, late, doesn't start the turn again.
    const followedBefore = t.events.filter((e) => e.kind === 'followed').length
    t.session.follow('run-new', handOff.handOffId)
    expect(t.events.filter((e) => e.kind === 'followed')).toHaveLength(followedBefore)
    // Nothing waiting: a run started some other way isn't taken.
    expect(t.session.spokenRunStarted('run-other')).toBe(false)
  })

  it('a turn the task refused is still said to have failed', async () => {
    const t = setup()
    await t.session.start()
    await t.say('Run the tests.')
    const handOff = t.events.find((e) => e.kind === 'hand_off') as { handOffId: string }
    t.session.handOffFailed(handOff.handOffId, 'refused')
    expect(t.spoken().at(-1)).toBe('That didn’t go through: the task isn’t ready for it yet. The screen says why.')
    expect(t.session.spokenRunStarted('run-x')).toBe(false)
  })
})

describe('the agent reaches voice mode’s own controls', () => {
  it('mute until called: nothing is a turn until "Agent V", then what follows is', async () => {
    const t = setup()
    await t.session.start()
    t.session.link.controls.mute(true)
    expect(t.events).toContainEqual(expect.objectContaining({ kind: 'standby', on: true }))
    expect(t.session.link.muted).toBe('until_called')
    await t.say('Can you pass the salt?')
    expect(t.handOffs()).toEqual([])
    await t.say('Agent V, what time is it?')
    expect(t.handOffs()).toEqual(['what time is it?'])
    expect(t.events).toContainEqual(expect.objectContaining({ kind: 'standby', on: false }))
    expect(t.session.link.muted).toBeNull()
  })

  it('end waits for the run’s reply: the window is asked once the run is over', async () => {
    const t = setup()
    await t.session.start()
    t.session.follow(R)
    t.tap({ type: 'status', runId: R, status: 'running' } as AgentEvent)
    t.session.link.controls.end()
    expect(t.events.some((e) => e.kind === 'end_requested')).toBe(false)
    t.tap({ type: 'status', runId: R, status: 'done' } as AgentEvent)
    expect(t.events.filter((e) => e.kind === 'end_requested')).toHaveLength(1)

    const u = setup()
    await u.session.start()
    u.session.link.controls.end()
    expect(u.events.filter((e) => e.kind === 'end_requested')).toHaveLength(1)
  })

  it('tells app_status what the window shows', async () => {
    const t = setup()
    await t.session.start()
    t.session.setTask(R, 'C:/work/site', 'settings')
    expect(t.session.link.screen).toBe('settings')
    t.session.follow(R)
    expect(t.session.followedRunId).toBe(R)
  })
})

describe('being called by name', () => {
  it('"Agent V" at the start, with or without "hey"', () => {
    expect(afterWakeName('Agent V, what time is it?')).toBe('what time is it?')
    expect(afterWakeName('Hey Agent V.')).toBe('')
    expect(afterWakeName('agent vee open settings')).toBe('open settings')
    expect(afterWakeName('Can you pass the salt?')).toBeNull()
    // The V as listeners hear it (2026-10-15 live check).
    expect(afterWakeName('Agent B, what time is it?')).toBe('what time is it?')
    expect(afterWakeName('AgentV. What time is it?')).toBe('What time is it?')
    expect(afterWakeName('Agent five, open settings.')).toBe('open settings.')
    expect(afterWakeName('Agents are useful.')).toBeNull()
    expect(afterWakeName('The agent is done.')).toBeNull()
    expect(afterWakeName('Agent versus model.')).toBeNull()
    expect(afterWakeName('The agent version is old')).toBeNull()
  })
})
