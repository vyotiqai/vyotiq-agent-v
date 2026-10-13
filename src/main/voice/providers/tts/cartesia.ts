/**
 * Cartesia Sonic text to speech over its websocket (docs/voice-mode.md §9.4).
 * One context per reply: text goes in with `continue: true` while more is
 * coming and `continue: false` on the last piece; audio comes back as base64
 * `pcm_s16le` chunks. Barge-in sends `cancel` for the context.
 */
import type { VoiceErrorCode } from '../../../../shared/voice'
import { base64ToInt16 } from '../../pcm'
import { SOCKET_OPEN, openVoiceSocket, parseFrame, type VoiceSocket } from '../../socket'
import type { TtsProvider, TtsStream, TtsStreamOptions, VoiceOption } from '../types'

export const CARTESIA_VERSION = '2026-08-14'
export const CARTESIA_PCM_RATE = 24000
const OPEN_TIMEOUT_MS = 10_000
const API = 'https://api.cartesia.ai'

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, 'X-API-Key': apiKey, 'Cartesia-Version': CARTESIA_VERSION }
}

export function cartesiaErrorCode(message: string, status?: number): VoiceErrorCode {
  const m = message.toLowerCase()
  if (status === 401 || status === 403 || /unauthori[sz]ed|invalid.*key|api key/.test(m)) return 'rejected_key'
  if (status === 402 || /credit|quota|payment|insufficient/.test(m)) return 'out_of_credit'
  if (status === 429 || /rate|too many|concurren/.test(m)) return 'rate_limited'
  return 'engine_failed'
}

class CartesiaStream implements TtsStream {
  private socket: VoiceSocket
  private outbox: string[] = []
  private buffer = ''
  private ended = false
  private settled = false
  private openTimer: ReturnType<typeof setTimeout> | null
  private finished: Promise<void>
  private finish!: () => void

  constructor(
    private readonly opts: TtsStreamOptions,
    private readonly voiceId: string
  ) {
    this.finished = new Promise((resolve) => {
      this.finish = resolve
    })
    const url = `wss://api.cartesia.ai/tts/websocket?cartesia_version=${CARTESIA_VERSION}`
    this.socket = openVoiceSocket(url, authHeaders(opts.apiKey))
    this.openTimer = setTimeout(() => this.fail('offline', 'Cartesia did not connect'), OPEN_TIMEOUT_MS)
    this.socket.onopen = () => {
      if (this.openTimer) clearTimeout(this.openTimer)
      this.openTimer = null
      for (const frame of this.outbox) this.socket.send(frame)
      this.outbox = []
    }
    this.socket.onmessage = (ev) => this.onFrame(parseFrame(ev.data))
    this.socket.onerror = () => this.fail('offline', 'Cartesia connection error')
    this.socket.onclose = (ev) => {
      if (this.settled) return
      this.fail(cartesiaErrorCode(ev.reason ?? ''), `Cartesia closed (${ev.code ?? '?'}) ${ev.reason ?? ''}`)
    }
    opts.signal.addEventListener('abort', () => this.cancel(), { once: true })
  }

  pushText(text: string): void {
    if (!this.settled && !this.ended) this.buffer += text
  }

  flush(): void {
    this.sendPiece(true)
  }

  end(): void {
    if (this.settled || this.ended) return
    this.ended = true
    // The last piece (even empty) says no more text is coming.
    this.sendPiece(false)
  }

  cancel(): void {
    if (this.settled) return
    this.send({ context_id: this.opts.contextId, cancel: true })
    this.settle()
  }

  done(): Promise<void> {
    return this.finished
  }

