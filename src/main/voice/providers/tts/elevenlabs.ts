/**
 * ElevenLabs text to speech over the multi-context websocket
 * (docs/voice-mode.md §9.4). Text streams in as the agent writes it and is
 * flushed at sentence ends; audio streams back as base64 PCM. Barge-in closes
 * the context, which stops generation at the vendor too.
 *
 * Note the casing: client frames use `context_id`, server frames `contextId`
 * and `isFinal`.
 */
import type { VoiceErrorCode } from '../../../../shared/voice'
import { base64ToInt16 } from '../../pcm'
import { SOCKET_OPEN, openVoiceSocket, parseFrame, type VoiceSocket } from '../../socket'
import type { TtsProvider, TtsStream, TtsStreamOptions, VoiceOption } from '../types'

export const ELEVENLABS_PCM_RATE = 24000
const OPEN_TIMEOUT_MS = 10_000
const API = 'https://api.elevenlabs.io'

export function elevenLabsStreamUrl(voiceId: string, model: string): string {
  const params = new URLSearchParams({
    model_id: model,
    output_format: `pcm_${ELEVENLABS_PCM_RATE}`,
    // Long agent work between sentences must not time the context out.
    inactivity_timeout: '180'
  })
  return `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/multi-stream-input?${params}`
}

/** Vendor error text → typed code. Only the code reaches the UI. */
export function elevenLabsErrorCode(message: string, closeCode?: number): VoiceErrorCode {
  const m = message.toLowerCase()
  if (/invalid.?api.?key|unauthori[sz]ed|authentication|401/.test(m) || closeCode === 1008) return 'rejected_key'
  if (/quota|credits?|insufficient|payment|402/.test(m)) return 'out_of_credit'
  if (/rate|too many|429|concurren/.test(m)) return 'rate_limited'
  if (/voice.*not.*found|voice_not_found/.test(m)) return 'engine_failed'
  return 'engine_failed'
}

class ElevenLabsStream implements TtsStream {
  private socket: VoiceSocket
  private outbox: string[] = []
  private buffer = ''
  private ended = false
  private settled = false
  private openTimer: ReturnType<typeof setTimeout> | null
  private finished: Promise<void>
  private finish!: () => void

  constructor(private readonly opts: TtsStreamOptions) {
    this.finished = new Promise((resolve) => {
      this.finish = resolve
    })
    const contextId = opts.contextId
    this.socket = openVoiceSocket(elevenLabsStreamUrl(opts.voiceId, opts.model), { 'xi-api-key': opts.apiKey })
    // The first frame initialises the context with its voice settings; text must be a single space.
    this.send({ text: ' ', context_id: contextId, voice_settings: { speed: opts.speed } })
    this.openTimer = setTimeout(() => this.fail('offline', 'ElevenLabs did not connect'), OPEN_TIMEOUT_MS)
    this.socket.onopen = () => {
      if (this.openTimer) clearTimeout(this.openTimer)
      this.openTimer = null
      for (const frame of this.outbox) this.socket.send(frame)
      this.outbox = []
    }
    this.socket.onmessage = (ev) => this.onFrame(parseFrame(ev.data))
    this.socket.onerror = () => this.fail('offline', 'ElevenLabs connection error')
    this.socket.onclose = (ev) => {
      if (this.settled) return
      if (this.ended && ev.code === 1000) return this.settle()
      this.fail(elevenLabsErrorCode(ev.reason ?? '', ev.code), `ElevenLabs closed (${ev.code ?? '?'}) ${ev.reason ?? ''}`)
    }
    opts.signal.addEventListener('abort', () => this.cancel(), { once: true })
  }

  pushText(text: string): void {
    if (this.settled || this.ended) return
    this.buffer += text
  }

  flush(): void {
    const piece = this.buffer.trim()
    this.buffer = ''
    if (!piece || this.settled) return
    // Text should end with a space; flush asks for audio for everything buffered.
    this.send({ text: `${piece} `, context_id: this.opts.contextId, flush: true })
  }

