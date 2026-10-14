/**
 * The two interfaces every speech vendor sits behind (docs/voice-mode.md §9.1).
 * The voice session only ever talks to these; it never imports a vendor file.
 */
import type { SttProviderId, TtsProviderId, VoiceErrorCode } from '../../../shared/voice'

// ── Speech to text ──────────────────────────────────────────────────────────

export type SttEvent =
  | { kind: 'open' }
  /** The provider detected speech starting (used to confirm a barge-in). */
  | { kind: 'speech_start' }
  /** Unstable words for live captions; replaces the previous partial. */
  | { kind: 'partial'; text: string }
  /** Settled words; more may follow in the same turn. */
  | { kind: 'final'; text: string; confidence?: number }
  /** The speaker has finished; `text` is the whole turn. */
  | { kind: 'end_of_turn'; text: string; confidence?: number; listen?: TurnListenStats }
  | { kind: 'error'; code: VoiceErrorCode; message: string; retryable: boolean }
  | { kind: 'closed'; reason: string }

/**
 * What a whole-turn listener did for one turn, for vyotiq.log: a slow turn
 * logged only `sttMs: 12183`, which can't tell a long upload from a retry
 * from a slow model.
 */
export type TurnListenStats = {
  /** Audio sent, in ms. */
  audioMs: number
  /** The request that gave the words, from when it was sent. */
  requestMs: number
  /** The words came from the early request (started at `settle`). */
  earlyUsed: boolean
  /** HTTP attempts that request made (more than 1: retried). */
  attempts?: number
}

export interface SttSession {
  /** 16 kHz mono Int16 LE. The adapter resamples if its provider wants another rate. */
  pushAudio(pcm16k: Int16Array): void
  /** Push-to-talk release, or a local end-of-turn for providers without turn detection. */
  endTurn(): void
  /** Vocabulary hints (workspace identifiers); replaces the previous list. */
  setKeyterms?(terms: readonly string[]): void
  /** Keep an idle connection open (while muted). */
  keepAlive?(): void
  /**
   * The session's own detector heard you start talking. A listener that
   * buffers whole turns drops what came before (silence, the agent's voice
   * from the speakers), keeping a lead-in. `leadInMs`: how much it may keep,
   * so the lead-in never reaches back into the agent's voice.
   */
  speechStarted?(opts?: { leadInMs?: number }): void
  /**
   * Quiet long enough that the turn has probably ended (the session's
   * detector, before its full pause). A listener that sends whole turns may
   * start on this one now; `endTurn` then uses that result.
   */
  settle?(): void
  /** Talking again after `settle`: whatever it started is stale. */
  resume?(): void
  close(): Promise<void>
}

/** How patient the listener is before ending a turn; adapters map it to their own knobs. */
export type TurnPatience = 'quick' | 'normal' | 'patient'

export type SttOpenOptions = {
  apiKey: string
  model: string
  /** ISO-639-1; empty means English. */
  language: string
  patience: TurnPatience
  keyterms?: readonly string[]
  signal: AbortSignal
  emit: (event: SttEvent) => void
}

export interface SttProvider {
  id: SttProviderId
  open(opts: SttOpenOptions): Promise<SttSession>
}

// ── Text to speech ──────────────────────────────────────────────────────────

export type TtsChunk = {
  /** Int16 LE mono PCM. */
  pcm: Int16Array
  sampleRate: number
  /** One context per spoken reply; barge-in cancels a whole context. */
  contextId: string
  /**
   * This chunk is the first audio of the n-th flushed piece (0-based), where
   * the adapter can tell: captions are shown as their own words are heard.
   */
  piece?: number
}

export interface TtsStream {
  /** Append text; the adapter decides when to synthesise it. */
  pushText(text: string): void
  /** A sentence boundary or the end of the reply: synthesise what's buffered. */
  flush(): void
  /** No more text will come for this reply. */
  end(): void
  /** Barge-in: stop generating and drop anything not yet delivered. */
  cancel(): void
  /** Resolves once all audio for the pushed text has been delivered (or after cancel). */
  done(): Promise<void>
}

export type VoiceOption = {
  id: string
  label: string
  /** Vendor descriptors, e.g. "American · warm · narration". */
  description?: string
  /** One of the user's own cloned/designed voices. */
  custom?: boolean
  previewUrl?: string
}

export type TtsStreamOptions = {
  apiKey: string
  model: string
  voiceId: string
  /** Already clamped to the provider's range. */
  speed: number
  contextId: string
  signal: AbortSignal
  onAudio: (chunk: TtsChunk) => void
  onError: (code: VoiceErrorCode, message: string) => void
}

export interface TtsProvider {
  id: TtsProviderId
  listVoices?(apiKey: string, signal?: AbortSignal): Promise<VoiceOption[]>
  /** One stream per spoken reply; connection reuse and keepalive are the adapter's job. */
  stream(opts: TtsStreamOptions): TtsStream
  /** Cheap authenticated call used to check a key before saving it. */
  verifyKey?(apiKey: string, signal?: AbortSignal): Promise<void>
}
