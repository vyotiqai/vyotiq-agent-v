import { describe, expect, it, vi } from 'vitest'
import {
  FALLBACK_LINE,
  HAND_OFF_LINE,
  HAND_OFF_TOOL,
  STOP_LINE,
  STOP_TOOL,
  VoiceResponder,
  type ResponderChat,
  type ResponderChunk,
  type ResponderDeps
} from '@main/voice/responder'
import { VoiceSession, type VoiceSessionDeps } from '@main/voice/session'
import { SILENCE_MS } from '@main/voice/pauseDetector'
import { openFixtureStt, openFixtureTts, type FixtureSttSession, type FixtureTtsStream } from '@main/voice/providers/fixture'
import type { SttOpenOptions } from '@main/voice/providers/types'
import { DEFAULT_VOICE_SETTINGS, type VoiceEvent, type VoiceSettings } from '@shared/ipc/schemas/voice'
import type { AgentEvent, ChatMessage } from '@shared/ipc'

/**
 * A model under the test's control: each call waits until the test hands
 * it chunks, so "a second turn arrives before the first answer starts" is a
 * real ordering, not a guess.
 */
function fakeModel() {
  type Call = {
    messages: ChatMessage[]
    system: string
    status: string
    tools: unknown[]
    signal: AbortSignal
    push: (c: ResponderChunk) => void
    end: () => void
  }
  const calls: Call[] = []
  const chat: ResponderChat = (req) => {
    const queue: ResponderChunk[] = []
    let ended = false
    let wake: (() => void) | null = null
    const call: Call = {
      messages: req.messages,
      system: req.system,
      status: req.status,
      tools: req.tools,
      signal: req.signal,
      push: (c) => {
        queue.push(c)
        wake?.()
      },
      end: () => {
        ended = true
        wake?.()
      }
    }
    calls.push(call)
    return (async function* () {
      for (;;) {
        if (req.signal.aborted) return
        const next = queue.shift()
        if (next) {
          yield next
          continue
        }
        if (ended) return
        await new Promise<void>((r) => (wake = r))
        wake = null
      }
    })()
  }
  return { chat, calls }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function responder(over: Partial<ResponderDeps> = {}) {
  const model = fakeModel()
  const said: Array<{ contextId: string; text: string }> = []
  const tts: FixtureTtsStream[] = []
  const handOffs: string[] = []
  const done: Array<Parameters<ResponderDeps['done']>[0]> = []
  let n = 0
  const deps: ResponderDeps = {
    chat: () => model.chat,
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
    say: (contextId, text) => said.push({ contextId, text }),
    handOff: (brief) => handOffs.push(brief),
    stopAgent: vi.fn(),
    done: (r) => done.push(r),
    agentStatus: () => ({ working: false }),
    newId: () => `c${++n}`,
    now: () => 0,
    ...over
  }
  return { r: new VoiceResponder(deps), model, said, tts, handOffs, done, deps }
}

describe('the voice that answers (D-44)', () => {
  it('keeps an agent result that came before you said anything (it used to be dropped)', async () => {
    const h = responder()
    h.r.agentFinished('The tests pass: 42 of 42.')
    h.r.respond('What did it find?')
    await tick()
    const messages = h.model.calls[0]!.messages
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('user')
    expect(String(messages[0]!.content)).toContain('The tests pass: 42 of 42.')
    expect(String(messages[0]!.content)).toMatch(/What did it find\?$/)
  })

  it('speaks the answer sentence by sentence as it streams', async () => {
    const h = responder()
    h.r.respond('Hey, can you hear me?')
    await tick()
    h.model.calls[0]!.push({ type: 'text', text: 'Yes, I can hear you clearly. ' })
    h.model.calls[0]!.push({ type: 'text', text: 'What would you like to do?' })
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(h.done).toHaveLength(1))
    expect(h.said.map((s) => s.text)).toEqual(['Yes, I can hear you clearly.', 'What would you like to do?'])
    expect(h.tts[0]!.spoken).toEqual(['Yes, I can hear you clearly.', 'What would you like to do?'])
    expect(h.done[0]).toEqual({ audible: true, handedOff: false })
    expect(h.model.calls[0]!.messages).toEqual([{ role: 'user', content: 'Hey, can you hear me?' }])
  })

  it('hands work to the agent with the model’s brief, and says so', async () => {
    const h = responder()
    h.r.respond('Run the tests and tell me what fails.')
    await tick()
    h.model.calls[0]!.push({ type: 'text', text: 'On it, running them now.' })
    h.model.calls[0]!.push({ type: 'tool_call', name: HAND_OFF_TOOL, arguments: '{"brief":"Run the test suite and report failures."}' })
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(h.done).toHaveLength(1))
    expect(h.handOffs).toEqual(['Run the test suite and report failures.'])
    expect(h.done[0]).toEqual({ audible: true, handedOff: true })
  })

  it('a silent hand-off still says something, so you know it heard you', async () => {
    const h = responder()
    h.r.respond('Fix the lint errors.')
    await tick()
    h.model.calls[0]!.push({ type: 'tool_call', name: HAND_OFF_TOOL, arguments: '{"brief":"Fix the lint errors."}' })
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(h.done).toHaveLength(1))
    expect(h.said.map((s) => s.text)).toEqual([HAND_OFF_LINE])
  })

  it('what it says goes out before the work shows as handed over, as you hear it', async () => {
    const order: string[] = []
    const h = responder({ say: (_c, text) => order.push(`say ${text}`), handOff: (brief) => order.push(`hand_off ${brief}`) })
    h.r.respond('Fix the lint errors.')
    await tick()
    h.model.calls[0]!.push({ type: 'tool_call', name: HAND_OFF_TOOL, arguments: '{"brief":"Fix the lint errors."}' })
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(h.done).toHaveLength(1))
    // Its own short line, still held for a whole sentence, goes first too.
    h.r.respond('And check the branch.')
    await tick()
    h.model.calls[1]!.push({ type: 'text', text: 'Sure.' })
    h.model.calls[1]!.push({ type: 'tool_call', name: HAND_OFF_TOOL, arguments: '{"brief":"Check the branch."}' })
    h.model.calls[1]!.end()
    await vi.waitFor(() => expect(order).toHaveLength(4))
    expect(order).toEqual([`say ${HAND_OFF_LINE}`, 'hand_off Fix the lint errors.', 'say Sure.', 'hand_off Check the branch.'])
  })

  it('“stop it” stops the work and says so', async () => {
    const h = responder()
    h.r.respond('Stop what you are doing please.')
    await tick()
    h.model.calls[0]!.push({ type: 'tool_call', name: STOP_TOOL, arguments: '{}' })
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(h.done).toHaveLength(1))
    expect(h.deps.stopAgent).toHaveBeenCalledTimes(1)
    expect(h.said.map((s) => s.text)).toEqual([STOP_LINE])
  })

  it('words that follow before the answer starts join the same turn (D-43)', async () => {
    const h = responder()
    h.r.respond('Hello.')
    await tick()
    expect(h.r.pendingUnspoken).toBe(true)
    h.r.respond('Can you hear me?')
    await tick()
    expect(h.model.calls[0]!.signal.aborted).toBe(true)
    expect(h.model.calls[1]!.messages.at(-1)).toEqual({ role: 'user', content: 'Hello. Can you hear me?' })
  })

  it('a barge-in cuts the answer off and remembers what was said', async () => {
    const h = responder()
    h.r.respond('Explain the failure.')
    await tick()
    h.model.calls[0]!.push({ type: 'text', text: 'The build broke on a missing import. And then' })
    await vi.waitFor(() => expect(h.said).toHaveLength(1))
    expect(h.r.interrupt()).toBe('c1')
    expect(h.tts[0]!.cancelled).toBe(true)
    h.r.respond('Which file?')
    await tick()
    expect(h.model.calls[1]!.messages).toEqual([
      { role: 'user', content: 'Explain the failure.' },
      { role: 'assistant', content: 'The build broke on a missing import. (cut off)' },
      { role: 'user', content: 'Which file?' }
    ])
  })

  it('the agent’s spoken result joins the conversation, and its work is in the context', async () => {
    let working = false
    const h = responder({ agentStatus: () => ({ working, brief: 'Run the tests.', since: 0 }) })
    h.r.respond('Run the tests.')
    await tick()
    h.model.calls[0]!.push({ type: 'tool_call', name: HAND_OFF_TOOL, arguments: '{"brief":"Run the tests."}' })
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(h.done).toHaveLength(1))
    working = true
    h.r.agentSaid('All 120 tests pass.')
    h.r.agentSaid('Nothing failed.')
    h.r.respond('What did it find?')
    await tick()
    expect(h.model.calls[1]!.messages.slice(-2)).toEqual([
      { role: 'assistant', content: `${HAND_OFF_LINE} (handed to the agent)\nThe agent reported: All 120 tests pass. Nothing failed.` },
      { role: 'user', content: 'What did it find?' }
    ])
    expect(h.model.calls[1]!.status).toContain('The agent is working now on: Run the tests (for 0 seconds).')
    // The fixed instructions are the same bytes every turn, for the provider's cache.
    expect(h.model.calls[1]!.system).toBe(h.model.calls[0]!.system)
  })

  it('knows what the agent is doing right now, and how its last run ended (B6)', async () => {
    let status: ReturnType<ResponderDeps['agentStatus']> = {
      working: true,
      brief: 'List every session.',
      since: 0,
      steps: 7,
      current: 'run_terminal: git for-each-ref',
      narration: 'Now the worktrees.'
    }
    const h = responder({ agentStatus: () => status, now: () => 95_000 })
    h.r.respond('Why is it taking so long?')
    await tick()
    const line = h.model.calls[0]!.status
    expect(line).toContain('(for 1 minutes 35 seconds)')
    expect(line).toContain('It has taken 7 steps.')
    expect(line).toContain('Right now it is running: run_terminal: git for-each-ref.')
    expect(line).toContain('Now the worktrees.')
    expect(h.model.calls[0]!.system).toContain('never call hand_to_agent for them')
    h.model.calls[0]!.push({ type: 'text', text: 'It is busy.' })
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(h.done).toHaveLength(1))
    status = { working: false, brief: 'List every session.', steps: 9, ended: { at: 90_000, outcome: 'done' } }
    h.r.respond('Is it done?')
    await tick()
    expect(h.model.calls[1]!.status).toBe('The agent is idle. Its last task was: List every session. It finished 5 seconds ago. It has taken 9 steps.')
    h.model.calls[1]!.push({ type: 'text', text: 'It is busy.' })
    h.model.calls[1]!.end()
    await vi.waitFor(() => expect(h.done).toHaveLength(2))
    // Blocked on you: that, not the step it stopped at, is what "how's it going?" needs.
    status = { working: true, brief: 'Check the branch.', current: 'git_status', waitingOn: 'Run the workspace hooks? Run them or Don’t run them.' }
    h.r.respond('How is it going?')
    await tick()
    const blocked = h.model.calls[2]!.status
    expect(blocked).toContain('The agent is working now on: Check the branch.')
    expect(blocked).toContain('It is stopped until you answer: Run the workspace hooks?')
    expect(blocked).not.toContain('git_status')
  })

  it('reports the agent’s answer in its own words, with no tools, and keeps it for follow-ups (B5, B7)', async () => {
    const h = responder()
    h.r.agentFinished(['**Sessions**', '| Session | Status |', '| --- | --- |', '| This chat | done |'].join('\n'))
    expect(h.r.reportResult()).toBe(true)
    await tick()
    const call = h.model.calls[0]!
    expect(call.tools).toEqual([])
    expect(call.messages.at(-1)!.content).toContain('| This chat | done |')
    expect(call.messages.at(-1)!.content).toContain('Not the user speaking')
    call.push({ type: 'text', text: 'It found one session, this chat, and it’s done.' })
    call.end()
    await vi.waitFor(() => expect(h.done).toHaveLength(1))
    expect(h.said.map((s) => s.text).join(' ')).toBe('It found one session, this chat, and it’s done.')
    h.r.respond('Which one was it?')
    await tick()
    const history = h.model.calls[1]!.messages
    expect(history[0]!.content).toContain('| This chat | done |')
    expect(history.at(-1)).toEqual({ role: 'user', content: 'Which one was it?' })
  })

  it('a report waits for the answer you’re hearing, then follows it', async () => {
    const h = responder()
    h.r.respond('How long will it take?')
    await tick()
    h.r.agentFinished('All tests pass.')
    expect(h.r.reportResult()).toBe(true)
    expect(h.model.calls).toHaveLength(1)
    h.model.calls[0]!.push({ type: 'text', text: 'Not long now. ' })
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(h.model.calls).toHaveLength(2))
    expect(h.model.calls[1]!.messages.at(-1)!.content).toContain('All tests pass.')
  })

  it('without a voice model, a report is not taken (the agent’s summary is read instead)', () => {
    const h = responder({ chat: () => null })
    h.r.agentFinished('All tests pass.')
    expect(h.r.reportResult()).toBe(false)
  })

  it('without a usable voice model, what you said goes to the agent as it is', () => {
    const h = responder({ chat: () => null })
    h.r.respond('Add a dark mode toggle.')
    expect(h.handOffs).toEqual(['Add a dark mode toggle.'])
    expect(h.done).toEqual([{ audible: false, handedOff: true }])
  })

  it('a failed model call still gets the work done: it says so and hands the words over', async () => {
    const h = responder()
    h.r.respond('Update the readme.')
    await tick()
    h.model.calls[0]!.push({ type: 'error', message: 'OpenRouter (402): Insufficient credits' })
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(h.done).toHaveLength(1))
    expect(h.said.map((s) => s.text)).toEqual([FALLBACK_LINE])
    expect(h.handOffs).toEqual(['Update the readme.'])
    expect(h.done[0]).toMatchObject({ handedOff: true, failed: { message: 'OpenRouter (402): Insufficient credits' } })
  })

  it('with nothing able to speak, the answer still shows as captions and nothing waits on audio', async () => {
    const h = responder({ openTts: () => null })
    h.r.respond('Hi.')
    await tick()
    h.model.calls[0]!.push({ type: 'text', text: 'Hi there, what’s next?' })
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(h.done).toHaveLength(1))
    expect(h.said.map((s) => s.text)).toEqual(['Hi there, what’s next?'])
    expect(h.done[0]).toEqual({ audible: false, handedOff: false })
  })
})