  end(): void {
    if (this.settled || this.ended) return
    this.flush()
    this.ended = true
    // Closing a flushing context lets it finish; isFinal arrives when it has.
    this.send({ context_id: this.opts.contextId, close_context: true })
  }

  cancel(): void {
    if (this.settled) return
    this.send({ context_id: this.opts.contextId, close_context: true })
    this.send({ close_socket: true })
    this.settle()
  }

  done(): Promise<void> {
    return this.finished
  }

  private send(frame: Record<string, unknown>): void {
    const data = JSON.stringify(frame)
    if (this.socket.readyState === SOCKET_OPEN) this.socket.send(data)
    else this.outbox.push(data)
  }

  private onFrame(msg: Record<string, unknown> | null): void {
    if (!msg || this.settled) return
    if (typeof msg.audio === 'string' && msg.audio.length > 0) {
      const pcm = base64ToInt16(msg.audio)
      if (pcm.length > 0) this.opts.onAudio({ pcm, sampleRate: ELEVENLABS_PCM_RATE, contextId: this.opts.contextId })
    }
    if (msg.isFinal === true) {
      this.send({ close_socket: true })
      this.settle()
      return
    }
    const error = typeof msg.error === 'string' ? msg.error : typeof msg.message === 'string' && !msg.audio ? msg.message : null
    if (error) this.fail(elevenLabsErrorCode(error), `ElevenLabs: ${error}`)
  }

  private fail(code: VoiceErrorCode, message: string): void {
    if (this.settled) return
    this.opts.onError(code, message)
    this.settle()
  }

  private settle(): void {
    if (this.settled) return
    this.settled = true
    if (this.openTimer) clearTimeout(this.openTimer)
    try {
      this.socket.close(1000)
    } catch {
      /* already closed */
    }
    this.finish()
  }
}

type ElevenLabsVoice = {
  voice_id?: string
  name?: string
  category?: string
  description?: string | null
  labels?: Record<string, string> | null
  preview_url?: string | null
}

export function toVoiceOption(v: ElevenLabsVoice): VoiceOption | null {
  if (!v.voice_id || !v.name) return null
  const labels = v.labels ? Object.values(v.labels).filter(Boolean).slice(0, 3) : []
  const custom = v.category === 'cloned' || v.category === 'generated' || v.category === 'professional'
  return {
    id: v.voice_id,
    label: v.name,
    description: labels.length > 0 ? labels.join(' · ') : (v.description ?? undefined) || undefined,
    custom,
    previewUrl: v.preview_url ?? undefined
  }
}

export function makeElevenLabsTts(fetchImpl: typeof fetch = (...args) => fetch(...args)): TtsProvider {
  return {
    id: 'elevenlabs',
    async listVoices(apiKey, signal) {
      const voices: VoiceOption[] = []
      let token: string | null = null
      // Your own voices first, then the rest; at most three pages.
      for (let page = 0; page < 3; page++) {
        const params = new URLSearchParams({ page_size: '100', include_total_count: 'false' })
        if (token) params.set('next_page_token', token)
        const res = await fetchImpl(`${API}/v2/voices?${params}`, { headers: { 'xi-api-key': apiKey }, signal })
        if (!res.ok) throw Object.assign(new Error(`ElevenLabs voices HTTP ${res.status}`), { status: res.status })
        const body = (await res.json()) as { voices?: ElevenLabsVoice[]; has_more?: boolean; next_page_token?: string | null }
        for (const v of body.voices ?? []) {
          const option = toVoiceOption(v)
          if (option) voices.push(option)
        }
        if (!body.has_more || !body.next_page_token) break
        token = body.next_page_token
      }
      return voices.sort((a, b) => Number(Boolean(b.custom)) - Number(Boolean(a.custom)))
    },
    stream: (opts) => new ElevenLabsStream(opts)
  }
}
