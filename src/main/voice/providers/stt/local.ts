/**
 * "This PC" listener (beta): dictation's local Whisper/Moonshine engine, one
 * transcription per turn. It can't stream words or detect turns, so the
 * session's pause detector ends each turn and the words arrive after it —
 * slower replies, but nothing leaves the machine (docs/voice-mode.md §9.3).
 */
import { transcribeLocalDictation } from '../../../dictation/local'
import type { SttEvent, SttOpenOptions, SttProvider, SttSession } from '../types'

/** Enough for any spoken turn; longer is cut to its last minute. */
const MAX_TURN_SAMPLES = 16000 * 60

type Transcribe = typeof transcribeLocalDictation

export class LocalSttSession implements SttSession {
  private chunks: Int16Array[] = []
  private samples = 0
  private closed = false
  private working: Promise<void> = Promise.resolve()

  constructor(
    private readonly emit: (event: SttEvent) => void,
    private readonly signal: AbortSignal,
    private readonly transcribe: Transcribe
  ) {}

  pushAudio(pcm16k: Int16Array): void {
    if (this.closed) return
    this.chunks.push(pcm16k)
    this.samples += pcm16k.length
    while (this.samples > MAX_TURN_SAMPLES && this.chunks.length > 1) this.samples -= this.chunks.shift()!.length
  }

  endTurn(): void {
    if (this.closed) return
    const pcm = new Int16Array(this.samples)
    let at = 0
    for (const c of this.chunks) {
      pcm.set(c, at)
      at += c.length
    }
    this.chunks = []
    this.samples = 0
    this.working = this.working.then(async () => {
      if (pcm.length === 0) {
        this.emit({ kind: 'end_of_turn', text: '' })
        return
      }
      try {
        const res = await this.transcribe(
          { pcm16k: Buffer.from(pcm.buffer).toString('base64'), mime: 'audio/pcm', engine: 'local', allowEmpty: true },
          this.signal
        )
        if (!this.closed) this.emit({ kind: 'end_of_turn', text: res.text.trim() })
      } catch (err) {
        if (this.closed) return
        const message = err instanceof Error ? err.message : String(err)
        this.emit({ kind: 'error', code: 'engine_failed', message, retryable: false })
      }
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.emit({ kind: 'closed', reason: 'closed by client' })
  }
}

export function makeLocalStt(transcribe: Transcribe = transcribeLocalDictation): SttProvider {
  return {
    id: 'local',
    async open(opts: SttOpenOptions) {
      const session = new LocalSttSession(opts.emit, opts.signal, transcribe)
      opts.emit({ kind: 'open' })
      return session
    }
  }
}
