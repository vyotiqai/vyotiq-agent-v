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
import { PauseDetector } from '../pauseDetector'

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

/**
 * The listener for end-to-end runs (`VYOTIQ_E2E_FIXTURE=1` with
 * `VYOTIQ_VOICE_FIXTURE_TURNS` set to a JSON array of strings): it listens to
 * the real mic audio the session sends it and, for each stretch of sound
 * followed by a pause, "hears" the next scripted sentence. So a GUI test with
 * a fake microphone drives the whole loop — capture, IPC, turn-taking, the
 * agent and the spoken reply — with nothing faked after the mic.
 */
export class ScriptedFixtureSttSession extends FixtureSttSession {
  private readonly detector = new PauseDetector('quick')
  private next = 0

  constructor(
    emit: (event: SttEvent) => void,
    private readonly turns: readonly string[]
  ) {
    super(emit)
  }

  override pushAudio(pcm16k: Int16Array): void {
    super.pushAudio(pcm16k)
    if (this.closed) return
    for (const ev of this.detector.push(pcm16k)) {
      if (ev.kind === 'pause' && ev.speechMs > 0) this.say(this.turns[this.next++] ?? '')
    }
  }
}

/** The scripted turns for an end-to-end run, or null outside one. */
export function fixtureTurnsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = env.VYOTIQ_VOICE_FIXTURE_TURNS?.trim()
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : null
  } catch {
    return null
  }
}

export async function openFixtureStt(opts: SttOpenOptions, turns: readonly string[] | null = null): Promise<FixtureSttSession> {
  const session = turns ? new ScriptedFixtureSttSession(opts.emit, turns) : new FixtureSttSession(opts.emit)
  if (opts.keyterms) session.setKeyterms(opts.keyterms)
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
  private ended = false
  private inFlight: Promise<void> = Promise.resolve()

  constructor(private readonly opts: TtsStreamOptions) {}

  pushText(text: string): void {
    if (!this.cancelled && !this.ended) this.buffer += text
  }

  flush(): void {
    const piece = this.buffer.trim()
    this.buffer = ''
    if (!piece || this.cancelled) return
    this.spoken.push(piece)
    this.inFlight = this.inFlight.then(async () => {
      await Promise.resolve()
      if (this.cancelled || this.opts.signal.aborted) return
      const chunk: TtsChunk = {
        pcm: new Int16Array(piece.length * SAMPLES_PER_CHAR),
        sampleRate: FIXTURE_TTS_SAMPLE_RATE,
        contextId: this.opts.contextId
      }
      this.opts.onAudio(chunk)
    })
  }

  end(): void {
    this.flush()
    this.ended = true
  }

  cancel(): void {
    this.cancelled = true
    this.buffer = ''
  }

  done(): Promise<void> {
    return this.inFlight
  }
}

export function openFixtureTts(opts: TtsStreamOptions): FixtureTtsStream {
  return new FixtureTtsStream(opts)
}
