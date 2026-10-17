/**
 * Scripted providers for tests and for `VYOTIQ_E2E_FIXTURE=1` runs, so the
 * whole voice loop can be exercised without keys, a network or a sound card.
 * They implement the same interfaces as the real adapters.
 */
import type {
  SttEvent,
  SttOpenOptions,
  SttSession,
  TtsChunk,
  TtsStream,
  TtsStreamOptions
} from './types'

export const FIXTURE_TTS_SAMPLE_RATE = 24000
/** Audio the fixture "speaks" per character of text: 10 ms. */
const SAMPLES_PER_CHAR = FIXTURE_TTS_SAMPLE_RATE / 100

/**
 * A listener that hears nothing until told what was said. Tests call
 * `say(text)` to play a whole turn: speech start, a partial, end of turn.
 */
export class FixtureSttSession implements SttSession {
  readonly received: Int16Array[] = []
  closed = false
  keyterms: readonly string[] = []
  private pending = ''

  constructor(private readonly emit: (event: SttEvent) => void) {}

  pushAudio(pcm16k: Int16Array): void {
    if (!this.closed) this.received.push(pcm16k)
  }

  /** Simulate the user saying `text`; ends the turn unless `endTurn` is false. */
  say(text: string, endTurn = true): void {
    if (this.closed) return
    this.emit({ kind: 'speech_start' })
    this.pending = text
    const half = text.slice(0, Math.ceil(text.length / 2))
    if (half) this.emit({ kind: 'partial', text: half })
    if (endTurn) this.endTurn()
  }

  endTurn(): void {
    if (this.closed) return
    const text = this.pending
    this.pending = ''
    this.emit({ kind: 'end_of_turn', text, confidence: 1 })
  }

  setKeyterms(terms: readonly string[]): void {
    this.keyterms = terms
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.emit({ kind: 'closed', reason: 'closed by client' })
  }
}

export async function openFixtureStt(opts: SttOpenOptions): Promise<FixtureSttSession> {
  const session = new FixtureSttSession(opts.emit)
  if (opts.keyterms) session.setKeyterms(opts.keyterms)
  // The GUI e2e talks through the listener the app last opened: it hears nothing else.
  if (process.env.VYOTIQ_E2E_FIXTURE === '1') (globalThis as { __vyotiqVoiceFixtureStt?: FixtureSttSession }).__vyotiqVoiceFixtureStt = session
  opts.emit({ kind: 'open' })
  return session
}

/**
 * A speaker that turns each flushed piece of text into silence of a length
 * proportional to the text, delivered asynchronously like a real vendor.
 */
export class FixtureTtsStream implements TtsStream {
  readonly spoken: string[] = []
  cancelled = false
  private buffer = ''
  private pieces = 0
  ended = false
  private inFlight: Promise<void> = Promise.resolve()
  /** Settles on end (after the last piece's audio) or cancel, as the real adapters' `done` does. */
  private finished: Promise<void>
  private finish!: () => void

  constructor(private readonly opts: TtsStreamOptions) {
    this.finished = new Promise((resolve) => {
      this.finish = resolve
    })
  }

  pushText(text: string): void {
    if (!this.cancelled && !this.ended) this.buffer += text
  }

  flush(): void {
    const piece = this.buffer.trim()
    this.buffer = ''
    if (!piece || this.cancelled) return
    this.spoken.push(piece)
    // One chunk per piece, marked like the OpenAI-compatible speaker's (captions pace on it).
    const index = this.pieces++
    this.inFlight = this.inFlight.then(async () => {
      await Promise.resolve()
      if (this.cancelled || this.opts.signal.aborted) return
      const chunk: TtsChunk = {
        pcm: new Int16Array(piece.length * SAMPLES_PER_CHAR),
        sampleRate: FIXTURE_TTS_SAMPLE_RATE,
        contextId: this.opts.contextId,
        piece: index
      }
      this.opts.onAudio(chunk)
    })
  }

  end(): void {
    this.flush()
    this.ended = true
    void this.inFlight.then(() => this.finish())
  }

  cancel(): void {
    this.cancelled = true
    this.buffer = ''
    this.finish()
  }

  /** Called before any text is pushed, it still waits for the end: the window's "last" marker must follow the audio. */
  done(): Promise<void> {
    return this.finished
  }
}

export function openFixtureTts(opts: TtsStreamOptions): FixtureTtsStream {
  return new FixtureTtsStream(opts)
}
