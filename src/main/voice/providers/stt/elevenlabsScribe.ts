/**
 * ElevenLabs Scribe Realtime (docs/voice-mode.md §9.3). JSON frames carry
 * base64 16 kHz PCM; a frame with `commit: true` finalises what was said so
 * far. Scribe has no turn detection of its own here, so the session commits
 * when the local pause detector (or push-to-talk) ends the turn.
 */
import type { SttOpenOptions, SttProvider } from '../types'
import { SocketStt, int16Base64, str, type KeyCheck } from './socketStt'

export function scribeUrl(opts: Pick<SttOpenOptions, 'model' | 'language'>): string {
  const params = new URLSearchParams({
    model_id: opts.model || 'scribe_v2_realtime',
    audio_format: 'pcm_16000',
    // The session decides when a turn ends and commits it; the vendor's own
    // default (VAD or turn prediction) isn't documented for this model.
    commit_strategy: 'manual'
  })
  if (opts.language) params.set('language_code', opts.language)
  return `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params}`
}

class ScribeSession extends SocketStt {
  private heard = ''
  private speaking = false
  private committing = false

  constructor(opts: SttOpenOptions) {
    super(scribeUrl(opts), { 'xi-api-key': opts.apiKey }, opts, 'ElevenLabs')
  }

  protected keyCheck(): KeyCheck {
    return { url: 'https://api.elevenlabs.io/v1/models', headers: { 'xi-api-key': this.opts.apiKey } }
  }

  protected audioFrame(pcm16k: Int16Array): string {
    return JSON.stringify({
      message_type: 'input_audio_chunk',
      audio_base_64: int16Base64(pcm16k),
      commit: false,
      sample_rate: 16000
    })
  }

  protected onMessage(msg: Record<string, unknown>): void {
    const type = str(msg.message_type)
    const text = str(msg.text).trim()
    if (type === 'partial_transcript') {
      if (!text) return
      if (!this.speaking) {
        this.speaking = true
        this.emit({ kind: 'speech_start' })
      }
      this.emit({ kind: 'partial', text: this.join(text) })
      return
    }
    if (type === 'committed_transcript' || type === 'committed_transcript_with_timestamps') {
      if (text) this.heard = this.join(text)
      if (this.committing) {
        const whole = this.heard.trim()
        this.heard = ''
        this.speaking = false
        this.committing = false
        this.emit({ kind: 'end_of_turn', text: whole })
      } else if (text) {
        // Committed by the vendor mid-turn: settled words, more may follow.
        this.emit({ kind: 'final', text })
      }
      return
    }
    if (type.endsWith('error') || type === 'input_error') {
      const message = str(msg.error) || str(msg.message) || type
      this.fail(/auth|api key|unauthori[sz]ed/i.test(message) ? 'rejected_key' : 'engine_failed', `ElevenLabs: ${message}`)
    }
  }

  private join(text: string): string {
    return this.heard ? `${this.heard} ${text}` : text
  }

  endTurn(): void {
    this.committing = true
    this.sendJson({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true, sample_rate: 16000 })
  }
}

export const elevenLabsScribe: SttProvider = {
  id: 'elevenlabs',
  async open(opts) {
    const session = new ScribeSession(opts)
    await session.ready
    return session
  }
}
