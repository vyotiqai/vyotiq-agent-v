import { describe, expect, it, vi } from 'vitest'
import { MAX_WORKS, PTT_REMUTE_MS, VoiceSessionController, addLine, keepWork, type VoiceControllerDeps, type VoiceTurn } from '@renderer/features/voice/voiceSessionController'
import { MicCaptureError, type OpenMicCapture } from '@renderer/lib/audio/micCapture'
import type { VoiceEvent, VoiceWork } from '@shared/ipc/schemas/voice'
import { buildEntries } from '@renderer/features/voice/view/parts'

/** One event kind without its session id (distributes over the union). */
type Bare<E = VoiceEvent> = E extends VoiceEvent ? Omit<E, 'sessionId'> : never

function setup(startResult: unknown = { ok: true, data: { sessionId: 's1' } }, extra: Partial<VoiceControllerDeps> = {}) {
  let handler: ((e: VoiceEvent) => void) | null = null
  let onSamples: ((pcm: Int16Array) => void) | null = null
  let audioHandler: ((c: { utteranceId: string; seq: number; sampleRate: number; pcm: Int16Array; last?: boolean; piece?: number }) => void) | null = null
  const sources: Array<{ onended: (() => void) | null }> = []
  const stopCapture = vi.fn()
  const bridge = {
    voiceStart: vi.fn(async () => startResult),
    voiceStop: vi.fn(async () => ({ ok: true, data: true })),
    voiceAudio: vi.fn(async () => ({ ok: true, data: true })),
    voicePtt: vi.fn(async () => ({ ok: true, data: true })),
    voiceMute: vi.fn(async () => ({ ok: true, data: true })),
    onVoiceEvent: vi.fn((h: (e: VoiceEvent) => void) => {
      handler = h
      return () => {
        handler = null
      }
    }),
    onVoiceAudioOut: vi.fn((h: (c: { utteranceId: string; seq: number; sampleRate: number; pcm: Int16Array }) => void) => {
      audioHandler = h
      return () => {
        audioHandler = null
      }
    }),
    voiceFollow: vi.fn(async () => ({ ok: true, data: true })),
    voicePlayback: vi.fn(async () => ({ ok: true, data: true })),
    voiceInterrupt: vi.fn(async () => ({ ok: true, data: true })),
    voiceHandOffFailed: vi.fn(async () => ({ ok: true, data: true })),
    voiceTask: vi.fn(async () => ({ ok: true, data: true }))
  }
  const openCapture: OpenMicCapture = vi.fn(async (o) => {
    onSamples = o.onSamples
    return { deviceLabel: 'Desk mic', deviceId: 'd1', stop: stopCapture }
  })
  const turns: VoiceTurn[] = []
  const c = new VoiceSessionController({
    bridge: () => bridge as never,
    openCapture,
    onTurn: (t) => {
      turns.push(t)
      return 'run-7'
    },
    createAudioContext: () =>
      ({
        currentTime: 0,
        state: 'running',
        destination: {},
        createBuffer: (_c: number, length: number, rate: number) => ({
          duration: length / rate,
          getChannelData: () => new Float32Array(length)
        }),
        createBufferSource: () => {
          const src = { buffer: null, onended: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn() }
          sources.push(src)
          return src
        },
        createGain: () => ({ gain: { value: 1, setTargetAtTime: vi.fn() }, connect: vi.fn() }),
        createAnalyser: () => ({ fftSize: 0, connect: vi.fn(), getFloatTimeDomainData: vi.fn() }),
        close: vi.fn(async () => {})
      }) as never,
    ...extra
  })
  return {
    c,
    bridge,
    turns,
    stopCapture,
    emit: (e: Bare) => handler?.({ ...e, sessionId: 's1' } as VoiceEvent),
    samples: (pcm: Int16Array) => onSamples?.(pcm),
    audio: (utteranceId: string, piece?: number) =>
      audioHandler?.({ utteranceId, seq: 0, sampleRate: 24000, pcm: new Int16Array(240), ...(piece !== undefined ? { piece } : {}) }),
    /** Main: this reply's speech is complete (B9). */
    end: (utteranceId: string) => audioHandler?.({ utteranceId, seq: 1, sampleRate: 24000, pcm: new Int16Array(0), last: true }),
    sources,
    openCapture
  }
}

