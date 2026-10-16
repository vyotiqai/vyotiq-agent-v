/**
 * "This PC" listener (beta): dictation's local Whisper/Moonshine engine, one
 * transcription per turn. It can't stream words or detect turns, so the
 * session's pause detector ends each turn and the words arrive after it —
 * slower replies, but nothing leaves the machine (docs/voice-mode.md §9.3).
 */
import { transcribeLocalDictation } from '../../../dictation/local'
import { isDictationError } from '../../../dictation/errors'
import type { DictationTranscribeResult } from '../../../../shared/ipc'
import type { SttEvent, SttOpenOptions, SttProvider, SttSession, TurnListenStats } from '../types'

/** Enough for any spoken turn; longer is cut to its last minute. */
const MAX_TURN_SAMPLES = 16000 * 60
/**
 * Kept from before speech starts. The detector needs 300 ms of voice to be
 * sure, and a short first word with a pause after it ("Hey, … can you") may
 * not reach that: measured in the real app, "Hey," ended 0.85 s before the
 * detector fired, and half a second of lead-in dropped it. Real turns showed
 * the same ("You run several agents…").
 */
export const LEAD_IN_SAMPLES = 16000 * 1.5
/** Never less than this, even right after the agent spoke: words still begin before the detector fires. */
export const MIN_LEAD_IN_SAMPLES = 16000 / 2

/** One turn's transcription; `extras.model` picks the cloud model (OpenRouter). `attempts`: HTTP tries, cloud only. */
type Transcribe = (
  request: Parameters<typeof transcribeLocalDictation>[0],
  signal?: AbortSignal,
  extras?: { model?: string }
) => Promise<DictationTranscribeResult & { attempts?: number }>

/** How a listener that sends whole turns is set up: which engine, and how its failures read. */
export type TurnUploadOptions = {
  engine: 'local' | 'openrouter'
  language?: string
  /** The model chosen under Settings → Voice; the engine's default when absent. */
  model?: string
  /**
   * Start transcribing at the first likely end of the turn (`settle`). Cloud
   * only: a dropped early request costs a fraction of a cent, but on This PC it
   * would hold up the one local model the real turn needs.
   */
  early?: boolean
  toError: (err: unknown) => Extract<SttEvent, { kind: 'error' }>
}

/**
 * Only a model that isn't there, or a Whisper that can't start, ends voice
 * mode. One take Whisper stumbled on loses that turn alone (A-03): it is
 * "retryable", which a whole-turn listener's session reads as "this turn".
 */
const localError = (err: unknown): Extract<SttEvent, { kind: 'error' }> => {
  const message = err instanceof Error ? err.message : String(err)
  const fatal = (isDictationError(err) && err.code === 'model_missing') || /could not start|needs audio from the microphone/.test(message)
  return { kind: 'error', code: 'engine_failed', message, retryable: !fatal }
}

/** Buffers each turn and transcribes it once the turn ends: This PC, and OpenRouter (no streaming endpoint). */
export class TurnUploadSttSession implements SttSession {
  private chunks: Int16Array[] = []
  private samples = 0
  private closed = false
  private working: Promise<void> = Promise.resolve()

  constructor(
    private readonly emit: (event: SttEvent) => void,
    private readonly signal: AbortSignal,
    private readonly transcribe: Transcribe,
    private readonly options: TurnUploadOptions = { engine: 'local', toError: localError }
  ) {}

  pushAudio(pcm16k: Int16Array): void {
    if (this.closed) return
    this.chunks.push(pcm16k)
    this.samples += pcm16k.length
    while (this.samples > MAX_TURN_SAMPLES && this.chunks.length > 1) this.samples -= this.chunks.shift()!.length
  }

  speechStarted(opts: { leadInMs?: number } = {}): void {
    // Only the lead-in survives: the silence and any agent audio before it would be transcribed too.
    const want = opts.leadInMs === undefined ? LEAD_IN_SAMPLES : Math.round((opts.leadInMs / 1000) * 16000)
    const leadIn = Math.min(LEAD_IN_SAMPLES, Math.max(MIN_LEAD_IN_SAMPLES, want))
    const keep: Int16Array[] = []
    let kept = 0
    for (let i = this.chunks.length - 1; i >= 0 && kept < leadIn; i--) {
      keep.unshift(this.chunks[i]!)
      kept += this.chunks[i]!.length
    }
    this.chunks = keep
    this.samples = kept
  }

  /**
   * The turn has probably ended: start on it now (cloud listeners only). Only
   * the quiet after this point is left out, so if the pause confirms the end,
   * this result is the turn's.
   */
  settle(): void {
    if (this.closed || !this.options.early || this.samples === 0) return
    this.cancelEarly()
    const ctrl = new AbortController()
    const startedAt = Date.now()
    const result = this.request(this.joined(), AbortSignal.any([this.signal, ctrl.signal])).then((res) => ({
      ...res,
      requestMs: Date.now() - startedAt
    }))
    // Read by endTurn; a turn that resumes drops it unread.
    result.catch(() => {})
    this.early = { ctrl, result }
  }

  /** Talking again: the early transcription is missing words, so it's dropped (and aborted). */
  resume(): void {
    this.cancelEarly()
  }

  endTurn(): void {
    if (this.closed) return
    const pcm = this.joined()
    const early = this.early
    this.early = null
    this.chunks = []
    this.samples = 0
    this.working = this.working.then(async () => {
      if (pcm.length === 0) {
        this.emit({ kind: 'end_of_turn', text: '' })
        return
      }
      try {
        // The early result if it worked; the whole turn again if it didn't.
        const fromEarly = early ? await early.result.catch(() => null) : null
        const startedAt = Date.now()
        const res = fromEarly ?? (await this.request(pcm, this.signal))
        const listen: TurnListenStats = {
          audioMs: Math.round((pcm.length / 16000) * 1000),
          requestMs: fromEarly ? fromEarly.requestMs : Date.now() - startedAt,
          earlyUsed: fromEarly !== null,
          ...(res.attempts ? { attempts: res.attempts } : {})
        }
        if (!this.closed) this.emit({ kind: 'end_of_turn', text: res.text.trim(), listen })
      } catch (err) {
        if (this.closed) return
        this.emit(this.options.toError(err))
      }
    })
  }

  private early: { ctrl: AbortController; result: Promise<Awaited<ReturnType<Transcribe>> & { requestMs: number }> } | null = null

  private cancelEarly(): void {
    this.early?.ctrl.abort()
    this.early = null
  }

  private joined(): Int16Array {
    const pcm = new Int16Array(this.samples)
    let at = 0
    for (const c of this.chunks) {
      pcm.set(c, at)
      at += c.length
    }
    return pcm
  }

  private request(pcm: Int16Array, signal: AbortSignal): ReturnType<Transcribe> {
    const { engine, language, model } = this.options
    return this.transcribe(
      {
        pcm16k: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'),
        mime: 'audio/pcm',
        engine,
        allowEmpty: true,
        ...(language ? { language } : {})
      },
      signal,
      model ? { model } : undefined
    )
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.cancelEarly()
    this.emit({ kind: 'closed', reason: 'closed by client' })
  }
}

export function makeLocalStt(transcribe: Transcribe = transcribeLocalDictation): SttProvider {
  return {
    id: 'local',
    async open(opts: SttOpenOptions) {
      const session = new TurnUploadSttSession(opts.emit, opts.signal, transcribe)
      opts.emit({ kind: 'open' })
      return session
    }
  }
}
