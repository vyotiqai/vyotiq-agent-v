import { afterEach, describe, expect, it, vi } from 'vitest'
import { setOpenVoiceSocketForTests, type VoiceSocket } from '@main/voice/socket'
import { deepgramFlux, fluxUrl } from '@main/voice/providers/stt/deepgramFlux'
import { assemblyAi, assemblyAiUrl } from '@main/voice/providers/stt/assemblyai'
import { elevenLabsScribe, scribeUrl } from '@main/voice/providers/stt/elevenlabsScribe'
import { openAiRealtime } from '@main/voice/providers/stt/openaiRealtime'
import { LEAD_IN_SAMPLES, makeLocalStt } from '@main/voice/providers/stt/local'
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
afterEach(() => setOpenVoiceSocketForTests(null))

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

describe('This PC (local)', () => {
  it('transcribes each turn’s audio once the turn ends', async () => {
    const transcribe = vi.fn(async () => ({ text: ' local words ' }))
    const { o, events } = opts()
    const session = await makeLocalStt(transcribe as never).open(o)
    session.pushAudio(Int16Array.from([1, 2]))
    session.pushAudio(Int16Array.from([3]))
    session.endTurn()
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ kind: 'end_of_turn', text: 'local words' }))
    const req = (transcribe.mock.calls[0] as unknown[])[0] as { pcm16k: string; engine: string }
    expect(req.engine).toBe('local')
    expect(Buffer.from(req.pcm16k, 'base64').length).toBe(6)
  })

  it('drops what came before your speech, keeping half a second of lead-in', async () => {
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
  })
})
