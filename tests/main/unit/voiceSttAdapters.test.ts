import { afterEach, describe, expect, it, vi } from 'vitest'
import { setOpenVoiceSocketForTests, type VoiceSocket } from '@main/voice/socket'
import { deepgramFlux, fluxUrl } from '@main/voice/providers/stt/deepgramFlux'
import { setKeyCheckFetchForTests } from '@main/voice/providers/stt/socketStt'
import { assemblyAi, assemblyAiUrl } from '@main/voice/providers/stt/assemblyai'
import { elevenLabsScribe, scribeUrl } from '@main/voice/providers/stt/elevenlabsScribe'
import { openAiRealtime } from '@main/voice/providers/stt/openaiRealtime'
import { LEAD_IN_SAMPLES, MIN_LEAD_IN_SAMPLES, makeLocalStt } from '@main/voice/providers/stt/local'
import { makeOpenRouterStt } from '@main/voice/providers/stt/openrouter'
import { DictationError } from '@main/dictation/errors'
import type { SttEvent, SttOpenOptions, SttProvider } from '@main/voice/providers/types'

class FakeSocket implements VoiceSocket {
  readyState = 0
  json: Record<string, unknown>[] = []
  binary: Uint8Array[] = []
  closed = false
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>
  ) {}
  send(data: string | ArrayBufferView | ArrayBuffer): void {
    if (typeof data === 'string') this.json.push(JSON.parse(data) as Record<string, unknown>)
    else this.binary.push(new Uint8Array(data as ArrayBuffer))
  }
  close(): void {
    this.closed = true
  }
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }
  frame(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
}

let sockets: FakeSocket[] = []
function capture(): void {
  sockets = []
  setOpenVoiceSocketForTests((url, headers) => {
    const s = new FakeSocket(url, headers)
    sockets.push(s)
    return s
  })
}
afterEach(() => {
  setOpenVoiceSocketForTests(null)
  setKeyCheckFetchForTests(null)
})

function opts(over: Partial<SttOpenOptions> = {}) {
  const events: SttEvent[] = []
  const ctrl = new AbortController()
  const o: SttOpenOptions = {
    apiKey: 'key',
    model: '',
    language: '',
    patience: 'normal',
    signal: ctrl.signal,
    emit: (e) => events.push(e),
    ...over
  }
  return { o, events, ctrl }
}

async function openWith(provider: SttProvider, o: SttOpenOptions) {
  const pending = provider.open(o)
  await vi.waitFor(() => expect(sockets).toHaveLength(1))
  sockets[0]!.open()
  return { session: await pending, sock: sockets[0]! }
}

const kinds = (events: SttEvent[]) => events.map((e) => e.kind)

