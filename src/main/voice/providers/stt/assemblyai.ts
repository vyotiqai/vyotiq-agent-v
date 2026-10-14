/**
 * AssemblyAI Universal Streaming v3 (docs/voice-mode.md §9.3). Binary PCM up;
 * `Turn` messages back, partial until `end_of_turn` is true. Push-to-talk
 * release is `ForceEndpoint`. The key goes in `Authorization` without
 * `Bearer`.
 */
import type { SttOpenOptions, SttProvider, TurnPatience } from '../types'
import { SocketStt, int16Bytes, num, str, type KeyCheck } from './socketStt'

export const ASSEMBLYAI_URL = 'wss://streaming.assemblyai.com/v3/ws'

const PATIENCE: Readonly<Record<TurnPatience, { confidence: number; minSilence: number; maxSilence: number }>> = {
  quick: { confidence: 0.3, minSilence: 300, maxSilence: 1000 },
  normal: { confidence: 0.4, minSilence: 400, maxSilence: 1280 },
  patient: { confidence: 0.6, minSilence: 700, maxSilence: 2500 }
}

export function assemblyAiUrl(opts: Pick<SttOpenOptions, 'model' | 'language' | 'patience'>): string {
  const english = !opts.language || opts.language === 'en'
  const model =
    opts.model === 'universal-streaming-english' && !english ? 'universal-streaming-multilingual' : opts.model
  const p = PATIENCE[opts.patience]
  const params = new URLSearchParams({
    sample_rate: '16000',
    encoding: 'pcm_s16le',
    speech_model: model || 'universal-3-6-pro',
    // Formatting a turn costs an extra round trip; the agent reads raw words fine.
    format_turns: 'false',
    end_of_turn_confidence_threshold: String(p.confidence),
    min_turn_silence: String(p.minSilence),
    max_turn_silence: String(p.maxSilence)
  })
  return `${ASSEMBLYAI_URL}?${params}`
}

class AssemblyAiSession extends SocketStt {
  private speaking = false

  constructor(opts: SttOpenOptions) {
    super(assemblyAiUrl(opts), { Authorization: opts.apiKey }, opts, 'AssemblyAI')
  }

  protected keyCheck(): KeyCheck {
    return { url: 'https://api.assemblyai.com/v2/transcript?limit=1', headers: { Authorization: this.opts.apiKey } }
  }

  protected onOpen(): void {
    if (this.opts.keyterms?.length) this.setKeyterms(this.opts.keyterms)
  }

  protected audioFrame(pcm16k: Int16Array): Uint8Array {
    return int16Bytes(pcm16k)
  }

  protected onMessage(msg: Record<string, unknown>): void {
    const type = str(msg.type)
    if (type === 'SpeechStarted') {
      if (!this.speaking) this.emit({ kind: 'speech_start' })
      this.speaking = true
      return
    }
    if (type === 'Turn') {
      const transcript = str(msg.transcript)
      if (!this.speaking && transcript) {
        this.speaking = true
        this.emit({ kind: 'speech_start' })
      }
      if (msg.end_of_turn === true) {
        this.speaking = false
        this.emit({ kind: 'end_of_turn', text: transcript.trim(), confidence: num(msg.end_of_turn_confidence) })
      } else if (transcript) {
        this.emit({ kind: 'partial', text: transcript })
      }
      return
    }
    if (type === 'Error' || typeof msg.error === 'string') {
      const text = str(msg.error) || str(msg.message) || 'error'
      this.fail(/auth|unauthori[sz]ed|api key/i.test(text) ? 'rejected_key' : 'engine_failed', `AssemblyAI: ${text}`)
    }
  }

  endTurn(): void {
    this.sendJson({ type: 'ForceEndpoint' })
  }

  setKeyterms(terms: readonly string[]): void {
    this.sendJson({ type: 'UpdateConfiguration', keyterms_prompt: terms.slice(0, 100) })
  }

  keepAlive(): void {
    this.sendJson({ type: 'KeepAlive' })
  }

  protected goodbye(): Record<string, unknown> {
    return { type: 'Terminate' }
  }
}

export const assemblyAi: SttProvider = {
  id: 'assemblyai',
  async open(opts) {
    const session = new AssemblyAiSession(opts)
    await session.ready
    return session
  }
}
