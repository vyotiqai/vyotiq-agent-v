/**
 * Text to speech over the OpenAI-compatible `POST …/audio/speech` endpoint,
 * used by both OpenAI and OpenRouter (docs/voice-mode.md §9.4). It takes no
 * streamed text, so each flushed sentence is one request; up to two run at
 * once and their audio is delivered strictly in order, so the next sentence
 * is ready while this one plays.
 */
import { voiceErrorFromStatus, type TtsProviderId, type VoiceErrorCode } from '../../../../shared/voice'
import { MonoMixer, PcmAssembler } from '../../pcm'
import type { TtsProvider, TtsStream, TtsStreamOptions, VoiceOption } from '../types'

/** OpenAI's `pcm` format: 24 kHz, 16-bit, mono, little-endian. */
export const OPENAI_PCM_RATE = 24000

/**
 * The PCM format a response states in `Content-Type`. OpenRouter says it
 * per model (`audio/pcm;rate=44100;channels=1`), and it isn't always 24 kHz
 * mono: HeyGen and Fish Audio send 44.1 kHz, ByteDance Seed sends stereo
 * (probed 2026-10-14, A-16). Without one, OpenAI's 24 kHz mono.
 */
export function pcmFormat(contentType: string | null): { rate: number; channels: number } {
  const rate = Number(/rate=(\d+)/i.exec(contentType ?? '')?.[1])
  const channels = Number(/channels=(\d+)/i.exec(contentType ?? '')?.[1])
  return {
    rate: rate >= 8000 && rate <= 48000 ? rate : OPENAI_PCM_RATE,
    channels: channels >= 1 && channels <= 8 ? channels : 1
  }
}
const MAX_IN_FLIGHT = 2

/**
 * Models that refused `speed` this run (probed 2026-10-14: Eleven v4 answers
 * 400 "speed is not supported by eleven_v4"). The sentence is asked again
 * without it, and so is every later one: a changed speed must not cost the
 * voice.
 */
const noSpeedModels = new Set<string>()

/** Tests only. */
export function resetSpeechModelQuirksForTests(): void {
  noSpeedModels.clear()
}

/** How the voice should sound; honoured by models that take `instructions`. */
export const SPEECH_INSTRUCTIONS =
  'Speak like a calm, friendly colleague: clear, natural and unhurried, with an even tone. Don’t sound like an announcer.'

export const OPENAI_VOICES: readonly VoiceOption[] = [
  { id: 'alloy', label: 'Alloy', description: 'Neutral, balanced' },
  { id: 'ash', label: 'Ash', description: 'Warm, clear' },
  { id: 'ballad', label: 'Ballad', description: 'Soft, expressive' },
  { id: 'coral', label: 'Coral', description: 'Bright, friendly' },
  { id: 'echo', label: 'Echo', description: 'Steady, low' },
  { id: 'fable', label: 'Fable', description: 'Storyteller, British' },
  { id: 'nova', label: 'Nova', description: 'Energetic, youthful' },
  { id: 'onyx', label: 'Onyx', description: 'Deep, authoritative' },
  { id: 'sage', label: 'Sage', description: 'Calm, measured' },
  { id: 'shimmer', label: 'Shimmer', description: 'Light, gentle' },
  { id: 'verse', label: 'Verse', description: 'Versatile, expressive' }
]

type Endpoint = { label: string; url: string; headers: (key: string) => Record<string, string> }

/** The provider's own words from an error response: `error.message` in JSON, else the text. */
async function errorReason(res: Response): Promise<string> {
  let raw = ''
  try {
    raw = await res.text()
  } catch {
    return 'no details'
  }
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown } | string; message?: unknown }
    const message =
      typeof parsed.error === 'string' ? parsed.error : typeof parsed.error?.message === 'string' ? parsed.error.message : parsed.message
    if (typeof message === 'string' && message.trim()) return message.trim()
  } catch {
    // not JSON
  }
  return raw.trim() || 'no details'
}