// ── In the session ─────────────────────────────────────────────────────────

function tone(ms: number, amp = 8000): Int16Array {
  const n = Math.round((ms / 1000) * 16000)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin(i / 3) * amp)
  return out
}
const silence = (ms: number) => new Int16Array(Math.round((ms / 1000) * 16000))

function sessionHarness(over: Partial<VoiceSettings> = {}) {
  const model = fakeModel()
  const events: VoiceEvent[] = []
  const stt: FixtureSttSession[] = []
  const tts: FixtureTtsStream[] = []
  let tap: ((e: AgentEvent) => void) | null = null
  let n = 0
  const settings: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS, ...over }
  const deps: VoiceSessionDeps = {
    emit: (e) => events.push(e),
    settings: () => settings,
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
    tapRun: (_runId, fn) => {
      tap = fn
      return () => (tap = null)
    },
    responder: () => model.chat,
    setTimer: () => null,
    clearTimer: () => {},
    newId: () => `id${++n}`
  }
  const session = new VoiceSession(deps)
  const states = () => events.flatMap((e) => (e.kind === 'state' ? [e.state] : []))
  return { session, events, model, stt: () => stt.at(-1)!, tts, tap: () => tap, states }
}

describe('the voice in a session', () => {
  it('a turn goes to the voice, not the agent; nothing reaches the agent without a hand-off', async () => {
    const h = sessionHarness({ sttProvider: 'openrouter' })
    await h.session.start()
    h.stt().say('How are you?')
    await tick()
    expect(h.model.calls).toHaveLength(1)
    expect(h.events.some((e) => e.kind === 'hand_off')).toBe(false)
    h.model.calls[0]!.push({ type: 'tool_call', name: HAND_OFF_TOOL, arguments: '{"brief":"Check the build."}' })
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(h.events).toContainEqual(expect.objectContaining({ kind: 'hand_off', brief: 'Check the build.' })))
  })

  it('tells the window each caption has audio coming, so it waits to be heard', async () => {
    const h = sessionHarness({ sttProvider: 'openrouter' })
    await h.session.start()
    h.stt().say('How are you?')
    await tick()
    h.model.calls[0]!.push({ type: 'text', text: 'Doing well, thanks for asking. ' })
    await vi.waitFor(() => expect(h.events.some((e) => e.kind === 'say')).toBe(true))
    expect(h.events.find((e) => e.kind === 'say')).toMatchObject({ text: 'Doing well, thanks for asking.', audible: true })
  })

  it('a failed run’s own reason reaches the voice, so “why did it stop?” has an answer', async () => {
    const h = sessionHarness({ sttProvider: 'openrouter' })
    await h.session.start()
    h.session.follow('r1', 'h1')
    const run = h.tap()!
    run({ type: 'status', runId: 'r1', status: 'running' } as AgentEvent)
    run({
      type: 'error',
      runId: 'r1',
      message: 'Prompt tokens limit exceeded: 133397 > 4780. Add more credits.',
      code: 'PROVIDER_BILLING'
    } as AgentEvent)
    run({ type: 'status', runId: 'r1', status: 'error' } as AgentEvent)
    expect(h.events).toContainEqual(expect.objectContaining({ kind: 'say', text: expect.stringContaining('out of credit') }))
    h.stt().say('Why did it stop?')
    await tick()
    const context = h.model.calls.at(-1)!.messages.map((m) => String(m.content)).join('\n')
    expect(context).toContain('It stopped with an error: Prompt tokens limit exceeded')
  })

  it('words that arrive while it’s still thinking are never dropped (the lost “Can you hear me?”)', async () => {
    const h = sessionHarness({ sttProvider: 'openrouter' })
    await h.session.start()
    h.stt().say('Hello.')
    expect(h.session.state).toBe('thinking')
    // The next sentence's transcript lands while the first answer hasn't started.
    h.stt().say('Can you hear me?')
    await tick()
    const turns = h.events.filter((e) => e.kind === 'turn').map((e) => (e as { text: string }).text)
    expect(turns).toEqual(['Hello.', 'Can you hear me?'])
    expect(h.model.calls.at(-1)!.messages.at(-1)).toEqual({ role: 'user', content: 'Hello. Can you hear me?' })
  })

  it('talking while it speaks stops its voice and answers the new words', async () => {
    const h = sessionHarness()
    await h.session.start()
    h.stt().say('Tell me about the change.')
    await tick()
    h.model.calls[0]!.push({ type: 'text', text: 'It renames the parser and updates two tests. ' })
    await vi.waitFor(() => expect(h.events.some((e) => e.kind === 'say')).toBe(true))
    const contextId = (h.events.find((e) => e.kind === 'say') as { contextId: string }).contextId
    h.session.playback(contextId, 'started')
    expect(h.session.state).toBe('speaking')
    h.stt().say('wait, which tests')
    await tick()
    expect(h.events).toContainEqual(expect.objectContaining({ kind: 'flush', contextId }))
    expect(h.tts[0]!.cancelled).toBe(true)
    expect(h.model.calls).toHaveLength(2)
  })

  it('a cough while the answer is worked out neither stops nor restarts it (B2); what it held is said after', async () => {
    const h = sessionHarness()
    await h.session.start()
    h.stt().say('What changed today?')
    await tick()
    expect(h.session.state).toBe('thinking')
    // The sound starts: the answer goes on, but says nothing while you might be talking.
    h.stt().say('', false)
    h.model.calls[0]!.push({ type: 'text', text: 'Two commits landed this morning. ' })
    await tick()
    expect(h.events.some((e) => e.kind === 'say')).toBe(false)
    // It was a cough: one model call, never aborted, and the held words come out.
    h.stt().endTurn()
    await tick()
    expect(h.model.calls).toHaveLength(1)
    expect(h.model.calls[0]!.signal.aborted).toBe(false)
    expect(h.events).toContainEqual(expect.objectContaining({ kind: 'say', text: 'Two commits landed this morning.' }))
  })

  it('words said over an answer not yet spoken still join the same turn (D-43)', async () => {
    const h = sessionHarness()
    await h.session.start()
    h.stt().say('What changed today?')
    await tick()
    h.stt().say('', false)
    h.model.calls[0]!.push({ type: 'text', text: 'Two commits landed. ' })
    await tick()
    h.stt().say('In the voice code.')
    await tick()
    expect(h.model.calls).toHaveLength(2)
    expect(h.model.calls[0]!.signal.aborted).toBe(true)
    expect(h.model.calls[1]!.messages.at(-1)).toEqual({ role: 'user', content: 'What changed today? In the voice code.' })
    expect(h.events.some((e) => e.kind === 'say')).toBe(false)
  })

  it('a filler a listener invents from noise is not a turn', async () => {
    const h = sessionHarness()
    await h.session.start()
    h.stt().say('Um.')
    await tick()
    expect(h.events.some((e) => e.kind === 'turn')).toBe(false)
    expect(h.model.calls).toHaveLength(0)
    expect(h.session.state).toBe('listening')
  })

  it('“stop” needs no model: the work stops at once', async () => {
    const h = sessionHarness()
    await h.session.start()
    h.stt().say('Run the tests.')
    await tick()
    h.model.calls[0]!.push({ type: 'tool_call', name: HAND_OFF_TOOL, arguments: '{"brief":"Run the tests."}' })
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(h.events.some((e) => e.kind === 'hand_off')).toBe(true))
    h.session.follow('run1')
    h.tap()!({ type: 'status', runId: 'run1', status: 'running' } as AgentEvent)
    h.stt().say('Stop.')
    expect(h.events).toContainEqual(expect.objectContaining({ kind: 'stop_agent' }))
    expect(h.model.calls).toHaveLength(1)
  })

  it('after “On it.” it follows the agent’s work, then speaks its result', async () => {
    const h = sessionHarness()
    await h.session.start()
    h.stt().say('Run the tests.')
    await tick()
    h.model.calls[0]!.push({ type: 'tool_call', name: HAND_OFF_TOOL, arguments: '{"brief":"Run the tests."}' })
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(h.events.some((e) => e.kind === 'say')).toBe(true))
    const onIt = (h.events.find((e) => e.kind === 'say') as { contextId: string }).contextId
    h.session.playback(onIt, 'started')
    h.session.playback(onIt, 'drained')
    expect(h.session.state).toBe('listening')
    h.session.follow('run1')
    h.tap()!({ type: 'status', runId: 'run1', status: 'running' } as AgentEvent)
    h.tap()!({ type: 'tool_start', runId: 'run1', toolCallId: 't1', name: 'terminal', summary: 'pnpm test' } as AgentEvent)
    expect(h.session.state).toBe('working')
    h.tap()!({ type: 'text_delta', runId: 'run1', text: '<spoken>All tests pass.</spoken>' } as AgentEvent)
    h.tap()!({ type: 'assistant_message', runId: 'run1', content: '<spoken>All tests pass.</spoken>' } as AgentEvent)
    const said = h.events.filter((e) => e.kind === 'say').map((e) => (e as { text: string }).text)
    expect(said).toContain('All tests pass.')
  })

  it('with nothing able to speak, the session goes back to listening after the answer', async () => {
    const h = sessionHarness()
    await h.session.start()
    // Replace the speaker: none usable.
    ;(h.session as unknown as { deps: VoiceSessionDeps }).deps.openTts = () => null
    h.stt().say('Hi.')
    await tick()
    h.model.calls[0]!.push({ type: 'text', text: 'Hi, what’s next?' })
    h.model.calls[0]!.end()
    await vi.waitFor(() => expect(h.session.state).toBe('listening'))
  })

  it('a whole-turn listener’s transcript arriving mid-sentence doesn’t restart the pause detector (D-43)', async () => {
    const h = sessionHarness({ sttProvider: 'openrouter' })
    await h.session.start()
    const started = vi.fn()
    ;(h.stt() as { speechStarted?: () => void }).speechStarted = started
    const endTurn = vi.spyOn(h.stt(), 'endTurn')
    h.session.pushAudio(tone(500))
    h.session.pushAudio(silence(SILENCE_MS.normal + 100))
    expect(endTurn).toHaveBeenCalledTimes(1)
    // You're already saying the next sentence when the first transcript lands.
    h.session.pushAudio(tone(400))
    expect(started).toHaveBeenCalledTimes(2)
    // The agent hasn't spoken: the listener may keep its full lead-in.
    expect(started.mock.calls[0]).toEqual([{ leadInMs: Number.POSITIVE_INFINITY }])
    h.stt()['emit']({ kind: 'end_of_turn', text: 'Hello.' })
    h.session.pushAudio(tone(400))
    // Still the same sentence: no new speech start, so its first words aren't trimmed away.
    expect(started).toHaveBeenCalledTimes(2)
  })
})
