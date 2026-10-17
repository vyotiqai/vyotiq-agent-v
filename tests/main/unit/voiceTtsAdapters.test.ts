import { afterEach, describe, expect, it, vi } from 'vitest'
import { MonoMixer, PcmAssembler, base64ToInt16 } from '@main/voice/pcm'
import { setOpenVoiceSocketForTests, type VoiceSocket } from '@main/voice/socket'
import { makeOpenAiCompatibleTts, OPENAI_PCM_RATE, pcmFormat, resetSpeechModelQuirksForTests } from '@main/voice/providers/tts/openaiSpeech'
import { elevenLabsErrorCode, elevenLabsStreamUrl, makeElevenLabsTts, toVoiceOption } from '@main/voice/providers/tts/elevenlabs'
import { makeCartesiaTts } from '@main/voice/providers/tts/cartesia'
import type { TtsChunk, TtsStreamOptions } from '@main/voice/providers/types'
import type { VoiceErrorCode } from '@shared/voice'

afterEach(() => setOpenVoiceSocketForTests(null))

function pcmBytes(samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  samples.forEach((s, i) => view.setInt16(i * 2, s, true))
  return out
}

function streamOpts(over: Partial<TtsStreamOptions> = {}) {
  const chunks: TtsChunk[] = []
  const errors: VoiceErrorCode[] = []
  const ctrl = new AbortController()
  const opts: TtsStreamOptions = {
    apiKey: 'k',
    model: 'm',
    voiceId: 'v1',
    speed: 1,
    contextId: 'ctx',
    signal: ctrl.signal,
    onAudio: (c) => chunks.push(c),
    onError: (code) => errors.push(code),
    ...over
  }
  return { opts, chunks, errors, ctrl }
}

describe('PCM helpers', () => {
  it('carries an odd byte between HTTP chunks', () => {
    const bytes = pcmBytes([1, -2, 300])
    const a = new PcmAssembler()
    const first = a.push(bytes.subarray(0, 3))
    const second = a.push(bytes.subarray(3))
    expect([...first, ...second]).toEqual([1, -2, 300])
  })

  it('reads the PCM format from Content-Type, OpenAI’s 24 kHz mono when absent', () => {
    expect(pcmFormat('audio/pcm;rate=44100;channels=2')).toEqual({ rate: 44100, channels: 2 })
    expect(pcmFormat('audio/pcm')).toEqual({ rate: OPENAI_PCM_RATE, channels: 1 })
    expect(pcmFormat(null)).toEqual({ rate: OPENAI_PCM_RATE, channels: 1 })
    expect(pcmFormat('audio/pcm;rate=96000')).toEqual({ rate: OPENAI_PCM_RATE, channels: 1 })
  })

  it('mixes interleaved stereo to mono across chunk edges', () => {
    const m = new MonoMixer(2)
    expect([...m.push(Int16Array.from([2, 4, 6]))]).toEqual([3])
    expect([...m.push(Int16Array.from([8]))]).toEqual([7])
    expect([...new MonoMixer(1).push(Int16Array.from([1, 2]))]).toEqual([1, 2])
  })

  it('decodes base64 PCM', () => {
    expect([...base64ToInt16(Buffer.from(pcmBytes([7, -7])).toString('base64'))]).toEqual([7, -7])
  })
})

