/**
 * The eighth voice audit (2026-10-15, from Ajay's kept conversation
 * 2026-10-15T11-17-59): the voice said "Stopping it." twice and the run went
 * on for another 70 s. No `Chat cancel` reached main: the stop went through
 * the task's composer, which dropped it. A noise in the room also held the
 * voice's stop for 7 s, and "Cancel it." wasn't a stop phrase at all.
 */
import { describe, expect, it, vi } from 'vitest'
import { STOP_TOOL, type ResponderChat, type ResponderChunk } from '@main/voice/responder'
import { VoiceSession, type VoiceSessionDeps } from '@main/voice/session'
import { isStopPhrase } from '@main/voice/speechText'
import { openFixtureStt, type FixtureSttSession } from '@main/voice/providers/fixture'
import type { SttOpenOptions, TtsStream } from '@main/voice/providers/types'
import { DEFAULT_VOICE_SETTINGS, type VoiceEvent } from '@shared/ipc/schemas/voice'

function fakeModel() {
  const calls: Array<{ push: (c: ResponderChunk) => void; end: () => void }> = []
  const chat: ResponderChat = (req) => {
    const queue: ResponderChunk[] = []
    let ended = false
    let wake: (() => void) | null = null
    calls.push({
      push: (c) => {
        queue.push(c)
        wake?.()
      },
      end: () => {
        ended = true
        wake?.()
      }
    })
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

function silentTts(): TtsStream {
  return { pushText: () => {}, flush: () => {}, end: () => {}, cancel: () => {}, done: () => Promise.resolve() } as unknown as TtsStream
}

function harness(deps: Partial<VoiceSessionDeps> = {}) {
  const model = fakeModel()
  const events: VoiceEvent[] = []
  const stt: FixtureSttSession[] = []
  let n = 0
  const cancelRun = vi.fn(() => true)
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
    responder: () => model.chat,
    tapRun: () => () => {},
    cancelRun,
    setTimer: () => null,
    clearTimer: () => {},
    newId: () => `id${++n}`,
    ...deps
  })
  return { session, events, model, stt: () => stt.at(-1)!, cancelRun }
}

describe('a spoken stop reaches the run itself', () => {
  it('"Stop." cancels the followed run in main, without going through the window', async () => {
    let tap: ((ev: unknown) => void) | null = null
    const h = harness({ tapRun: (_id, fn) => ((tap = fn as typeof tap), () => {}) })
    await h.session.start()
    h.session.follow('run-1')
    tap!({ type: 'status', status: 'running' })
    h.stt().say('Stop.')
    await tick()
    expect(h.cancelRun).toHaveBeenCalledWith('run-1')
    // Main stopped it: the window isn't asked to as well (its Stop can wait on a confirm dialog).
    expect(h.events.some((e) => e.kind === 'stop_agent')).toBe(false)
  })

  it('the voice model’s stop_agent cancels the followed run in main', async () => {
    let tap: ((ev: unknown) => void) | null = null
    const h = harness({ tapRun: (_id, fn) => ((tap = fn as typeof tap), () => {}) })
    await h.session.start()
    h.session.follow('run-1')
    tap!({ type: 'status', status: 'running' })
    h.stt().say('I told it to stop it.')
    await tick()
    h.model.calls[0]!.push({ type: 'tool_call', name: STOP_TOOL, arguments: '{}' })
    await tick()
    expect(h.cancelRun).toHaveBeenCalledWith('run-1')
  })

  it('with no run main can stop, the window is asked instead', async () => {
    const h = harness({ cancelRun: () => false })
    await h.session.start()
    h.stt().say('Please stop the work now.')
    await tick()
    h.model.calls[0]!.push({ type: 'tool_call', name: STOP_TOOL, arguments: '{}' })
    await tick()
    expect(h.events.some((e) => e.kind === 'stop_agent')).toBe(true)
  })
})

describe('a sound in the room does not hold back what the voice does', () => {
  it('a stop the model calls while a sound is being checked runs at once (2026-10-15: 7 s late)', async () => {
    let tap: ((ev: unknown) => void) | null = null
    const h = harness({ tapRun: (_id, fn) => ((tap = fn as typeof tap), () => {}) })
    await h.session.start()
    h.session.follow('run-1')
    tap!({ type: 'status', status: 'running' })
    h.stt().say('Could you cancel the work please')
    await tick()
    // A sound while the voice works out its answer: maybe you, maybe a breath.
    h.stt().say('', false)
    expect(h.session.state).toBe('thinking')
    h.model.calls[0]!.push({ type: 'tool_call', name: STOP_TOOL, arguments: '{}' })
    await tick()
    expect(h.cancelRun).toHaveBeenCalledWith('run-1')
  })
})

describe('stop phrases', () => {
  it.each(['Cancel it.', 'Stop the agent.', 'Stop the task', 'Stop the work', 'Kill it', 'Halt', 'Cancel the task', 'Stop everything'])(
    '"%s" stops the work',
    (phrase) => {
      expect(isStopPhrase(phrase)).toBe(true)
    }
  )

  it.each(['Stop the tests from failing', 'Cancel my subscription email draft', 'It’s not stopped, keep running.'])('"%s" is a request, not a stop', (phrase) => {
    expect(isStopPhrase(phrase)).toBe(false)
  })
})

describe('turn timing', () => {
  it('is measured by this turn’s own reply, not the last one’s audio starting late (2026-10-15 16:46:15: 25 ms)', async () => {
    const logged: Array<{ firstAudioMs: number }> = []
    let now = 0
    const h = harness({ logLatency: (t) => logged.push(t), now: () => now })
    await h.session.start()
    h.stt().say('Dark theme.')
    await tick()
    now = 25
    // The previous reply's audio starts now: not this turn's answer.
    h.session.playback('an-earlier-reply', 'started')
    expect(logged).toEqual([])
    h.model.calls[0]!.push({ type: 'text', text: 'Got it, dark theme.' })
    h.model.calls[0]!.end()
    await tick()
    await tick()
    const reply = h.events.find((e) => e.kind === 'say')
    now = 1500
    h.session.playback(reply && 'contextId' in reply ? reply.contextId : '', 'started')
    expect(logged).toHaveLength(1)
    expect(logged[0]!.firstAudioMs).toBe(1500)
  })
})
