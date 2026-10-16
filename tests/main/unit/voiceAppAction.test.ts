/**
 * The voice acts in the app (batch 3, docs/voice-mode.md §24.15): its
 * app_action tool runs the app's actions, says how it went when the reply
 * didn't, never deletes without a spoken yes, waits to be called by name
 * when asked to, and can end itself.
 */
import { describe, expect, it, vi } from 'vitest'
import { APP_TOOL, HAND_OFF_TOOL, NEEDS_YES_LINE, RESPONDER_SYSTEM, RESPONDER_TOOLS, type ResponderChat, type ResponderChunk } from '@main/voice/responder'
import { VoiceSession } from '@main/voice/session'
import { openFixtureStt, type FixtureSttSession } from '@main/voice/providers/fixture'
import type { SttOpenOptions, TtsStream } from '@main/voice/providers/types'
import type { AppActionContext, AppActionResult } from '@main/appControl/runner'
import { afterWakeName, asksToCommitOrPush, confirmsAction } from '@main/voice/speechText'
import { DEFAULT_VOICE_SETTINGS, type VoiceEvent } from '@shared/ipc/schemas/voice'

const tick = () => new Promise((r) => setTimeout(r, 0))
const silentTts = (): TtsStream =>
  ({ pushText: () => {}, flush: () => {}, end: () => {}, cancel: () => {}, done: () => Promise.resolve() }) as unknown as TtsStream

type Turn = { text?: string; call?: { action: string; args?: Record<string, unknown>; confirmed?: boolean }; handOff?: { brief: string; confirmed?: boolean } }

/** A voice model that answers each turn from a script, keyed by what was said. */
function setup(
  script: Record<string, Turn>,
  run: (name: string, args: unknown, ctx: AppActionContext) => Promise<AppActionResult>,
  extra: Partial<ConstructorParameters<typeof VoiceSession>[0]> = {}
) {
  const heard: string[] = []
  const histories: Array<Array<{ role: string; content: unknown }>> = []
  const chat: ResponderChat = (req) => {
    const said = String(req.messages.at(-1)?.content ?? '')
    heard.push(said)
    histories.push(req.messages.map((m) => ({ role: m.role, content: m.content })))
    const turn = script[said] ?? { text: 'Hmm.' }
    return (async function* (): AsyncGenerator<ResponderChunk> {
      if (turn.text) yield { type: 'text', text: turn.text }
      if (turn.call) yield { type: 'tool_call', name: APP_TOOL, arguments: JSON.stringify(turn.call) }
      if (turn.handOff) yield { type: 'tool_call', name: HAND_OFF_TOOL, arguments: JSON.stringify(turn.handOff) }
      yield { type: 'done', usage: { inputTokens: 10, outputTokens: 2 } }
    })()
  }
  const events: VoiceEvent[] = []
  const stt: FixtureSttSession[] = []
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
    responder: () => chat,
    runAppAction: run,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    newId: () => `id${++n}`,
    ...extra
  })
  const say = async (text: string): Promise<void> => {
    stt.at(-1)!.say(text)
    for (let i = 0; i < 5; i++) await tick()
  }
  const spoken = (): string[] => events.flatMap((e) => (e.kind === 'say' ? [e.text] : []))
  return { session, say, spoken, events, heard, histories }
}