class FakeSocket implements VoiceSocket {
  readyState = 0
  sent: Record<string, unknown>[] = []
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
    if (typeof data === 'string') this.sent.push(JSON.parse(data) as Record<string, unknown>)
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

function captureSockets(): FakeSocket[] {
  const sockets: FakeSocket[] = []
  setOpenVoiceSocketForTests((url, headers) => {
    const s = new FakeSocket(url, headers)
    sockets.push(s)
    return s
  })
  return sockets
}

describe('OpenAI-compatible speech (OpenAI, OpenRouter)', () => {
  function fakeFetch(bodies: Record<string, Uint8Array[]>, status = 200) {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const fn = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      calls.push({ url, body })
      const parts = bodies[String(body.input)] ?? []
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (const p of parts) c.enqueue(p)
          c.close()
        }
      })
      return new Response(status === 200 ? stream : null, { status })
    })
    return { fn: fn as unknown as typeof fetch, calls }
  }

  it('sends one request per sentence and delivers audio in order', async () => {
    const { fn, calls } = fakeFetch({ 'First.': [pcmBytes([1, 2])], 'Second.': [pcmBytes([3]), pcmBytes([4])] })
    const { opts, chunks } = streamOpts({ model: 'gpt-4o-mini-tts', voiceId: 'alloy', speed: 1.1 })
    const s = makeOpenAiCompatibleTts('openai', fn).stream(opts)
    s.pushText('First.')
    s.flush()
    s.pushText('Second.')
    s.end()
    await s.done()
    expect(chunks.flatMap((c) => [...c.pcm])).toEqual([1, 2, 3, 4])
    expect(chunks.every((c) => c.sampleRate === OPENAI_PCM_RATE && c.contextId === 'ctx')).toBe(true)
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/audio/speech')
    expect(calls[0]!.body).toMatchObject({ model: 'gpt-4o-mini-tts', voice: 'alloy', response_format: 'pcm', speed: 1.1 })
    expect(calls[0]!.body.instructions).toBeTypeOf('string')
  })

  it('marks the first audio of each sentence with its piece, so captions keep pace with the voice', async () => {
    const { fn } = fakeFetch({ 'First.': [pcmBytes([1]), pcmBytes([2])], 'Second.': [pcmBytes([3]), pcmBytes([4])] })
    const { opts, chunks } = streamOpts()
    const s = makeOpenAiCompatibleTts('openrouter', fn).stream(opts)
    s.pushText('First.')
    s.flush()
    s.pushText('Second.')
    s.end()
    await s.done()
    expect(chunks.map((c) => c.piece)).toEqual([0, undefined, 1, undefined])
  })

  it('targets OpenRouter with its headers and maps HTTP failures to typed codes', async () => {
    const { fn, calls } = fakeFetch({}, 401)
    const { opts, errors } = streamOpts()
    const s = makeOpenAiCompatibleTts('openrouter', fn).stream(opts)
    s.pushText('Hi.')
    s.end()
    await s.done()
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/audio/speech')
    expect(errors).toEqual(['rejected_key'])
  })

  it('keeps the provider’s reason from a JSON error body (D-40)', async () => {
    const fn = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'Model openai/gpt-4o-mini-tts-2025-12-15 not found', code: 404 } }), {
          status: 404
        })
    ) as unknown as typeof fetch
    const messages: string[] = []
    const { opts, errors } = streamOpts({ onError: (code, message) => (errors.push(code), messages.push(message)) })
    const s = makeOpenAiCompatibleTts('openrouter', fn).stream(opts)
    s.pushText('Hi.')
    s.end()
    await s.done()
    expect(errors).toEqual(['engine_failed'])
    expect(messages).toEqual(['OpenRouter (404): Model openai/gpt-4o-mini-tts-2025-12-15 not found'])
  })

  it('a 402 is out of credit, with the text of a non-JSON body', async () => {
    const fn = vi.fn(async () => new Response('Insufficient credits', { status: 402 })) as unknown as typeof fetch
    const messages: string[] = []
    const { opts, errors } = streamOpts({ onError: (code, message) => (errors.push(code), messages.push(message)) })
    const s = makeOpenAiCompatibleTts('openrouter', fn).stream(opts)
    s.pushText('Hi.')
    s.end()
    await s.done()
    expect(errors).toEqual(['out_of_credit'])
    expect(messages).toEqual(['OpenRouter (402): Insufficient credits'])
  })

  it('sends speed only when it isn’t Normal (A-13)', async () => {
    const { fn, calls } = fakeFetch({ 'Hi.': [pcmBytes([1])] })
    const s = makeOpenAiCompatibleTts('openrouter', fn).stream(streamOpts({ speed: 1 }).opts)
    s.pushText('Hi.')
    s.end()
    await s.done()
    expect(calls[0]!.body).not.toHaveProperty('speed')
  })

  it('a model that refuses a voice speaks in its own, and isn’t asked with one again (2026-10-16 audit 3, A13)', async () => {
    resetSpeechModelQuirksForTests()
    const bodies: Array<Record<string, unknown>> = []
    const fn = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      bodies.push(body)
      if ('voice' in body) return new Response(JSON.stringify({ error: { message: 'This model does not support the voice parameter.' } }), { status: 400 })
      return new Response(pcmBytes([1, 2]), { status: 200, headers: { 'content-type': 'audio/pcm;rate=44100;channels=1' } })
    }) as unknown as typeof fetch
    const { opts, chunks, errors } = streamOpts({ model: 'fish-audio/s1', voiceId: 'alloy' })
    const s = makeOpenAiCompatibleTts('openrouter', fn).stream(opts)
    s.pushText('Hi.')
    s.end()
    await s.done()
    expect(errors).toEqual([])
    expect(chunks).toHaveLength(1)
    expect(bodies.at(-1)).not.toHaveProperty('voice')
    const again = makeOpenAiCompatibleTts('openrouter', fn).stream(streamOpts({ model: 'fish-audio/s1', voiceId: 'alloy' }).opts)
    const before = bodies.length
    again.pushText('Again.')
    again.end()
    await again.done()
    expect(bodies.slice(before)).toEqual([expect.not.objectContaining({ voice: expect.anything() })])
    resetSpeechModelQuirksForTests()
  })

  it('a model that refuses speed says it at its own pace, and isn’t asked with speed again (Eleven v4, probed)', async () => {
    resetSpeechModelQuirksForTests()
    const bodies: Array<Record<string, unknown>> = []
    const fn = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      bodies.push(body)
      if ('speed' in body) {
        return new Response(JSON.stringify({ error: { message: 'speed is not supported by eleven_v4; omit it or use a model with speed control.', code: 400 } }), {
          status: 400
        })
      }
      return new Response(pcmBytes([1, 2]), { status: 200, headers: { 'content-type': 'audio/pcm;rate=24000;channels=1' } })
    }) as unknown as typeof fetch
    const { opts, chunks, errors } = streamOpts({ model: 'elevenlabs/eleven-v4', speed: 1.1 })
    const s = makeOpenAiCompatibleTts('openrouter', fn).stream(opts)
    s.pushText('First.')
    s.flush()
    s.pushText('Second.')
    s.end()
    await s.done()
    expect(errors).toEqual([])
    expect(chunks).toHaveLength(2)
    // The first sentence's two in-flight requests may both carry speed; nothing after the refusal does.
    expect(bodies.filter((b) => !('speed' in b)).map((b) => b.input)).toEqual(['First.', 'Second.'])
    const again = makeOpenAiCompatibleTts('openrouter', fn).stream(streamOpts({ model: 'elevenlabs/eleven-v4', speed: 1.1 }).opts)
    const before = bodies.length
    again.pushText('Third.')
    again.end()
    await again.done()
    expect(bodies.slice(before)).toEqual([expect.not.objectContaining({ speed: expect.anything() })])
    resetSpeechModelQuirksForTests()
  })

  it('plays at the rate the response states, and mixes stereo to mono (A-16)', async () => {
    const respond = (contentType: string, samples: number[]) =>
      vi.fn(async () => {
        const bytes = pcmBytes(samples)
        // Split mid-frame and mid-sample, as a network would.
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes.subarray(0, 3))
            c.enqueue(bytes.subarray(3))
            c.close()
          }
        })
        return new Response(stream, { status: 200, headers: { 'content-type': contentType } })
      }) as unknown as typeof fetch

    const fish = streamOpts()
    const a = makeOpenAiCompatibleTts('openrouter', respond('audio/pcm;rate=44100;channels=1', [5, 6])).stream(fish.opts)
    a.pushText('Hi.')
    a.end()
    await a.done()
    expect(fish.chunks.every((c) => c.sampleRate === 44100)).toBe(true)
    expect(fish.chunks.flatMap((c) => [...c.pcm])).toEqual([5, 6])

    const seed = streamOpts()
    const b = makeOpenAiCompatibleTts('openrouter', respond('audio/pcm;rate=24000;channels=2', [10, 20, -4, -8])).stream(seed.opts)
    b.pushText('Hi.')
    b.end()
    await b.done()
    expect(seed.chunks.flatMap((c) => [...c.pcm])).toEqual([15, -6])
    expect(seed.chunks.every((c) => c.sampleRate === 24000)).toBe(true)
  })

  it('cancel stops delivery and finishes', async () => {
    const { fn } = fakeFetch({ 'One.': [pcmBytes([1])] })
    const { opts, chunks } = streamOpts()
    const s = makeOpenAiCompatibleTts('openai', fn).stream(opts)
    s.pushText('One.')
    s.flush()
    s.cancel()
    await s.done()
    expect(chunks).toHaveLength(0)
  })
})