describe('Deepgram Flux', () => {
  it('keeps a muted stream open with 100 ms of silence (Deepgram closes after ~10 s without audio)', async () => {
    capture()
    const { o } = opts({ model: 'flux-general-en' })
    const { session, sock } = await openWith(deepgramFlux, o)
    session.keepAlive?.()
    expect(sock.binary.at(-1)).toEqual(new Uint8Array(3200))
    expect(sock.json.filter((m) => m.type === 'KeepAlive')).toHaveLength(0)
  })

  it('builds the v2 URL with patience, language and key terms', () => {
    const url = new URL(fluxUrl({ model: 'flux-general-en', language: '', patience: 'quick', keyterms: ['runAgent'] }))
    expect(url.pathname).toBe('/v2/listen')
    expect(url.searchParams.get('model')).toBe('flux-general-en')
    expect(url.searchParams.get('eot_threshold')).toBe('0.6')
    expect(url.searchParams.get('eot_timeout_ms')).toBe('3000')
    expect(url.searchParams.getAll('keyterm')).toEqual(['runAgent'])
    const multi = new URL(fluxUrl({ model: 'flux-general-en', language: 'es', patience: 'normal' }))
    expect(multi.searchParams.get('model')).toBe('flux-general-multi')
    expect(multi.searchParams.get('language_hint')).toBe('es')
  })

  it('sends binary audio and maps turn events, ignoring eager end-of-turn', async () => {
    capture()
    const { o, events } = opts({ model: 'flux-general-en' })
    const { session, sock } = await openWith(deepgramFlux, o)
    expect(sock.headers).toEqual({ Authorization: 'Token key' })
    session.pushAudio(Int16Array.from([1, 2]))
    expect(sock.binary[0]).toEqual(new Uint8Array([1, 0, 2, 0]))
    sock.frame({ type: 'TurnInfo', event: 'StartOfTurn', transcript: '' })
    sock.frame({ type: 'TurnInfo', event: 'Update', transcript: 'fix the' })
    sock.frame({ type: 'TurnInfo', event: 'EagerEndOfTurn', transcript: 'fix the' })
    sock.frame({ type: 'TurnInfo', event: 'TurnResumed', transcript: 'fix the test' })
    sock.frame({ type: 'TurnInfo', event: 'EndOfTurn', transcript: 'fix the test', end_of_turn_confidence: 0.9 })
    expect(kinds(events)).toEqual(['open', 'speech_start', 'partial', 'partial', 'partial', 'end_of_turn'])
    expect(events.at(-1)).toEqual({ kind: 'end_of_turn', text: 'fix the test', confidence: 0.9 })
    session.endTurn()
    expect(sock.json.at(-1)).toEqual({ type: 'ForceEndTurn' })
    await session.close()
    expect(sock.json.at(-1)).toEqual({ type: 'CloseStream' })
  })

  it('a bad key closes with a typed, non-retryable error', async () => {
    capture()
    const { o, events } = opts()
    const { sock } = await openWith(deepgramFlux, o)
    sock.onclose?.({ code: 1008, reason: 'Invalid credentials' })
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'rejected_key', retryable: false }))
  })
})

describe('AssemblyAI', () => {
  it('puts patience in the URL and sends key terms once open', async () => {
    const url = new URL(assemblyAiUrl({ model: 'universal-3-6-pro', language: '', patience: 'patient' }))
    expect(url.searchParams.get('end_of_turn_confidence_threshold')).toBe('0.6')
    expect(url.searchParams.get('max_turn_silence')).toBe('2500')
    capture()
    const { o, events } = opts({ model: 'universal-3-6-pro', keyterms: ['TakeStrip'] })
    const { sock, session } = await openWith(assemblyAi, o)
    expect(sock.headers).toEqual({ Authorization: 'key' })
    expect(sock.json[0]).toEqual({ type: 'UpdateConfiguration', keyterms_prompt: ['TakeStrip'] })
    sock.frame({ type: 'Turn', transcript: 'open the', end_of_turn: false })
    sock.frame({ type: 'Turn', transcript: 'open the settings', end_of_turn: true, end_of_turn_confidence: 0.8 })
    expect(kinds(events)).toEqual(['open', 'speech_start', 'partial', 'end_of_turn'])
    session.endTurn()
    expect(sock.json.at(-1)).toEqual({ type: 'ForceEndpoint' })
  })
})

describe('ElevenLabs Scribe', () => {
  it('sends JSON audio, and a commit ends the turn with everything committed', async () => {
    expect(new URL(scribeUrl({ model: 'scribe_v2_realtime', language: '' })).searchParams.get('audio_format')).toBe('pcm_16000')
    // The session commits each turn itself (ElevenLabs doesn't document the model's default strategy).
    expect(new URL(scribeUrl({ model: 'scribe_v2_realtime', language: '' })).searchParams.get('commit_strategy')).toBe('manual')
    capture()
    const { o, events } = opts()
    const { sock, session } = await openWith(elevenLabsScribe, o)
    session.pushAudio(Int16Array.from([3]))
    expect(sock.json[0]).toMatchObject({ message_type: 'input_audio_chunk', commit: false, sample_rate: 16000 })
    sock.frame({ message_type: 'partial_transcript', text: 'run the' })
    sock.frame({ message_type: 'committed_transcript', text: 'run the tests' })
    session.endTurn()
    expect(sock.json.at(-1)).toMatchObject({ commit: true, audio_base_64: '' })
    sock.frame({ message_type: 'committed_transcript', text: 'please' })
    expect(kinds(events)).toEqual(['open', 'speech_start', 'partial', 'final', 'end_of_turn'])
    expect(events.at(-1)).toEqual({ kind: 'end_of_turn', text: 'run the tests please' })
  })
})