describe('the task the voice is on', () => {
  it('tells main once the session exists, and again only when the task changes', async () => {
    const t = setup()
    t.c.setTask('run-1', 'C:/ws')
    expect(t.bridge.voiceTask).not.toHaveBeenCalled()
    await t.c.start()
    expect(t.bridge.voiceTask).toHaveBeenCalledWith({ sessionId: 's1', runId: 'run-1', workspacePath: 'C:/ws' })
    t.c.setTask('run-1', 'C:/ws')
    expect(t.bridge.voiceTask).toHaveBeenCalledTimes(1)
    t.c.setTask('run-2')
    expect(t.bridge.voiceTask).toHaveBeenLastCalledWith({ sessionId: 's1', runId: 'run-2' })
  })
})

describe('the order lines are read in', () => {
  it('“On it.” reads above the hand-off it announced, though its caption waits for its audio (2026-10-15 screenshot)', async () => {
    const t = setup()
    await t.c.start()
    t.emit({ kind: 'turn', turnId: 't1', text: 'Analyze the code base', stop: false })
    // Main says the acknowledgement, then hands off, in the same instant.
    t.emit({ kind: 'say', contextId: 'c1', text: 'On it.', audible: true })
    t.emit({ kind: 'hand_off', handOffId: 'h1', brief: 'Analyze the code base: give an overview.' })
    t.audio('c1', 0)
    await vi.waitFor(() => expect(t.c.snapshot.transcript.map((l) => l.id)).toEqual(['t1', 'c1', 'h1']))
  })

  it('a reply whose audio comes after something you said goes last, as it was heard', () => {
    const lines = addLine(addLine([], 't1', 'you', 'Hello.'), 't2', 'you', 'Are you there?')
    expect(addLine(lines, 'c1', 'voice', 'Hi.', 't1').map((l) => l.id)).toEqual(['t1', 't2', 'c1'])
    // Said before anything was on screen, with only a hand-off since: first.
    expect(addLine(addLine([], 'h1', 'agent', 'Do it.'), 'c1', 'voice', 'On it.', null).map((l) => l.id)).toEqual(['c1', 'h1'])
    // Its anchor scrolled away: last.
    expect(addLine(addLine([], 'h1', 'agent', 'Do it.'), 'c1', 'voice', 'On it.', 'gone').map((l) => l.id)).toEqual(['h1', 'c1'])
    // More words for a line already there stay in place.
    expect(addLine(addLine([], 'c1', 'voice', 'On it.'), 'c1', 'voice', 'Starting now.', null)[0]!.text).toBe('On it. Starting now.')
  })
})

describe('hand-offs the task never took (R3)', () => {
  it('marks the line and tells main, so the voice can say so', async () => {
    const t = setup(undefined, { onTurn: async () => ({ failed: 'refused' as const }) })
    await t.c.start()
    t.emit({ kind: 'hand_off', handOffId: 'h1', brief: 'Run the tests.' })
    await vi.waitFor(() => expect(t.bridge.voiceHandOffFailed).toHaveBeenCalledWith({ sessionId: 's1', handOffId: 'h1', reason: 'refused' }))
    expect(t.c.snapshot.transcript.find((l) => l.id === 'h1')).toMatchObject({ who: 'agent', failed: 'refused' })
    expect(t.bridge.voiceFollow).not.toHaveBeenCalled()
  })

  it('a send that throws is an error, not silence', async () => {
    const t = setup(undefined, {
      onTurn: async () => {
        throw new Error('ipc closed')
      }
    })
    await t.c.start()
    t.emit({ kind: 'hand_off', handOffId: 'h1', brief: 'Run the tests.' })
    await vi.waitFor(() => expect(t.bridge.voiceHandOffFailed).toHaveBeenCalledWith(expect.objectContaining({ reason: 'error' })))
  })

  it('a run main already follows is never "couldn’t follow", however late the window learns it (2026-10-16 02:41:52)', async () => {
    const sent = deferred<{ failed: 'unfollowed' }>()
    const t = setup(undefined, { onTurn: () => sent.promise })
    await t.c.start()
    t.emit({ kind: 'hand_off', handOffId: 'h1', brief: 'Research the fastest voice models.' })
    t.emit({ kind: 'followed', handOffId: 'h1', runId: 'r1' })
    expect(t.c.snapshot.transcript.find((l) => l.id === 'h1')).toMatchObject({ runId: 'r1' })
    sent.resolve({ failed: 'unfollowed' })
    await new Promise((r) => setTimeout(r, 0))
    expect(t.bridge.voiceHandOffFailed).not.toHaveBeenCalled()
    expect(t.c.snapshot.transcript.find((l) => l.id === 'h1')!.failed).toBeUndefined()
  })

  it('sent with no run known yet is not a failure', async () => {
    const t = setup(undefined, { onTurn: async () => null })
    await t.c.start()
    t.emit({ kind: 'hand_off', handOffId: 'h1', brief: 'Run the tests.' })
    await new Promise((r) => setTimeout(r, 0))
    expect(t.bridge.voiceHandOffFailed).not.toHaveBeenCalled()
    expect(t.c.snapshot.transcript[0]!.failed).toBeUndefined()
  })

  it('a session ended while the task took it is left alone', async () => {
    const sent = deferred<{ failed: 'refused' }>()
    const t = setup(undefined, { onTurn: () => sent.promise })
    await t.c.start()
    t.emit({ kind: 'hand_off', handOffId: 'h1', brief: 'Run the tests.' })
    await t.c.stop()
    sent.resolve({ failed: 'refused' })
    await new Promise((r) => setTimeout(r, 0))
    expect(t.bridge.voiceHandOffFailed).not.toHaveBeenCalled()
  })
})

