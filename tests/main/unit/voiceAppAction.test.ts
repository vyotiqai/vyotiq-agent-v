/**
 * The voice acts in the app (batch 3, docs/voice-mode.md §24.15): its
 * app_action tool runs the app's actions, says how it went when the reply
 * didn't, never deletes without a spoken yes, waits to be called by name
 * when asked to, and can end itself.
 */
import { describe, expect, it, vi } from 'vitest'
import { APP_TOOL, RESPONDER_SYSTEM, RESPONDER_TOOLS, type ResponderChat, type ResponderChunk } from '@main/voice/responder'
import { VoiceSession } from '@main/voice/session'
import { openFixtureStt, type FixtureSttSession } from '@main/voice/providers/fixture'
import type { SttOpenOptions, TtsStream } from '@main/voice/providers/types'
import type { AppActionContext, AppActionResult } from '@main/appControl/runner'
import { afterWakeName, confirmsAction } from '@main/voice/speechText'
import { DEFAULT_VOICE_SETTINGS, type VoiceEvent } from '@shared/ipc/schemas/voice'

const tick = () => new Promise((r) => setTimeout(r, 0))
const silentTts = (): TtsStream =>
  ({ pushText: () => {}, flush: () => {}, end: () => {}, cancel: () => {}, done: () => Promise.resolve() }) as unknown as TtsStream

type Turn = { text?: string; call?: { action: string; args?: Record<string, unknown>; confirmed?: boolean } }

/** A voice model that answers each turn from a script, keyed by what was said. */
function setup(script: Record<string, Turn>, run: (name: string, args: unknown, ctx: AppActionContext) => Promise<AppActionResult>) {
  const heard: string[] = []
  const chat: ResponderChat = (req) => {
    const said = String(req.messages.at(-1)?.content ?? '')
    heard.push(said)
    const turn = script[said] ?? { text: 'Hmm.' }
    return (async function* (): AsyncGenerator<ResponderChunk> {
      if (turn.text) yield { type: 'text', text: turn.text }
      if (turn.call) yield { type: 'tool_call', name: APP_TOOL, arguments: JSON.stringify(turn.call) }
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
    newId: () => `id${++n}`
  })
  const say = async (text: string): Promise<void> => {
    stt.at(-1)!.say(text)
    for (let i = 0; i < 5; i++) await tick()
  }
  const spoken = (): string[] => events.flatMap((e) => (e.kind === 'say' ? [e.text] : []))
  return { session, say, spoken, events, heard }
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

  it('"Agent V" at the start, with or without "hey"', () => {
    expect(afterWakeName('Agent V, what time is it?')).toBe('what time is it?')
    expect(afterWakeName('Hey Agent V.')).toBe('')
    expect(afterWakeName('agent vee open settings')).toBe('open settings')
    expect(afterWakeName('Can you pass the salt?')).toBeNull()
    expect(afterWakeName('The agent version is old')).toBeNull()
  })
})