  private sendPiece(more: boolean): void {
    const piece = this.buffer.trim()
    this.buffer = ''
    if (this.settled || (!piece && more)) return
    this.send({
      model_id: this.opts.model,
      transcript: piece ? `${piece} ` : '',
      voice: { mode: 'id', id: this.voiceId },
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: CARTESIA_PCM_RATE },
      context_id: this.opts.contextId,
      continue: more,
      generation_config: { speed: this.opts.speed }
    })
  }

  private send(frame: Record<string, unknown>): void {
    const data = JSON.stringify(frame)
    if (this.socket.readyState === SOCKET_OPEN) this.socket.send(data)
    else this.outbox.push(data)
  }

  private onFrame(msg: Record<string, unknown> | null): void {
    if (!msg || this.settled) return
    if (msg.type === 'chunk' && typeof msg.data === 'string') {
      const pcm = base64ToInt16(msg.data)
      if (pcm.length > 0) this.opts.onAudio({ pcm, sampleRate: CARTESIA_PCM_RATE, contextId: this.opts.contextId })
      return
    }
    if (msg.type === 'done') {
      if (this.ended) this.settle()
      return
    }
    if (msg.type === 'error' || typeof msg.error === 'string') {
      const text = typeof msg.error === 'string' ? msg.error : typeof msg.message === 'string' ? msg.message : 'error'
      const status = typeof msg.status_code === 'number' ? msg.status_code : undefined
      this.fail(cartesiaErrorCode(text, status), `Cartesia: ${text}`)
    }
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

type CartesiaVoice = { id?: string; name?: string; tagline?: string; description?: string; is_owner?: boolean }

async function fetchVoices(apiKey: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<VoiceOption[]> {
  const voices: VoiceOption[] = []
  let after: string | null = null
  for (let page = 0; page < 3; page++) {
    const params = new URLSearchParams({ limit: '100' })
    if (after) params.set('starting_after', after)
    const res = await fetchImpl(`${API}/voices?${params}`, { headers: authHeaders(apiKey), signal })
    if (!res.ok) throw Object.assign(new Error(`Cartesia voices HTTP ${res.status}`), { status: res.status })
    const body = (await res.json()) as { data?: CartesiaVoice[]; has_more?: boolean; next_page?: string | null }
    for (const v of body.data ?? []) {
      if (!v.id || !v.name) continue
      voices.push({ id: v.id, label: v.name, description: v.tagline || v.description || undefined, custom: v.is_owner === true })
    }
    if (!body.has_more || !body.next_page) break
    after = body.next_page
  }
  return voices.sort((a, b) => Number(Boolean(b.custom)) - Number(Boolean(a.custom)))
}

export function makeCartesiaTts(fetchImpl: typeof fetch = (...args) => fetch(...args)): TtsProvider {
  /** Cartesia has no documented default voice: with none picked, use the first one listed. */
  const firstVoice = new Map<string, Promise<string>>()
  return {
    id: 'cartesia',
    listVoices: (apiKey, signal) => fetchVoices(apiKey, fetchImpl, signal),
    stream(opts) {
      if (opts.voiceId) return new CartesiaStream(opts, opts.voiceId)
      return new DeferredStream(opts, async () => {
        let pick = firstVoice.get(opts.apiKey)
        if (!pick) {
          pick = fetchVoices(opts.apiKey, fetchImpl, opts.signal).then((list) => list[0]?.id ?? '')
          firstVoice.set(opts.apiKey, pick)
          pick.catch(() => firstVoice.delete(opts.apiKey))
        }
        const id = await pick
        if (!id) throw new Error('Cartesia returned no voices')
        return new CartesiaStream(opts, id)
      })
    }
  }
}

/** A stream whose real stream is created after an async step; calls made meanwhile are replayed. */
class DeferredStream implements TtsStream {
  private calls: Array<(s: TtsStream) => void> = []
  private inner: TtsStream | null = null
  private cancelled = false
  private ready: Promise<void>

  constructor(opts: TtsStreamOptions, make: () => Promise<TtsStream>) {
    this.ready = make().then(
      (s) => {
        this.inner = s
        if (this.cancelled) s.cancel()
        for (const call of this.calls) call(s)
        this.calls = []
      },
      (err: unknown) => {
        if (!this.cancelled) opts.onError(cartesiaErrorCode(String(err), (err as { status?: number }).status), String(err))
      }
    )
  }

  private run(call: (s: TtsStream) => void): void {
    if (this.inner) call(this.inner)
    else this.calls.push(call)
  }

  pushText(text: string): void {
    this.run((s) => s.pushText(text))
  }
  flush(): void {
    this.run((s) => s.flush())
  }
  end(): void {
    this.run((s) => s.end())
  }
  cancel(): void {
    this.cancelled = true
    this.inner?.cancel()
  }
  async done(): Promise<void> {
    await this.ready
    await this.inner?.done()
  }
}