describe('VoiceSessionController problems', () => {
  it('a failed session lets go of the mic at once (A-11)', async () => {
    const t = setup()
    await t.c.start()
    t.emit({ kind: 'state', state: 'error' })
    t.emit({ kind: 'error', code: 'out_of_credit', retryable: false, side: 'session', detail: 'needs $0.50' })
    expect(t.stopCapture).toHaveBeenCalledTimes(1)
    expect(t.c.snapshot).toMatchObject({ state: 'error', error: 'out_of_credit', errorDetail: 'needs $0.50' })
  })

  it('Try again closes the dead session and opens a new one, without passing through off (A-10)', async () => {
    const t = setup()
    await t.c.start()
    t.emit({ kind: 'state', state: 'error' })
    const seen: string[] = []
    t.c.subscribe(() => seen.push(t.c.snapshot.state))
    await t.c.start()
    expect(t.bridge.voiceStop).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(t.bridge.voiceStart).toHaveBeenCalledTimes(2)
    expect(t.openCapture).toHaveBeenCalledTimes(2)
    expect(seen).not.toContain('off')
    expect(t.c.id).toBe('s1')
  })

  it('keeps a lost turn and a speaking failure apart from a session failure', async () => {
    const t = setup()
    await t.c.start()
    t.emit({ kind: 'state', state: 'listening' })
    t.emit({ kind: 'error', code: 'provider_down', retryable: true, side: 'turn', detail: '502' })
    t.emit({ kind: 'error', code: 'engine_failed', retryable: true, side: 'speak', detail: 'model not found' })
    expect(t.c.snapshot).toMatchObject({
      state: 'listening',
      error: null,
      turnError: { code: 'provider_down', detail: '502' },
      speakError: { code: 'engine_failed', detail: 'model not found' }
    })
    // Talking again clears the lost turn; the speaking problem stays for the session.
    t.emit({ kind: 'state', state: 'hearing' })
    t.emit({ kind: 'state', state: 'listening' })
    expect(t.c.snapshot.turnError).toBeNull()
    expect(t.c.snapshot.speakError).toMatchObject({ code: 'engine_failed' })
    expect(t.stopCapture).not.toHaveBeenCalled()
  })
})

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('VoiceSessionController start and End racing (R1, R2)', () => {
  it('End while the mic is opening closes the mic when it arrives, and never starts a session', async () => {
    const mic = deferred<{ deviceLabel: string; deviceId: string; stop: () => void }>()
    const stop = vi.fn()
    const t = setup(undefined, { openCapture: vi.fn(() => mic.promise) })
    const starting = t.c.start()
    await t.c.stop()
    mic.resolve({ deviceLabel: 'Desk mic', deviceId: 'd1', stop })
    await starting
    expect(stop).toHaveBeenCalledTimes(1)
    expect(t.bridge.voiceStart).not.toHaveBeenCalled()
    expect(t.c.id).toBeNull()
    expect(t.c.snapshot.state).toBe('off')
  })

  it('End while main opens the listener stops that session once its id comes back', async () => {
    const started = deferred<unknown>()
    const t = setup()
    t.bridge.voiceStart.mockImplementationOnce(() => started.promise as never)
    const starting = t.c.start()
    await vi.waitFor(() => expect(t.bridge.voiceStart).toHaveBeenCalled())
    await t.c.stop()
    started.resolve({ ok: true, data: { sessionId: 's9' } })
    await starting
    expect(t.bridge.voiceStop).toHaveBeenCalledWith({ sessionId: 's9' })
    expect(t.c.id).toBeNull()
    expect(t.c.active).toBe(false)
    expect(t.stopCapture).toHaveBeenCalled()
    // A chunk from a mic that's already closed sends nothing.
    t.samples(new Int16Array(160).fill(3000))
    expect(t.bridge.voiceAudio).not.toHaveBeenCalled()
  })

  it('a start after an End that raced still opens normally', async () => {
    const started = deferred<unknown>()
    const t = setup()
    t.bridge.voiceStart.mockImplementationOnce(() => started.promise as never)
    const first = t.c.start()
    await vi.waitFor(() => expect(t.bridge.voiceStart).toHaveBeenCalledTimes(1))
    await t.c.stop()
    await t.c.start()
    started.resolve({ ok: true, data: { sessionId: 'stale' } })
    await first
    expect(t.c.id).toBe('s1')
    expect(t.bridge.voiceStop).toHaveBeenCalledWith({ sessionId: 'stale' })
  })
})

