/**
 * OpenAI realtime transcription for voice mode (docs/voice-mode.md §9.3),
 * the same protocol dictation's live takes use (`dictation/liveOpenAI.ts`):
 * 24 kHz PCM appended as base64, server VAD off, and a commit when the
 * session's pause detector or push-to-talk ends the turn. Uses your OpenAI
 * key.
 */
import { Upsampler16To24 } from '../../../dictation/liveOpenAI'
import type { SttOpenOptions, SttProvider } from '../types'
import { SocketStt, int16Base64, str, type KeyCheck } from './socketStt'

export const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription'

class OpenAiRealtimeSession extends SocketStt {
  private readonly upsampler = new Upsampler16To24()
  /** Words per item, as deltas arrive. */
  private partial = new Map<string, string>()
  private speaking = false

  constructor(opts: SttOpenOptions) {
    super(OPENAI_REALTIME_URL, { Authorization: `Bearer ${opts.apiKey}` }, opts, 'OpenAI')
  }

  protected keyCheck(): KeyCheck {
    return { url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${this.opts.apiKey}` } }
  }

  protected onOpen(): void {
    const transcription: Record<string, unknown> = { model: this.opts.model || 'gpt-live-transcribe', delay: 'low' }
    if (this.opts.language) transcription.languages = [this.opts.language]
    if (this.opts.keyterms?.length) transcription.keywords = this.opts.keyterms.slice(0, 150)
    // Sent ahead of anything queued: the socket is open but the outbox not yet flushed.
    this.socket.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, transcription, turn_detection: null } }
        }
      })
    )
  }

  protected audioFrame(pcm16k: Int16Array): string | null {
    const up = this.upsampler.push(pcm16k)
    if (up.length === 0) return null
    return JSON.stringify({ type: 'input_audio_buffer.append', audio: int16Base64(up) })
  }

  protected onMessage(msg: Record<string, unknown>): void {
    const type = str(msg.type)
    const itemId = str(msg.item_id)
    if (type === 'conversation.item.input_audio_transcription.delta') {
      const text = (this.partial.get(itemId) ?? '') + str(msg.delta)
      this.partial.set(itemId, text)
      if (!this.speaking && text.trim()) {
        this.speaking = true
        this.emit({ kind: 'speech_start' })
      }
      if (text.trim()) this.emit({ kind: 'partial', text: text.trim() })
      return
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      this.partial.delete(itemId)
      this.speaking = false
      this.emit({ kind: 'end_of_turn', text: str(msg.transcript).trim() })
      return
    }
    if (type === 'conversation.item.input_audio_transcription.failed') {
      this.partial.delete(itemId)
      this.speaking = false
      this.emit({ kind: 'end_of_turn', text: '' })
      return
    }
    if (type === 'error') {
      const err = (msg.error ?? {}) as Record<string, unknown>
      const code = str(err.code)
      if (code === 'input_audio_buffer_commit_empty') {
        this.emit({ kind: 'end_of_turn', text: '' })
        return
      }
      const message = str(err.message) || code || 'error'
      this.fail(
        /invalid_api_key|auth/i.test(code + message) ? 'rejected_key' : /quota|billing/i.test(code + message) ? 'out_of_credit' : 'engine_failed',
        `OpenAI: ${message}`
      )
    }
  }

  endTurn(): void {
    this.sendJson({ type: 'input_audio_buffer.commit' })
  }
}

export const openAiRealtime: SttProvider = {
  id: 'openai',
  async open(opts) {
    const session = new OpenAiRealtimeSession(opts)
    await session.ready
    return session
  }
}
