/**
 * Deepgram Flux (docs/voice-mode.md §9.3): conversational speech
 * recognition with turn detection built in. Raw 16 kHz linear16 goes up as
 * binary frames; `TurnInfo` messages come back with an `event` of
 * StartOfTurn / Update / EagerEndOfTurn / TurnResumed / EndOfTurn.
 *
 * Eager end-of-turn is deliberately unused: starting the agent on half a
 * sentence could edit files (D-05). Push-to-talk release is `ForceEndTurn`.
 */
import type { TurnPatience, SttOpenOptions, SttProvider } from '../types'
import { SocketStt, int16Bytes, num, str } from './socketStt'

export const FLUX_URL = 'wss://api.deepgram.com/v2/listen'

const PATIENCE: Readonly<Record<TurnPatience, { eot: number; timeoutMs: number }>> = {
  quick: { eot: 0.6, timeoutMs: 3000 },
  normal: { eot: 0.7, timeoutMs: 5000 },
  patient: { eot: 0.85, timeoutMs: 8000 }
}

export function fluxUrl(opts: Pick<SttOpenOptions, 'model' | 'language' | 'patience' | 'keyterms'>): string {
  const english = !opts.language || opts.language === 'en'
  const model = english ? opts.model || 'flux-general-en' : 'flux-general-multi'
  const p = PATIENCE[opts.patience]
  const params = new URLSearchParams({
    model,
    encoding: 'linear16',
    sample_rate: '16000',
    eot_threshold: String(p.eot),
    eot_timeout_ms: String(p.timeoutMs)
  })
  if (!english && opts.language) params.append('language_hint', opts.language)
  for (const term of (opts.keyterms ?? []).slice(0, 100)) params.append('keyterm', term)
  return `${FLUX_URL}?${params}`
}

class FluxSession extends SocketStt {
  private turnText = ''

  constructor(opts: SttOpenOptions) {
    super(fluxUrl(opts), { Authorization: `Token ${opts.apiKey}` }, opts, 'Deepgram')
  }

  protected audioFrame(pcm16k: Int16Array): Uint8Array {
    return int16Bytes(pcm16k)
  }

  protected onMessage(msg: Record<string, unknown>): void {
    const type = str(msg.type)
    if (type === 'TurnInfo') {
      const event = str(msg.event)
      const transcript = str(msg.transcript)
      if (event === 'StartOfTurn') {
        this.turnText = ''
        this.emit({ kind: 'speech_start' })
      }
      if (transcript && event !== 'EndOfTurn') {
        this.turnText = transcript
        this.emit({ kind: 'partial', text: transcript })
      }
      if (event === 'EndOfTurn') {
        const text = (transcript || this.turnText).trim()
        this.turnText = ''
        this.emit({ kind: 'end_of_turn', text, confidence: num(msg.end_of_turn_confidence) })
      }
      return
    }
    if (type === 'Error' || type === 'FatalError') {
      const description = str(msg.description) || str(msg.message) || 'error'
      this.fail(/auth|credential|api key/i.test(description) ? 'rejected_key' : 'engine_failed', `Deepgram: ${description}`)
    }
  }

  endTurn(): void {
    this.sendJson({ type: 'ForceEndTurn' })
  }

  /**
   * While muted. Deepgram closes a stream that gets no audio for about 10 s
   * and documents silent audio as the way to keep it open; Flux documents no
   * KeepAlive message. 100 ms of silence every few seconds.
   */
  keepAlive(): void {
    this.pushAudio(new Int16Array(1600))
  }

  setKeyterms(terms: readonly string[]): void {
    this.sendJson({ type: 'Configure', keyterms: terms.slice(0, 100) })
  }

  protected goodbye(): Record<string, unknown> {
    return { type: 'CloseStream' }
  }
}

export const deepgramFlux: SttProvider = {
  id: 'deepgram',
  async open(opts) {
    const session = new FluxSession(opts)
    await session.ready
    return session
  }
}