describe('VoiceSessionController', () => {
  it('opens the mic, then the session, and streams audio to it', async () => {
    const t = setup()
    await t.c.start({ workspacePath: '/repo', deviceId: 'd1' })
    expect(t.openCapture).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'd1' }))
    expect(t.bridge.voiceStart).toHaveBeenCalledWith({ workspacePath: '/repo' })
    expect(t.c.snapshot.deviceLabel).toBe('Desk mic')
    const pcm = new Int16Array(2048).fill(4000)
    t.samples(pcm)
    expect(t.bridge.voiceAudio).toHaveBeenCalledWith({ sessionId: 's1', pcm })
    expect(t.c.micLevel()).toBeGreaterThan(0)
    expect(t.c.orbLevel()).toBe(t.c.micLevel())
  })

  it('mic chunks never re-render subscribers: the orb reads the level per frame (R6)', async () => {
    const t = setup()
    await t.c.start()
    const notified = vi.fn()
    t.c.subscribe(notified)
    // Ten seconds of listening at one chunk every 128 ms, the level moving every time.
    for (let i = 0; i < 78; i++) t.samples(new Int16Array(2048).fill(500 + i * 40))
    expect(notified).not.toHaveBeenCalled()
    expect(t.c.micLevel()).toBeGreaterThan(0)
    t.c.setMuted(true)
    expect(t.c.micLevel()).toBe(0)
  })

  it('follows state and captions; a turn is shown, and only a hand-off goes to the agent (D-44)', async () => {
    const t = setup()
    await t.c.start()
    t.emit({ kind: 'state', state: 'hearing' })
    t.emit({ kind: 'partial', text: 'fix the' })
    expect(t.c.snapshot).toMatchObject({ state: 'hearing', partial: 'fix the' })
    t.emit({ kind: 'turn', turnId: 't1', text: 'fix the test', stop: false })
    expect(t.turns).toEqual([])
    expect(t.c.snapshot).toMatchObject({ partial: '', lastTurn: 'fix the test' })
    t.emit({ kind: 'hand_off', handOffId: 'h1', brief: 'Fix the failing test in the parser.' })
    expect(t.turns).toEqual([{ turnId: 'h1', text: 'Fix the failing test in the parser.', stop: false }])
  })

  it('marks what the voice heard and left unanswered, apart from what it answered', async () => {
    const t = setup()
    await t.c.start()
    t.emit({ kind: 'unanswered', turnId: 'u1', text: 'Okay.' })
    t.emit({ kind: 'turn', turnId: 't1', text: 'Mm, the fan.', stop: false })
    t.emit({ kind: 'unanswered', turnId: 't1' })
    t.emit({ kind: 'turn', turnId: 't2', text: 'Run the tests.', stop: false })
    expect(t.c.snapshot.transcript).toEqual([
      { id: 'u1', who: 'you', text: 'Okay.', unanswered: true },
      { id: 't1', who: 'you', text: 'Mm, the fan.', unanswered: true },
      { id: 't2', who: 'you', text: 'Run the tests.' }
    ])
    const entries = buildEntries(t.c.snapshot.transcript, {})
    expect(entries).toEqual([
      { id: 'u1', who: 'you', text: 'Okay. Mm, the fan.', unanswered: true },
      { id: 't2', who: 'you', text: 'Run the tests.' }
    ])
  })

  it('keeps the conversation: your turns, the voice’s sentences joined per reply, and work handed off', async () => {
    const t = setup()
    await t.c.start()
    t.emit({ kind: 'turn', turnId: 't1', text: 'Can you run the tests?', stop: false })
    t.emit({ kind: 'say', contextId: 'c1', text: 'Sure.' })
    t.emit({ kind: 'say', contextId: 'c1', text: 'I’ll have the agent run them.' })
    t.emit({ kind: 'hand_off', handOffId: 'h1', brief: 'Run the tests.' })
    expect(t.c.snapshot.transcript).toEqual([
      { id: 't1', who: 'you', text: 'Can you run the tests?' },
      { id: 'c1', who: 'voice', text: 'Sure. I’ll have the agent run them.' },
      { id: 'h1', who: 'agent', text: 'Run the tests.' }
    ])
  })

  it('a hand-off learns the run it went to, and that run’s work is kept for the view (§25)', async () => {
    const t = setup()
    await t.c.start()
    t.emit({ kind: 'hand_off', handOffId: 'h1', brief: 'Run the tests.' })
    await vi.waitFor(() => expect(t.bridge.voiceFollow).toHaveBeenCalledWith({ sessionId: 's1', runId: 'run-7', handOffId: 'h1' }))
    expect(t.c.snapshot.transcript).toEqual([{ id: 'h1', who: 'agent', text: 'Run the tests.', runId: 'run-7' }])
    const work: VoiceWork = {
      runId: 'run-7',
      state: 'running',
      startedAt: 1,
      stepCount: 1,
      steps: [{ id: 'a', tool: 'terminal', summary: 'pnpm test', state: 'running' }]
    }
    t.emit({ kind: 'work', work })
    expect(t.c.snapshot.works['run-7']).toEqual(work)
    t.emit({ kind: 'work', work: { ...work, state: 'done', endedAt: 9, result: 'All pass.' } })
    expect(t.c.snapshot.works['run-7']).toMatchObject({ state: 'done', result: 'All pass.' })
  })

  it('keeps the newest work of at most MAX_WORKS runs', () => {
    let works = {}
    for (let i = 0; i <= MAX_WORKS; i++) works = keepWork(works, { runId: `r${i}`, state: 'done', startedAt: i, stepCount: 0, steps: [] })
    expect(Object.keys(works)).toHaveLength(MAX_WORKS)
    expect(Object.keys(works)).not.toContain('r0')
    // Hearing from an old run again makes it the newest.
    works = keepWork(works, { runId: 'r1', state: 'running', startedAt: 99, stepCount: 0, steps: [] })
    works = keepWork(works, { runId: 'r99', state: 'running', startedAt: 99, stepCount: 0, steps: [] })
    expect(Object.keys(works)).toContain('r1')
    expect(Object.keys(works)).not.toContain('r2')
  })

  it('the voice asked to stop the work: the task’s Stop is pressed', async () => {
    const onStopAgent = vi.fn()
    const t = setup(undefined, { onStopAgent })
    await t.c.start()
    t.emit({ kind: 'stop_agent' })
    expect(onStopAgent).toHaveBeenCalledTimes(1)
  })

  it('ignores events for another session', async () => {
    const t = setup()
    await t.c.start()
    t.emit({ kind: 'state', state: 'hearing' })
    const before = t.c.snapshot
    ;(t.bridge.onVoiceEvent.mock.calls[0]![0] as (e: VoiceEvent) => void)({ sessionId: 'other', kind: 'state', state: 'error' })
    expect(t.c.snapshot).toBe(before)
  })

  it('a blocked mic fails before any session is started', async () => {
    const t = setup()
    ;(t.openCapture as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new MicCaptureError('blocked', 'denied'))
    await t.c.start()
    expect(t.bridge.voiceStart).not.toHaveBeenCalled()
    expect(t.c.snapshot).toMatchObject({ state: 'error', error: 'mic_blocked' })
  })

  it('a refused start releases the mic and shows the typed error', async () => {
    const t = setup({ ok: false, error: 'x', code: 'voice:no_key' })
    await t.c.start()
    expect(t.stopCapture).toHaveBeenCalled()
    expect(t.c.snapshot).toMatchObject({ state: 'error', error: 'no_key' })
  })

  it('mute stops sending audio; stop releases everything', async () => {
    const t = setup()
    await t.c.start()
    t.c.setMuted(true)
    expect(t.bridge.voiceMute).toHaveBeenCalledWith({ sessionId: 's1', muted: true })
    t.samples(new Int16Array(2048).fill(4000))
    expect(t.bridge.voiceAudio).not.toHaveBeenCalled()
    t.c.ptt(true)
    expect(t.bridge.voicePtt).toHaveBeenCalledWith({ sessionId: 's1', down: true })
    await t.c.stop()
    expect(t.stopCapture).toHaveBeenCalled()
    expect(t.bridge.voiceStop).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(t.c.snapshot.state).toBe('off')
    expect(t.c.active).toBe(false)
  })

  it('follows the run each hand-off went to', async () => {
    const t = setup()
    await t.c.start()
    t.emit({ kind: 'hand_off', handOffId: 'h1', brief: 'go' })
    await vi.waitFor(() => expect(t.bridge.voiceFollow).toHaveBeenCalledWith({ sessionId: 's1', runId: 'run-7', handOffId: 'h1' }))
  })

  it('plays reply audio it was told about, reports start and drain, and flushes on barge-in', async () => {
    const t = setup()
    await t.c.start()
    t.audio('unknown')
    expect(t.sources).toHaveLength(0)
    t.emit({ kind: 'say', contextId: 'c1', text: 'Done.' })
    expect(t.c.snapshot.saying).toBe('Done.')
    t.audio('c1')
    expect(t.bridge.voicePlayback).toHaveBeenCalledWith({ sessionId: 's1', contextId: 'c1', phase: 'started' })
    // A gap while the next sentence is being made is not the end of the reply (B9).
    t.sources[0]!.onended?.()
    expect(t.bridge.voicePlayback).not.toHaveBeenCalledWith({ sessionId: 's1', contextId: 'c1', phase: 'drained' })
    t.audio('c1')
    t.end('c1')
    expect(t.bridge.voicePlayback).not.toHaveBeenCalledWith({ sessionId: 's1', contextId: 'c1', phase: 'drained' })
    t.sources[1]!.onended?.()
    expect(t.bridge.voicePlayback).toHaveBeenCalledWith({ sessionId: 's1', contextId: 'c1', phase: 'drained' })
    t.emit({ kind: 'say', contextId: 'c2', text: 'Next.' })
    t.audio('c2')
    t.emit({ kind: 'flush', contextId: 'c2' })
    expect(t.c.snapshot.saying).toBe('')
    t.audio('c2')
    expect(t.sources).toHaveLength(3)
  })

  it('holds each caption until its own audio starts playing', async () => {
    vi.useFakeTimers()
    try {
      const t = setup()
      await t.c.start()
      const voiceText = () => t.c.snapshot.transcript.filter((l) => l.who === 'voice').map((l) => l.text)
      t.emit({ kind: 'say', contextId: 'c1', text: 'First.', audible: true })
      t.emit({ kind: 'say', contextId: 'c1', text: 'Second.', audible: true })
      // Ready to synthesise is not heard: nothing on screen yet.
      expect(voiceText()).toEqual([])
      expect(t.c.snapshot.saying).toBe('')
      t.audio('c1', 0)
      // Scheduled after the player's jitter buffer: shown as it plays, not before.
      expect(voiceText()).toEqual([])
      await vi.advanceTimersByTimeAsync(60)
      expect(voiceText()).toEqual(['First.'])
      expect(t.c.snapshot.saying).toBe('First.')
      // More of the first sentence's audio moves nothing on.
      t.audio('c1')
      await vi.advanceTimersByTimeAsync(100)
      expect(voiceText()).toEqual(['First.'])
      t.audio('c1', 1)
      await vi.advanceTimersByTimeAsync(100)
      expect(voiceText()).toEqual(['First. Second.'])
      expect(t.c.snapshot.saying).toBe('Second.')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows a caption at once when nothing will speak it, and never loses one whose audio fails', async () => {
    vi.useFakeTimers()
    try {
      const t = setup()
      await t.c.start()
      const voiceText = () => t.c.snapshot.transcript.filter((l) => l.who === 'voice').map((l) => l.text)
      t.emit({ kind: 'say', contextId: 'c1', text: 'No voice here.', audible: false })
      expect(voiceText()).toEqual(['No voice here.'])
      // Audio was coming, then speaking failed: the words still show.
      t.emit({ kind: 'say', contextId: 'c2', text: 'Lost audio.', audible: true })
      expect(voiceText()).toEqual(['No voice here.'])
      t.emit({ kind: 'error', code: 'out_of_credit', retryable: false, side: 'speak' })
      expect(voiceText()).toEqual(['No voice here.', 'Lost audio.'])
      // A reply whose speech ended without any audio shows its words.
      t.emit({ kind: 'say', contextId: 'c3', text: 'Ended silent.', audible: true })
      t.end('c3')
      expect(voiceText().at(-1)).toBe('Ended silent.')
      // One whose audio never comes at all shows after the stall wait.
      t.emit({ kind: 'say', contextId: 'c4', text: 'Hung.', audible: true })
      await vi.advanceTimersByTimeAsync(4000)
      expect(voiceText().at(-1)).toBe('Hung.')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a barge-in drops captions not yet heard', async () => {
    vi.useFakeTimers()
    try {
      const t = setup()
      await t.c.start()
      t.emit({ kind: 'say', contextId: 'c1', text: 'Heard.', audible: true })
      t.emit({ kind: 'say', contextId: 'c1', text: 'Never heard.', audible: true })
      t.audio('c1', 0)
      await vi.advanceTimersByTimeAsync(60)
      t.emit({ kind: 'flush', contextId: 'c1' })
      await vi.advanceTimersByTimeAsync(5000)
      expect(t.c.snapshot.transcript.filter((l) => l.who === 'voice').map((l) => l.text)).toEqual(['Heard.'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a reply whose end marker comes after its audio has played drains at once', async () => {
    const t = setup()
    await t.c.start()
    t.emit({ kind: 'say', contextId: 'c1', text: 'Done.' })
    t.audio('c1')
    t.sources[0]!.onended?.()
    t.end('c1')
    expect(t.bridge.voicePlayback).toHaveBeenCalledWith({ sessionId: 's1', contextId: 'c1', phase: 'drained' })
  })
})

describe('the 2026-10-15 redesign’s controls (§26)', () => {
  it('a reply you talked over is marked cut where its line stood, until the next reply', async () => {
    const t = setup()
    await t.c.start()
    t.emit({ kind: 'turn', turnId: 't1', text: 'Is it done?', stop: false })
    t.emit({ kind: 'say', contextId: 'c1', text: 'Yes, all fourteen pass.', audible: false })
    await vi.waitFor(() => expect(t.c.snapshot.transcript.map((l) => l.id)).toEqual(['t1', 'c1']))
    t.emit({ kind: 'flush', contextId: 'c1' })
    expect(t.c.snapshot.cutLineId).toBe('c1')
    // A flush for a reply that never reached the screen marks nothing.
    t.emit({ kind: 'flush', contextId: 'never-shown' })
    expect(t.c.snapshot.cutLineId).toBe('c1')
    t.emit({ kind: 'say', contextId: 'c2', text: 'Okay.', audible: false })
    expect(t.c.snapshot.cutLineId).toBeNull()
  })

  it('switches the microphone without ending the session: the new one opens before the old one closes', async () => {
    const t = setup()
    await t.c.start({ deviceId: 'd1' })
    const order: string[] = []
    t.stopCapture.mockImplementation(() => order.push('old stopped'))
    ;(t.openCapture as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      order.push('new opened')
      return { deviceLabel: 'Headset', deviceId: 'd2', stop: vi.fn() }
    })
    await expect(t.c.switchMic('d2')).resolves.toBe(true)
    expect(order).toEqual(['new opened', 'old stopped'])
    expect(t.c.snapshot.deviceLabel).toBe('Headset')
    expect(t.c.active).toBe(true)
    // A device that won't open leaves the old one listening.
    ;(t.openCapture as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new MicCaptureError('no_device', 'gone')
    })
    await expect(t.c.switchMic('d3')).resolves.toBe(false)
    expect(t.c.snapshot.deviceLabel).toBe('Headset')
  })

  it('plays its voice on the chosen output, including the reply already playing', async () => {
    const sinks: string[] = []
    const t = setup(undefined, {
      createAudioContext: () =>
        ({
          currentTime: 0,
          state: 'running',
          destination: {},
          createBuffer: (_c: number, length: number, rate: number) => ({ duration: length / rate, getChannelData: () => new Float32Array(length) }),
          createBufferSource: () => ({ buffer: null, onended: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn() }),
          createGain: () => ({ gain: { value: 1, setTargetAtTime: vi.fn() }, connect: vi.fn() }),
          createAnalyser: () => ({ fftSize: 0, connect: vi.fn(), getFloatTimeDomainData: vi.fn() }),
          close: vi.fn(async () => {}),
          setSinkId: vi.fn(async (id: string) => {
            sinks.push(id)
          })
        }) as never
    })
    t.c.setOutput('headset')
    await t.c.start()
    t.emit({ kind: 'say', contextId: 'c1', text: 'Hello.', audible: true })
    t.audio('c1', 0)
    expect(sinks).toEqual(['headset'])
    t.c.setOutput('')
    expect(sinks).toEqual(['headset', ''])
  })

  it('holds the mic while a voice sample plays: nothing is sent, and mute is untouched', async () => {
    const t = setup()
    await t.c.start()
    t.samples(new Int16Array(160).fill(2000))
    expect(t.bridge.voiceAudio).toHaveBeenCalledTimes(1)
    t.c.holdMic(true)
    t.samples(new Int16Array(160).fill(2000))
    expect(t.bridge.voiceAudio).toHaveBeenCalledTimes(1)
    expect(t.c.micLevel()).toBe(0)
    expect(t.c.snapshot.muted).toBe(false)
    t.c.holdMic(false)
    t.samples(new Int16Array(160).fill(2000))
    expect(t.bridge.voiceAudio).toHaveBeenCalledTimes(2)
  })
})

describe('hold to talk (audit 2026-10-15, I1–I2)', () => {
  it('held while muted it talks anyway, and is muted again once the turn is answered', async () => {
    const t = setup()
    await t.c.start()
    t.c.setMuted(true)
    t.bridge.voiceMute.mockClear()
    t.c.ptt(true)
    expect(t.c.snapshot.muted).toBe(false)
    expect(t.bridge.voiceMute).toHaveBeenCalledWith({ sessionId: 's1', muted: false })
    // Audio goes while held.
    t.samples(new Int16Array(160).fill(2000))
    expect(t.bridge.voiceAudio).toHaveBeenCalled()
    t.c.ptt(false)
    expect(t.bridge.voicePtt).toHaveBeenLastCalledWith({ sessionId: 's1', down: false })
    // Still unmuted while it thinks and answers.
    t.emit({ kind: 'state', state: 'thinking' })
    t.emit({ kind: 'state', state: 'speaking' })
    expect(t.c.snapshot.muted).toBe(false)
    // Back to listening: muted again, as you left it.
    t.emit({ kind: 'state', state: 'listening' })
    expect(t.c.snapshot.muted).toBe(true)
    expect(t.bridge.voiceMute).toHaveBeenLastCalledWith({ sessionId: 's1', muted: true })
  })

  it('unmuting by hand after a hold keeps it unmuted', async () => {
    const t = setup()
    await t.c.start()
    t.c.setMuted(true)
    t.c.ptt(true)
    t.c.ptt(false)
    t.c.setMuted(false)
    t.emit({ kind: 'state', state: 'listening' })
    expect(t.c.snapshot.muted).toBe(false)
  })

  it('held while it speaks, it stops speaking at once', async () => {
    const t = setup()
    await t.c.start()
    t.emit({ kind: 'state', state: 'speaking' })
    t.c.ptt(true)
    expect(t.bridge.voiceInterrupt).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(t.bridge.voicePtt).toHaveBeenCalledWith({ sessionId: 's1', down: true })
  })
})

describe('a hold through mute that nothing was heard in', () => {
  it('is muted again shortly after, and a word arriving first does not mute it early', async () => {
    vi.useFakeTimers()
    try {
      const t = setup()
      await t.c.start()
      t.emit({ kind: 'state', state: 'listening' })
      t.c.setMuted(true)
      t.emit({ kind: 'state', state: 'paused' })
      t.c.ptt(true)
      // Main unmutes: listening again.
      t.emit({ kind: 'state', state: 'listening' })
      t.c.ptt(false)
      // A stray partial while still listening is not the turn's answer.
      t.emit({ kind: 'partial', text: 'um' })
      expect(t.c.snapshot.muted).toBe(false)
      vi.advanceTimersByTime(PTT_REMUTE_MS + 10)
      expect(t.c.snapshot.muted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for the answer when a turn did start', async () => {
    vi.useFakeTimers()
    try {
      const t = setup()
      await t.c.start()
      t.c.setMuted(true)
      t.c.ptt(true)
      t.emit({ kind: 'state', state: 'hearing' })
      t.c.ptt(false)
      t.emit({ kind: 'state', state: 'thinking' })
      vi.advanceTimersByTime(PTT_REMUTE_MS + 10)
      expect(t.c.snapshot.muted).toBe(false)
      t.emit({ kind: 'state', state: 'listening' })
      expect(t.c.snapshot.muted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('muted is the session’s state (2026-10-16 audit, H2)', () => {
  it('muted by the agent (voice_mute), the window shows it, and hold-to-talk unmutes', async () => {
    const t = setup()
    await t.c.start()
    t.emit({ kind: 'state', state: 'listening' })
    t.emit({ kind: 'state', state: 'paused' })
    expect(t.c.snapshot.muted).toBe(true)
    // Nothing is sent while muted.
    t.samples(new Int16Array(160))
    expect(t.bridge.voiceAudio).not.toHaveBeenCalled()
    // Held, it talks: unmuted for the hold.
    t.c.ptt(true)
    expect(t.bridge.voiceMute).toHaveBeenCalledWith({ sessionId: 's1', muted: false })
    t.emit({ kind: 'state', state: 'listening' })
    expect(t.c.snapshot.muted).toBe(false)
  })

  it('unmuted in main, the window is unmuted too', async () => {
    const t = setup()
    await t.c.start()
    t.c.setMuted(true)
    t.emit({ kind: 'state', state: 'paused' })
    t.emit({ kind: 'state', state: 'listening' })
    expect(t.c.snapshot.muted).toBe(false)
  })
})