describe('app_action', () => {
  it('is one of the voice’s tools, and the prompt sends app things to it, not to the agent', () => {
    expect(RESPONDER_TOOLS.map((t) => t.name)).toContain(APP_TOOL)
    expect(RESPONDER_SYSTEM).toContain(`do them with ${APP_TOOL}, never hand them to the agent`)
  })

  it('runs the action with the task on screen, and says how it went when the reply said nothing', async () => {
    const run = vi.fn(async () => ({ ok: true, message: 'The theme is dark now.' }))
    const t = setup({ 'Switch to dark mode.': { call: { action: 'set_theme', args: { theme: 'dark' } } } }, run)
    await t.session.start()
    t.session.setTask('run-1', 'C:/work')
    await t.say('Switch to dark mode.')
    await vi.waitFor(() => expect(run).toHaveBeenCalled())
    expect(run).toHaveBeenCalledWith('set_theme', { theme: 'dark' }, expect.objectContaining({ who: 'voice', runId: 'run-1', workspacePath: 'C:/work' }))
    await vi.waitFor(() => expect(t.spoken()).toEqual(['The theme is dark now.']))
    expect(t.events.find((e) => e.kind === 'unanswered')).toBeUndefined()
  })

  it('a reply that said it is on it isn’t repeated; a failure is said', async () => {
    const run = vi.fn(async (name: string) => (name === 'open_view' ? { ok: true, message: 'Here’s Home.' } : { ok: false, message: 'No task matches “billing”.' }))
    const t = setup(
      {
        'Go home.': { text: 'Sure.', call: { action: 'open_view', args: { view: 'home' } } },
        'Open the billing task.': { text: 'Opening it.', call: { action: 'open_task', args: { task: 'billing' } } }
      },
      run
    )
    await t.session.start()
    await t.say('Go home.')
    await vi.waitFor(() => expect(t.spoken()).toEqual(['Sure.']))
    await t.say('Open the billing task.')
    await vi.waitFor(() => expect(t.spoken()).toEqual(['Sure.', 'Opening it.', 'No task matches “billing”.']))
  })

  it('its reasoning about "the user" is never said, and the result is (2026-10-16 live check)', async () => {
    const run = vi.fn(async () => ({ ok: true, message: 'Forked “Say hello”; the copy is open.' }))
    const t = setup(
      {
        'Make a fork of the hello task.': {
          text: 'The user wants a fork of the hello task. The on-screen task is "Say hello," and the user named "the hello task," which matches it, so I\'ll fork the task on screen.',
          call: { action: 'fork_task', args: {} }
        },
        'What did it change?': { text: 'It now sends the user to the login page when the session ends.' }
      },
      run
    )
    await t.session.start()
    await t.say('Make a fork of the hello task.')
    await vi.waitFor(() => expect(t.spoken()).toEqual(['Forked “Say hello”; the copy is open.']))
    // What the code does to a user is an answer, not reasoning about you.
    await t.say('What did it change?')
    await vi.waitFor(() => expect(t.spoken().at(-1)).toBe('It now sends the user to the login page when the session ends.'))
  })

  it('a sentence naming its own action is never said, and the result is; plain words like "find" still are (2026-10-16 live check)', async () => {
    const run = vi.fn(async () => ({ ok: true, message: 'Split: there’s room for another task beside it.' }))
    const t = setup(
      {
        'Split the screen.': { text: 'That’s an app action: split_pane runs on the task on screen.', call: { action: 'run_command', args: { command: 'split_pane' } } },
        'Where is it?': { text: 'I couldn’t find it.' }
      },
      run
    )
    await t.session.start()
    await t.say('Split the screen.')
    await vi.waitFor(() => expect(t.spoken()).toEqual(['Split: there’s room for another task beside it.']))
    await t.say('Where is it?')
    await vi.waitFor(() => expect(t.spoken().at(-1)).toBe('I couldn’t find it.'))
  })

  it('never deletes on its own say-so: only after the user’s yes', async () => {
    const run = vi.fn(async () => ({ ok: true, message: 'Deleted it.' }))
    const t = setup(
      {
        // A model that skips the question: refused.
        'Delete the login task.': { call: { action: 'delete_task', args: { task: 'login' }, confirmed: true } },
        'Yes, delete it.': { call: { action: 'delete_task', args: { task: 'login' }, confirmed: true } }
      },
      run
    )
    await t.session.start()
    await t.say('Delete the login task.')
    await vi.waitFor(() => expect(t.spoken()).toEqual(['That needs your yes first. Should I go ahead?']))
    expect(run).not.toHaveBeenCalled()
    await t.say('Yes, delete it.')
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith('delete_task', { task: 'login' }, expect.anything()))
  })

  it('never commits or pushes on its own say-so: the brief goes only after a yes to it (§24.16)', async () => {
    const run = vi.fn(async () => ({ ok: true, message: '' }))
    const t = setup(
      {
        // Straight to the agent, no question asked: held, and the question is asked instead.
        'Commit and push the fix.': { text: 'Committing it now.', handOff: { brief: 'Commit the fix and push it to main.', confirmed: true } },
        'Yes, push it.': { handOff: { brief: 'Commit the fix and push it to main.', confirmed: true } },
        // Not a commit: no question.
        'What changed in the last commit?': { handOff: { brief: 'Summarise what changed in the last commit.' } }
      },
      run
    )
    const handOffs = (): string[] => t.events.flatMap((e) => (e.kind === 'hand_off' ? [e.brief] : []))
    await t.session.start()
    await t.say('Commit and push the fix.')
    await vi.waitFor(() => expect(t.spoken().join(' ')).toContain(NEEDS_YES_LINE))
    expect(handOffs()).toEqual([])
    await t.say('Yes, push it.')
    await vi.waitFor(() => expect(handOffs()).toEqual(['Commit the fix and push it to main.']))
    await t.say('What changed in the last commit?')
    await vi.waitFor(() => expect(handOffs()).toHaveLength(2))
    expect(RESPONDER_SYSTEM).toContain('Committing or pushing code needs the user')
  })

  it('the commit question is heard even after three sentences of its own (the cap would caption it)', async () => {
    // What the speaking model was given: words past the cap are only a caption, never sent to it.
    const voiced: string[] = []
    const recording = { pushText: (s: string) => voiced.push(s.trim()), flush: () => {}, end: () => {}, cancel: () => {}, done: () => Promise.resolve() }
    const t = setup(
      { 'Push it all.': { text: 'Okay. I see three changes. They look ready. ', handOff: { brief: 'Commit everything and push it.', confirmed: true } } },
      vi.fn(async () => ({ ok: true, message: '' })),
      { openTts: () => recording as unknown as ReturnType<NonNullable<ConstructorParameters<typeof VoiceSession>[0]['openTts']>> }
    )
    await t.session.start()
    await t.say('Push it all.')
    await vi.waitFor(() => expect(voiced.join(' ')).toContain('Should I go ahead?'))
    expect(voiced).toEqual(['Okay.', 'I see three changes.', 'They look ready.', ...NEEDS_YES_LINE.split(/(?<=\.) /)])
  })

  it('the voice model’s spend is charged to the task it is on, not where the session opened (W-04)', async () => {
    const usage = vi.fn()
    const t = setup({ 'Hello.': { text: 'Hi.' } }, vi.fn(), { onResponderUsage: usage })
    await t.session.start()
    t.session.setTask('run-9', 'C:/work/site')
    await t.say('Hello.')
    await vi.waitFor(() => expect(usage).toHaveBeenCalled())
    expect(usage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 10 }), { runId: 'run-9', workspacePath: 'C:/work/site' })
  })

  it('muted until called: nothing is a turn until "Agent V", then what follows is', async () => {
    const t = setup(
      {
        'Mute until I call you.': { text: 'Okay.', call: { action: 'voice_mute', args: { until: 'called' } } },
        'what time is it?': { text: 'Seven.' }
      },
      async (_name, _args, ctx) => {
        ctx.voice?.mute(true)
        return { ok: true, message: 'Say “Agent V” when you need me.' }
      }
    )
    await t.session.start()
    await t.say('Mute until I call you.')
    await vi.waitFor(() => expect(t.events).toContainEqual(expect.objectContaining({ kind: 'standby', on: true })))
    await t.say('Can you pass the salt?')
    await new Promise((r) => setTimeout(r, 50))
    expect(t.heard).toEqual(['Mute until I call you.'])
    await t.say('Agent V, what time is it?')
    await vi.waitFor(() => expect(t.heard.at(-1)).toBe('what time is it?'))
    expect(t.events).toContainEqual(expect.objectContaining({ kind: 'standby', on: false }))
    // Answered, not "I'm muted": the voice is told it was called (2026-10-15 live check).
    await vi.waitFor(() => expect(t.spoken()).toContain('Seven.'))
    expect(t.histories.at(-1)!.some((m) => m.role === 'assistant' && String(m.content).includes('called me by name'))).toBe(true)
  })

  it('a tool name written as words is never said (2026-10-15 live check: "stay_quiet." was spoken)', async () => {
    const t = setup({ 'Hmm, okay then.': { text: 'stay_quiet.' }, 'Open home.': { text: '`app_action`' } }, vi.fn())
    await t.session.start()
    await t.say('Hmm, okay then.')
    await t.say('Open home.')
    await new Promise((r) => setTimeout(r, 100))
    expect(t.spoken().join(' ')).not.toMatch(/stay_quiet|app_action/)
  })

  it('"end voice mode" asks the window to end it', async () => {
    const t = setup({ 'That’s all, bye.': { call: { action: 'voice_end' } } }, async (_n, _a, ctx) => {
      ctx.voice?.end()
      return { ok: true, message: 'Bye for now.' }
    })
    await t.session.start()
    await t.say('That’s all, bye.')
    await vi.waitFor(() => expect(t.spoken()).toEqual(['Bye for now.']))
    expect(t.events).toContainEqual(expect.objectContaining({ kind: 'end_requested' }))
  })
})

describe('what counts as a yes, and as being called', () => {
  it('a yes that takes nothing back', () => {
    for (const yes of ['Yes.', 'Yeah, go ahead.', 'Sure, delete it.', 'Do it.']) expect(confirmsAction(yes)).toBe(true)
    for (const no of ['No.', 'Yes, but not that one.', 'Wait.', 'Delete the login task.']) expect(confirmsAction(no)).toBe(false)
  })

  it('a brief that asks for a commit or a push, not one that only mentions them', () => {
    expect(asksToCommitOrPush('Commit and push the fix.')).toBe(true)
    expect(asksToCommitOrPush('push it to main')).toBe(true)
    expect(asksToCommitOrPush('Stage the files and commit them.')).toBe(true)
    expect(asksToCommitOrPush('What changed in the last commit?')).toBe(false)
    expect(asksToCommitOrPush('Write a better commit message generator.')).toBe(false)
    expect(asksToCommitOrPush('Fix the push notifications.')).toBe(false)
    expect(asksToCommitOrPush('Run the tests.')).toBe(false)
    // The request itself is never its own yes.
    expect(confirmsAction('Commit and push the fix.')).toBe(false)
  })

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
