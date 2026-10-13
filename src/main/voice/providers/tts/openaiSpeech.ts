/**
 * Text to speech over the OpenAI-compatible `POST …/audio/speech` endpoint,
 * used by both OpenAI and OpenRouter (docs/voice-mode.md §9.4). It takes no
 * streamed text, so each flushed sentence is one request; up to two run at
 * once and their audio is delivered strictly in order, so the next sentence
 * is ready while this one plays.
 */
import { voiceErrorFromStatus, type TtsProviderId, type VoiceErrorCode } from '../../../../shared/voice'
import { PcmAssembler } from '../../pcm'
import type { TtsProvider, TtsStream, TtsStreamOptions, VoiceOption } from '../types'

/** OpenAI's `pcm` format: 24 kHz, 16-bit, mono, little-endian. */
export const OPENAI_PCM_RATE = 24000
const MAX_IN_FLIGHT = 2

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

type Endpoint = { url: string; headers: (key: string) => Record<string, string> }

const ENDPOINTS: Readonly<Record<'openai' | 'openrouter', Endpoint>> = {
  openai: {
    url: 'https://api.openai.com/v1/audio/speech',
    headers: (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' })
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/audio/speech',
    headers: (key) => ({
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://vyotiq.com',
      'X-Title': 'Vyotiq'
    })
  }
}

type Job = { text: string; response: Promise<Response> | null; ctrl: AbortController }

class SpeechHttpStream implements TtsStream {
  private buffer = ''
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
    this.queue.push({ text: piece, response: null, ctrl: new AbortController() })
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
      if (job.response) continue
      job.response = this.fetchImpl(this.endpoint.url, {
        method: 'POST',
        headers: this.endpoint.headers(this.opts.apiKey),
        body: JSON.stringify({
          model: this.opts.model,
          input: job.text,
          voice: this.opts.voiceId,
          response_format: 'pcm',
          speed: this.opts.speed,
          ...(this.opts.model.includes('gpt-4o-mini-tts') ? { instructions: SPEECH_INSTRUCTIONS } : {})
        }),
        signal: job.ctrl.signal
      })
      // Read in order by pump(); a rejection here is handled there.
      job.response.catch(() => {})
    }
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
      this.fail(voiceErrorFromStatus(res.status), `speech HTTP ${res.status}`)
      return false
    }
    const reader = res.body.getReader()
    const pcm = new PcmAssembler()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || this.cancelled) break
        const samples = pcm.push(value)
        if (samples.length > 0) {
          this.opts.onAudio({ pcm: samples, sampleRate: OPENAI_PCM_RATE, contextId: this.opts.contextId })
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