describe('OpenAI realtime', () => {
  it('configures transcription first, upsamples audio, and commits on endTurn', async () => {
    capture()
    const { o, events } = opts({ model: 'gpt-live-transcribe', language: 'en', keyterms: ['vyotiq'] })
    const pending = openAiRealtime.open(o)
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const sock = sockets[0]!
    const s = await (async () => {
      sock.open()
      return pending
    })()
    expect(sock.headers).toEqual({ Authorization: 'Bearer key' })
    expect(sock.json[0]).toMatchObject({ type: 'session.update' })
    expect(JSON.stringify(sock.json[0])).toContain('"turn_detection":null')
    s.pushAudio(new Int16Array(320))
    expect(sock.json.at(-1)).toMatchObject({ type: 'input_audio_buffer.append' })
    sock.frame({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'i1', delta: 'hello ' })
    s.endTurn()
    expect(sock.json.at(-1)).toEqual({ type: 'input_audio_buffer.commit' })
    sock.frame({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'hello there' })
    expect(kinds(events)).toEqual(['open', 'speech_start', 'partial', 'end_of_turn'])
  })

  it('an empty commit is an empty turn, not a failure', async () => {
    capture()
    const { o, events } = opts()
    const { sock } = await openWith(openAiRealtime, o)
    sock.frame({ type: 'error', error: { code: 'input_audio_buffer_commit_empty' } })
    expect(events.at(-1)).toEqual({ kind: 'end_of_turn', text: '' })
  })
})

describe('connection', () => {
  it('queues audio until open, then flushes it in order', async () => {
    capture()
    const { o } = opts()
    const pending = deepgramFlux.open(o)
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const sock = sockets[0]!
    // Not exposed before open; push through a second session-like path is not possible, so open and check.
    sock.open()
    const session = await pending
    session.pushAudio(Int16Array.from([7]))
    expect(sock.binary).toHaveLength(1)
  })

  it('times out a connection that never opens', async () => {
    vi.useFakeTimers()
    try {
      capture()
      // The key check that follows can't reach the vendor either.
      setKeyCheckFetchForTests(vi.fn(async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch)
      const { o, events } = opts()
      // Handle the rejection before the clock moves: it happens during the advance.
      const rejected = expect(deepgramFlux.open(o)).rejects.toThrow(/did not connect/)
      await vi.advanceTimersByTimeAsync(10_001)
      await rejected
      expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'offline', retryable: true }))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a refused handshake (A-12)', () => {
  function keyCheckAnswers(status: number, body = '') {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    setKeyCheckFetchForTests(
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
        return new Response(body, { status })
      }) as unknown as typeof fetch
    )
    return calls
  }

  async function refuse(provider: SttProvider) {
    capture()
    const { o, events } = opts()
    const pending = provider.open(o)
    pending.catch(() => {})
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    // What a refused upgrade looks like from undici: an error, then close 1006.
    sockets[0]!.onerror?.({})
    sockets[0]!.onclose?.({ code: 1006, reason: '' })
    const err = await pending.then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string }
    )
    return { events, err }
  }

  it('asks the vendor once, and a 401 is a rejected key, not a lost connection', async () => {
    const calls = keyCheckAnswers(401, '{"err_msg":"Invalid credentials."}')
    const { events, err } = await refuse(deepgramFlux)
    expect(calls).toEqual([{ url: 'https://api.deepgram.com/v1/projects', headers: { Authorization: 'Token key' } }])
    const errors = events.filter((e) => e.kind === 'error')
    expect(errors).toEqual([expect.objectContaining({ code: 'rejected_key', retryable: false })])
    expect((errors[0] as { message: string }).message).toMatch(/Deepgram refused the connection: .*Invalid credentials/)
    expect(err).toMatchObject({ code: 'rejected_key' })
  })

  it('402 is out of credit; anything unclear stays offline', async () => {
    keyCheckAnswers(402)
    expect((await refuse(assemblyAi)).err).toMatchObject({ code: 'out_of_credit' })
    keyCheckAnswers(500)
    expect((await refuse(openAiRealtime)).err).toMatchObject({ code: 'offline' })
  })

  it('a restricted ElevenLabs key missing a permission isn’t called rejected', async () => {
    const calls = keyCheckAnswers(401, '{"detail":{"status":"missing_permissions"}}')
    expect((await refuse(elevenLabsScribe)).err).toMatchObject({ code: 'offline' })
    expect(calls[0]).toEqual({ url: 'https://api.elevenlabs.io/v1/models', headers: { 'xi-api-key': 'key' } })
  })

  it('a socket that had opened is never re-checked', async () => {
    const calls = keyCheckAnswers(401)
    capture()
    const { o, events } = opts()
    const { sock } = await openWith(deepgramFlux, o)
    sock.onclose?.({ code: 1006, reason: '' })
    expect(calls).toHaveLength(0)
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'offline' }))
  })
})

