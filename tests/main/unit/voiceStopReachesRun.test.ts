/**
 * The eighth voice audit (2026-10-15, from Ajay's kept conversation
 * 2026-10-15T11-17-59): the voice said "Stopping it." twice and the run went
 * on for another 70 s. No `Chat cancel` reached main: the stop went through
 * the task's composer, which dropped it, and "Cancel it." wasn't a stop
 * phrase at all.
 */
import { describe, expect, it, vi } from 'vitest'
import { VoiceSession, type VoiceSessionDeps } from '@main/voice/session'
import { isStopPhrase } from '@main/voice/speechText'
import { openFixtureStt, type FixtureSttSession } from '@main/voice/providers/fixture'
import type { SttOpenOptions, TtsStream } from '@main/voice/providers/types'
import { DEFAULT_VOICE_SETTINGS, type VoiceEvent } from '@shared/ipc/schemas/voice'

const tick = () => new Promise((r) => setTimeout(r, 0))

function silentTts(): TtsStream {
  return { pushText: () => {}, flush: () => {}, end: () => {}, cancel: () => {}, done: () => Promise.resolve() } as unknown as TtsStream
}

function harness(deps: Partial<VoiceSessionDeps> = {}) {
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
    tapRun: () => () => {},
    cancelRun,
    setTimer: () => null,
    clearTimer: () => {},
    newId: () => `id${++n}`,
    ...deps
  })
  return { session, events, stt: () => stt.at(-1)!, cancelRun }
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

  it('with no run main can stop, the window is asked instead', async () => {
    let tap: ((ev: unknown) => void) | null = null
    const h = harness({ cancelRun: () => false, tapRun: (_id, fn) => ((tap = fn as typeof tap), () => {}) })
    await h.session.start()
    h.session.follow('run-1')
    tap!({ type: 'status', status: 'running' })
    h.stt().say('Stop the work.')
    await tick()
    expect(h.events.some((e) => e.kind === 'stop_agent')).toBe(true)
  })

  it('"stop it" in a longer request goes to the agent as your words, never dropped', async () => {
    const h = harness()
    await h.session.start()
    h.stt().say('Could you cancel the work please')
    await tick()
    expect(h.events.filter((e) => e.kind === 'hand_off').map((e) => (e.kind === 'hand_off' ? e.brief : ''))).toEqual(['Could you cancel the work please'])
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
    let tap: ((ev: unknown) => void) | null = null
    const h = harness({ logLatency: (t) => logged.push(t), now: () => now, tapRun: (_id, fn) => ((tap = fn as typeof tap), () => {}) })
    await h.session.start()
    h.stt().say('Dark theme.')
    await tick()
    h.session.follow('run-1', 'id1')
    tap!({ type: 'status', status: 'running' })
    now = 25
    // The previous reply's audio starts now: not this turn's answer.
    h.session.playback('an-earlier-reply', 'started')
    expect(logged).toEqual([])
    tap!({ type: 'text_delta', text: '<spoken>Switched to dark.</spoken>' })
    tap!({ type: 'assistant_message', content: '<spoken>Switched to dark.</spoken>' })
    const reply = h.events.find((e) => e.kind === 'say')
    now = 1500
    h.session.playback(reply && 'contextId' in reply ? reply.contextId : '', 'started')
    expect(logged).toHaveLength(1)
    expect(logged[0]!.firstAudioMs).toBe(1500)
  })
})