const ENDPOINTS: Readonly<Record<'openai' | 'openrouter', Endpoint>> = {
  openai: {
    label: 'OpenAI',
    url: 'https://api.openai.com/v1/audio/speech',
    headers: (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' })
  },
  openrouter: {
    label: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/audio/speech',
    headers: (key) => ({
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://vyotiq.com',
      'X-Title': 'Vyotiq'
    })
  }
}

/** One flushed piece; `index` counts pieces in this stream, so its first audio can say which it is. */
type Job = { text: string; index: number; response: Promise<Response> | null; ctrl: AbortController; sentSpeed: boolean }

class SpeechHttpStream implements TtsStream {
  private buffer = ''
  private pieces = 0
  private queue: Job[] = []
  private running = false
  private ended = false
  private cancelled = false
  private finished: Promise<void>
  private finish!: () => void

  constructor(
    private readonly endpoint: Endpoint,
    private readonly opts: TtsStreamOptions,
    private readonly fetchImpl: typeof fetch
  ) {
    this.finished = new Promise((resolve) => {
      this.finish = resolve
    })
    opts.signal.addEventListener('abort', () => this.cancel(), { once: true })
  }

  pushText(text: string): void {
    if (!this.cancelled && !this.ended) this.buffer += text
  }

  flush(): void {
    const piece = this.buffer.trim()
    this.buffer = ''
    if (!piece || this.cancelled) return
    this.queue.push({ text: piece, index: this.pieces++, response: null, ctrl: new AbortController(), sentSpeed: false })
    this.startRequests()
    void this.pump()
  }

  end(): void {
    this.flush()
    this.ended = true
    void this.pump()
  }

  cancel(): void {
    if (this.cancelled) return
    this.cancelled = true
    this.buffer = ''
    for (const job of this.queue) job.ctrl.abort()
    this.queue = []
    this.finish()
  }

  done(): Promise<void> {
    return this.finished
  }

  private startRequests(): void {
    for (const job of this.queue.slice(0, MAX_IN_FLIGHT)) {
      if (!job.response) this.request(job)
    }
  }

  private request(job: Job): void {
    // Only when changed: models without speed control may refuse any value (A-13).
    job.sentSpeed = this.opts.speed !== 1 && !noSpeedModels.has(this.opts.model)
    job.response = this.fetchImpl(this.endpoint.url, {
      method: 'POST',
      headers: this.endpoint.headers(this.opts.apiKey),
      body: JSON.stringify({
        model: this.opts.model,
        input: job.text,
        voice: this.opts.voiceId,
        response_format: 'pcm',
        ...(job.sentSpeed ? { speed: this.opts.speed } : {}),
        ...(this.opts.model.includes('gpt-4o-mini-tts') ? { instructions: SPEECH_INSTRUCTIONS } : {})
      }),
      signal: job.ctrl.signal
    })
    // Read in order by pump(); a rejection here is handled there.
    job.response.catch(() => {})
  }

  /** Deliver jobs' audio strictly in order, one at a time. */
  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (!this.cancelled && this.queue.length > 0) {
        const job = this.queue[0]!
        this.startRequests()
        const ok = await this.play(job)
        this.queue.shift()
        if (!ok) {
          this.cancel()
          return
        }
      }
      if (this.ended && this.queue.length === 0) this.finish()
    } finally {
      this.running = false
    }
  }

  private async play(job: Job): Promise<boolean> {
    let res: Response
    try {
      res = await job.response!
    } catch (err) {
      if (this.cancelled) return true
      this.fail('offline', err instanceof Error ? err.message : String(err))
      return false
    }
    if (!res.ok || !res.body) {
      // Non-200s carry a JSON error body; its message is the reason worth showing (D-40).
      const reason = res.ok ? 'no audio in the response' : await errorReason(res)
      if (res.status === 400 && job.sentSpeed && /\bspeed\b/i.test(reason) && !this.cancelled) {
        // This model takes no speed: say it at its own pace rather than not at all.
        noSpeedModels.add(this.opts.model)
        this.request(job)
        return this.play(job)
      }
      this.fail(voiceErrorFromStatus(res.status), `${this.endpoint.label} (${res.status}): ${reason}`)
      return false
    }
    const reader = res.body.getReader()
    const pcm = new PcmAssembler()
    const format = pcmFormat(res.headers.get('content-type'))
    const mono = new MonoMixer(format.channels)
    let first = true
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || this.cancelled) break
        const samples = mono.push(pcm.push(value))
        if (samples.length > 0) {
          this.opts.onAudio({ pcm: samples, sampleRate: format.rate, contextId: this.opts.contextId, ...(first ? { piece: job.index } : {}) })
          first = false
        }
      }
    } catch (err) {
      if (this.cancelled) return true
      this.fail('offline', err instanceof Error ? err.message : String(err))
      return false
    } finally {
      reader.releaseLock()
    }
    return true
  }

  private fail(code: VoiceErrorCode, message: string): void {
    if (!this.cancelled) this.opts.onError(code, message)
  }
}

export function makeOpenAiCompatibleTts(
  id: Extract<TtsProviderId, 'openai' | 'openrouter'>,
  fetchImpl: typeof fetch = (...args) => fetch(...args)
): TtsProvider {
  const endpoint = ENDPOINTS[id]
  return {
    id,
    // A fixed set: OpenAI has no voice-list endpoint, and OpenRouter's OpenAI model takes the same names.
    listVoices: async () => [...OPENAI_VOICES],
    stream: (opts) => new SpeechHttpStream(endpoint, opts, fetchImpl)
  }
}