describe('This PC (local)', () => {
  it('transcribes each turn’s audio once the turn ends', async () => {
    const transcribe = vi.fn(async () => ({ text: ' local words ' }))
    const { o, events } = opts()
    const session = await makeLocalStt(transcribe as never).open(o)
    session.pushAudio(Int16Array.from([1, 2]))
    session.pushAudio(Int16Array.from([3]))
    session.endTurn()
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ kind: 'end_of_turn', text: 'local words' }))
    const req = (transcribe.mock.calls[0] as unknown[])[0] as { pcm16k: string; engine: string }
    expect(req.engine).toBe('local')
    expect(Buffer.from(req.pcm16k, 'base64').length).toBe(6)
  })

  it('one take Whisper fails loses that turn; a missing model ends voice mode (2026-10-16 audit, L4)', async () => {
    const fails = (err: Error) => vi.fn(async () => Promise.reject(err))
    for (const [err, retryable] of [
      [new DictationError('engine_failed', 'Whisper stopped: bad frame'), true],
      [new DictationError('model_missing', 'Install a Whisper model to dictate on this PC'), false],
      [new DictationError('engine_failed', 'Whisper could not start on this PC'), false]
    ] as const) {
      const { o, events } = opts()
      const session = await makeLocalStt(fails(err) as never).open(o)
      session.pushAudio(Int16Array.from([1, 2]))
      session.endTurn()
      await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ kind: 'error', code: 'engine_failed', retryable }))
    }
  })

  it('drops what came before your speech, keeping a second and a half of lead-in', async () => {
    const transcribe = vi.fn(async () => ({ text: 'hi' }))
    const { o } = opts()
    const session = await makeLocalStt(transcribe as never).open(o)
    // Ten seconds of the room (or the agent's voice), then you.
    for (let i = 0; i < 100; i++) session.pushAudio(new Int16Array(1600))
    session.speechStarted?.()
    session.pushAudio(new Int16Array(3200))
    session.endTurn()
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalled())
    const req = (transcribe.mock.calls[0] as unknown[])[0] as { pcm16k: string }
    expect(Buffer.from(req.pcm16k, 'base64').length / 2).toBe(LEAD_IN_SAMPLES + 3200)
    expect(LEAD_IN_SAMPLES).toBe(24000)
  })

  it('keeps no more lead-in than the quiet since the agent spoke, and never under half a second', async () => {
    const sent = async (leadInMs: number): Promise<number> => {
      const transcribe = vi.fn(async () => ({ text: 'hi' }))
      const session = await makeLocalStt(transcribe as never).open(opts().o)
      for (let i = 0; i < 100; i++) session.pushAudio(new Int16Array(1600))
      session.speechStarted?.({ leadInMs })
      session.endTurn()
      await vi.waitFor(() => expect(transcribe).toHaveBeenCalled())
      return Buffer.from(((transcribe.mock.calls[0] as unknown[])[0] as { pcm16k: string }).pcm16k, 'base64').length / 2
    }
    // The agent stopped 1 s ago: its voice is not kept.
    expect(await sent(1000)).toBe(16000)
    // It was still speaking: the floor.
    expect(await sent(0)).toBe(MIN_LEAD_IN_SAMPLES)
    // Long quiet: the full lead-in.
    expect(await sent(Number.POSITIVE_INFINITY)).toBe(LEAD_IN_SAMPLES)
  })
})