describe('ElevenLabs websocket', () => {
  it('initialises the context, flushes sentences, and decodes audio until isFinal', async () => {
    const sockets = captureSockets()
    const { opts, chunks } = streamOpts({ voiceId: 'voice 1', model: 'eleven_flash_v2_5', speed: 1.1 })
    const s = makeElevenLabsTts().stream(opts)
    const sock = sockets[0]!
    expect(sock.url).toBe(elevenLabsStreamUrl('voice 1', 'eleven_flash_v2_5'))
    expect(sock.url).toContain('voice%201')
    expect(sock.url).toContain('output_format=pcm_24000')
    expect(sock.headers).toEqual({ 'xi-api-key': 'k' })
    s.pushText('Hello there.')
    s.flush()
    s.end()
    sock.open()
    expect(sock.sent).toEqual([
      { text: ' ', context_id: 'ctx', voice_settings: { speed: 1.1 } },
      { text: 'Hello there. ', context_id: 'ctx', flush: true },
      { context_id: 'ctx', close_context: true }
    ])
    sock.frame({ audio: Buffer.from(pcmBytes([5, 6])).toString('base64'), contextId: 'ctx' })
    sock.frame({ isFinal: true, contextId: 'ctx' })
    await s.done()
    expect(chunks.map((c) => [...c.pcm])).toEqual([[5, 6]])
    expect(sock.closed).toBe(true)
  })

  it('barge-in closes the context and the socket', async () => {
    const sockets = captureSockets()
    const { opts } = streamOpts()
    const s = makeElevenLabsTts().stream(opts)
    sockets[0]!.open()
    s.cancel()
    await s.done()
    expect(sockets[0]!.sent.slice(-2)).toEqual([{ context_id: 'ctx', close_context: true }, { close_socket: true }])
  })

  it('maps vendor errors to typed codes', async () => {
    expect(elevenLabsErrorCode('invalid_api_key')).toBe('rejected_key')
    expect(elevenLabsErrorCode('quota_exceeded: not enough credits')).toBe('out_of_credit')
    expect(elevenLabsErrorCode('too many concurrent requests')).toBe('rate_limited')
    const sockets = captureSockets()
    const { opts, errors } = streamOpts()
    const s = makeElevenLabsTts().stream(opts)
    sockets[0]!.open()
    sockets[0]!.onclose?.({ code: 1008, reason: 'Invalid API key' })
    await s.done()
    expect(errors).toEqual(['rejected_key'])
  })

  it('lists voices, yours first', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        voices: [
          { voice_id: 'a', name: 'Aria', category: 'premade', labels: { accent: 'American', use_case: 'narration' } },
          { voice_id: 'b', name: 'My clone', category: 'cloned' }
        ],
        has_more: false
      })
    ) as unknown as typeof fetch
    const voices = await makeElevenLabsTts(fetchImpl).listVoices!('k')
    expect(voices.map((v) => v.id)).toEqual(['b', 'a'])
    expect(voices[1]!.description).toBe('American · narration')
    expect(toVoiceOption({ name: 'no id' })).toBeNull()
  })
})

