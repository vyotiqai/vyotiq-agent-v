import { afterEach, describe, expect, it, vi } from 'vitest'
import { PcmAssembler, base64ToInt16 } from '@main/voice/pcm'
import { setOpenVoiceSocketForTests, type VoiceSocket } from '@main/voice/socket'
import { makeOpenAiCompatibleTts, OPENAI_PCM_RATE } from '@main/voice/providers/tts/openaiSpeech'
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
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
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