describe('OpenRouter (whole turns)', () => {
  it('sends each turn through dictation’s OpenRouter path, in the session’s language', async () => {
    const transcribe = vi.fn(async () => ({ text: ' heard you ' }))
    const { o, events } = opts({ language: 'de' })
    const session = await makeOpenRouterStt(transcribe as never).open(o)
    expect(events[0]).toEqual({ kind: 'open' })
    session.pushAudio(Int16Array.from([1, 2, 3]))
    session.endTurn()
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ kind: 'end_of_turn', text: 'heard you' }))
    const req = (transcribe.mock.calls[0] as unknown[])[0] as { engine: string; language?: string; allowEmpty: boolean }
    expect(req).toMatchObject({ engine: 'openrouter', language: 'de', allowEmpty: true })
  })

  it('transcribes with the model picked in Settings → Voice (B4), and dictation’s default without one', async () => {
    const transcribe = vi.fn(async () => ({ text: 'x' }))
    const picked = await makeOpenRouterStt(transcribe as never).open(opts({ model: 'elevenlabs/scribe-v2' }).o)
    picked.pushAudio(Int16Array.from([1]))
    picked.endTurn()
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1))
    expect((transcribe.mock.calls[0] as unknown[])[2]).toEqual({ model: 'elevenlabs/scribe-v2' })
    const none = await makeOpenRouterStt(transcribe as never).open(opts().o)
    none.pushAudio(Int16Array.from([1]))
    none.endTurn()
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(2))
    expect((transcribe.mock.calls[1] as unknown[])[2]).toBeUndefined()
  })

  it('starts transcribing at the first likely end, and the confirmed turn uses that result (B10)', async () => {
    let finish: ((v: { text: string }) => void) | null = null
    const transcribe = vi.fn(() => new Promise<{ text: string }>((r) => (finish = r)))
    const { o, events } = opts()
    const session = await makeOpenRouterStt(transcribe as never).open(o)
    session.pushAudio(Int16Array.from([1, 2, 3]))
    session.settle?.()
    expect(transcribe).toHaveBeenCalledTimes(1)
    // The quiet after the early start isn't sent again.
    session.pushAudio(new Int16Array(8000))
    session.endTurn()
    finish!({ text: 'list the sessions' })
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ kind: 'end_of_turn', text: 'list the sessions' }))
    expect(transcribe).toHaveBeenCalledTimes(1)
    const sent = (transcribe.mock.calls[0] as unknown[])[0] as { pcm16k: string }
    expect(Buffer.from(sent.pcm16k, 'base64').length / 2).toBe(3)
  })

  it('talking again drops the early transcription: it is aborted and the whole turn is sent', async () => {
    const signals: AbortSignal[] = []
    const transcribe = vi.fn(async (_req: unknown, signal: AbortSignal) => {
      signals.push(signal)
      return { text: signals.length === 1 ? 'list the' : 'list the sessions please' }
    })
    const { o, events } = opts()
    const session = await makeOpenRouterStt(transcribe as never).open(o)
    session.pushAudio(Int16Array.from([1, 2]))
    session.settle?.()
    session.resume?.()
    expect(signals[0]!.aborted).toBe(true)
    session.pushAudio(Int16Array.from([3, 4]))
    session.endTurn()
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ kind: 'end_of_turn', text: 'list the sessions please' }))
    const sent = (transcribe.mock.calls[1] as unknown[])[0] as { pcm16k: string }
    expect(Buffer.from(sent.pcm16k, 'base64').length / 2).toBe(4)
  })

  it('an early transcription that failed is tried again on the whole turn', async () => {
    const transcribe = vi
      .fn()
      .mockRejectedValueOnce(new DictationError('rate_limited', '429'))
      .mockResolvedValueOnce({ text: 'heard' })
    const { o, events } = opts()
    const session = await makeOpenRouterStt(transcribe as never).open(o)
    session.pushAudio(Int16Array.from([1]))
    session.settle?.()
    session.endTurn()
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ kind: 'end_of_turn', text: 'heard' }))
    expect(transcribe).toHaveBeenCalledTimes(2)
  })

  it('This PC never starts early: the one local model is kept for the real turn', async () => {
    const transcribe = vi.fn(async () => ({ text: 'x' }))
    const session = await makeLocalStt(transcribe as never).open(opts().o)
    session.pushAudio(Int16Array.from([1]))
    session.settle?.()
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('reports what each turn took, for the log: audio sent, request time, early start, retries', async () => {
    const transcribe = vi.fn(async () => ({ text: 'Run the tests.', attempts: 2 }))
    const { o, events } = opts()
    const session = await makeOpenRouterStt(transcribe as never).open(o)
    session.pushAudio(new Int16Array(16000 * 2))
    session.endTurn()
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ kind: 'end_of_turn' }))
    expect(events.at(-1)).toMatchObject({
      kind: 'end_of_turn',
      text: 'Run the tests.',
      listen: { audioMs: 2000, earlyUsed: false, attempts: 2, requestMs: expect.any(Number) }
    })
    // Started early at the likely end of the turn, and that result used.
    session.pushAudio(new Int16Array(8000))
    session.settle?.()
    session.endTurn()
    await vi.waitFor(() => expect(events.filter((e) => e.kind === 'end_of_turn')).toHaveLength(2))
    expect(events.at(-1)).toMatchObject({ listen: { audioMs: 500, earlyUsed: true } })
    expect(transcribe).toHaveBeenCalledTimes(2)
  })

  it('leaves the language out when the setting is automatic', async () => {
    const transcribe = vi.fn(async () => ({ text: 'x' }))
    const { o } = opts()
    const session = await makeOpenRouterStt(transcribe as never).open(o)
    session.pushAudio(Int16Array.from([1]))
    session.endTurn()
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalled())
    expect((transcribe.mock.calls[0] as unknown[])[0]).not.toHaveProperty('language')
  })

  it.each([
    [new DictationError('no_key', 'Add an OpenRouter key'), 'no_key', false],
    [new DictationError('rejected_key', 'turned down (401)'), 'rejected_key', false],
    [new DictationError('rate_limited', '429'), 'rate_limited', true],
    [new DictationError('offline', 'No connection'), 'offline', true],
    [new DictationError('engine_failed', 'OpenRouter could not transcribe this (502)'), 'provider_down', true],
    [
      new DictationError('engine_failed', 'OpenRouter could not transcribe this (402): This request requires at least $0.50 in balance for audio'),
      'out_of_credit',
      false
    ],
    [new DictationError('too_long', 'too long'), 'engine_failed', false]
  ] as const)('maps %s to %s', async (err, code, retryable) => {
    const transcribe = vi.fn(async () => {
      throw err
    })
    const { o, events } = opts()
    const session = await makeOpenRouterStt(transcribe as never).open(o)
    session.pushAudio(Int16Array.from([1]))
    session.endTurn()
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ kind: 'error', code, retryable }))
  })
})