describe('Cartesia websocket', () => {
  it('streams pieces with continue, then a final piece, and decodes chunks', async () => {
    const sockets = captureSockets()
    const { opts, chunks } = streamOpts({ model: 'sonic-3.6', voiceId: 'cv', speed: 0.9 })
    const s = makeCartesiaTts().stream(opts)
    const sock = sockets[0]!
    expect(sock.headers.Authorization).toBe('Bearer k')
    s.pushText('Done.')
    s.flush()
    s.end()
    sock.open()
    expect(sock.sent[0]).toMatchObject({
      transcript: 'Done. ',
      continue: true,
      voice: { mode: 'id', id: 'cv' },
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
      generation_config: { speed: 0.9 }
    })
    expect(sock.sent[1]).toMatchObject({ transcript: '', continue: false })
    sock.frame({ type: 'chunk', data: Buffer.from(pcmBytes([9])).toString('base64'), context_id: 'ctx' })
    sock.frame({ type: 'done', context_id: 'ctx' })
    await s.done()
    expect(chunks.map((c) => [...c.pcm])).toEqual([[9]])
  })

  it('picks the first listed voice when none is chosen', async () => {
    const sockets = captureSockets()
    const fetchImpl = vi.fn(async () => Response.json({ data: [{ id: 'first', name: 'First' }], has_more: false })) as unknown as typeof fetch
    const { opts } = streamOpts({ voiceId: '' })
    const s = makeCartesiaTts(fetchImpl).stream(opts)
    s.pushText('Hi.')
    s.end()
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    sockets[0]!.open()
    expect(sockets[0]!.sent[0]).toMatchObject({ voice: { mode: 'id', id: 'first' } })
    s.cancel()
    await s.done()
  })
})
