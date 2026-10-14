/**
 * Local voice activity, frame by frame (docs/voice-mode.md §6.1, §6.2). It
 * does two jobs for the session:
 *  - ends the turn after a pause, for listeners without turn detection
 *    (OpenAI, ElevenLabs Scribe, This PC);
 *  - notices speech starting, fast and offline, so a barge-in can duck the
 *    agent's voice before the cloud listener confirms it.
 *
 * Same rule as dictation's segmenter: a frame is voiced when its RMS is
 * well above an adaptive noise floor.
 */
import type { TurnPatience } from './providers/types'

const SAMPLE_RATE = 16000
const FRAME = 320 // 20 ms

/**
 * Quiet that ends a turn. A pause between sentences is often 0.6–0.9 s, so
 * 0.75 s cut "Hello. Can you hear me?" into two messages (D-43).
 */
export const SILENCE_MS: Readonly<Record<TurnPatience, number>> = { quick: 900, normal: 1300, patient: 2000 }
/**
 * Voiced time that makes speech. A crisp "Stop." or "Yes." is only 150–250 ms
 * of voice (its "st" hiss doesn't count, see MAX_VOICED_ZCR): at 300 ms, a
 * spoken "Stop." while the agent worked was never heard at all, and through
 * the app's 48 kHz capture it came in under 150 (2026-10-14 live probes).
 * Measured peaks: typing 20 ms, a cup set down 60, a desk thud 140. Clicks
 * and hiss are kept out by the crossing rate, not by length; a cough or thud
 * that gets through comes back empty, as a sound tag or a filler, and those
 * are never a turn.
 */
export const MIN_SPEECH_MS = 120
/** While the agent's voice plays: its echo leaks into the mic, and a word that cuts in is longer anyway. */
export const MIN_SPEECH_AGENT_TALKING_MS = 300

/**
 * Quiet after which the turn has probably ended: a whole-turn listener starts
 * transcribing then, and keeps the result if the full pause confirms it.
 * Saves 300 ms (Quick) to 1.4 s (Patient) per turn.
 */
export function settleMs(patience: TurnPatience): number {
  return Math.min(600, SILENCE_MS[patience] - 400)
}

/**
 * A frame whose waveform crosses zero this often is hiss, breath or a key
 * click, not a voice (B3): voiced speech sits well under 0.2 at 16 kHz,
 * broadband noise near 0.5. Each such sound was a billed upload that came
 * back empty, about one a minute on a headset.
 */
export const MAX_VOICED_ZCR = 0.3

export type PauseEvent =
  | { kind: 'speech_start' }
  /** Quiet for `settleMs`: the turn has probably ended. */
  | { kind: 'settling' }
  /** Talking again after `settling`: anything started early is stale. */
  | { kind: 'resumed' }
  | { kind: 'pause'; speechMs: number; silenceMs: number }

export class PauseDetector {
  private floor = 0.004
  private carry: Int16Array = new Int16Array(0)
  private speechMs = 0
  private silenceMs = 0
  private inSpeech = false
  private settled = false
  /** Raise while the agent is talking, so its own voice leaking into the mic isn't speech (§6.4). */
  private threshold = 3
  private minSpeechMs = MIN_SPEECH_MS

  constructor(private patience: TurnPatience = 'normal') {}

  setPatience(p: TurnPatience): void {
    this.patience = p
  }

  /** Stricter detection while the agent speaks (echo); normal otherwise. */
  setAgentSpeaking(on: boolean): void {
    this.threshold = on ? 6 : 3
    this.minSpeechMs = on ? MIN_SPEECH_AGENT_TALKING_MS : MIN_SPEECH_MS
  }

  /** Voiced time in the speech so far (a cough stays short; talking keeps growing). */
  get voicedMs(): number {
    return this.speechMs
  }

  /** Forget the current turn (after push-to-talk ends it, or a barge-in). */
  reset(): void {
    this.speechMs = 0
    this.silenceMs = 0
    this.inSpeech = false
    this.settled = false
  }

  push(pcm: Int16Array): PauseEvent[] {
    const events: PauseEvent[] = []
    let data = pcm
    if (this.carry.length > 0) {
      data = new Int16Array(this.carry.length + pcm.length)
      data.set(this.carry)
      data.set(pcm, this.carry.length)
    }
    let i = 0
    for (; i + FRAME <= data.length; i += FRAME) {
      const ev = this.frame(rms(data, i, i + FRAME), zeroCrossingRate(data, i, i + FRAME))
      if (ev) events.push(ev)
    }
    this.carry = data.slice(i)
    return events
  }

  private frame(level: number, zcr: number): PauseEvent | null {
    const frameMs = (FRAME / SAMPLE_RATE) * 1000
    const loud = level > Math.max(0.012, this.floor * this.threshold)
    // Loud is not enough: hiss and breath are loud and cross zero far more than a voice does.
    const voiced = loud && zcr <= MAX_VOICED_ZCR
    // The floor tracks quiet frames quickly and loud ones barely.
    this.floor = Math.min(0.05, Math.max(0.0008, loud ? this.floor * 0.9995 + level * 0.0005 : this.floor * 0.95 + level * 0.05))
    if (voiced) {
      this.speechMs += frameMs
      this.silenceMs = 0
      if (this.settled) {
        this.settled = false
        return { kind: 'resumed' }
      }
      if (!this.inSpeech && this.speechMs >= this.minSpeechMs) {
        this.inSpeech = true
        return { kind: 'speech_start' }
      }
      return null
    }
    if (!this.inSpeech) {
      // A short blip that never became speech decays away.
      this.speechMs = Math.max(0, this.speechMs - frameMs)
      return null
    }
    this.silenceMs += frameMs
    const silence = SILENCE_MS[this.patience]
    if (this.silenceMs >= silence) {
      const speechMs = this.speechMs
      this.reset()
      return { kind: 'pause', speechMs, silenceMs: silence }
    }
    if (!this.settled && this.silenceMs >= settleMs(this.patience)) {
      this.settled = true
      return { kind: 'settling' }
    }
    return null
  }
}

function rms(pcm: Int16Array, from: number, to: number): number {
  let sum = 0
  for (let i = from; i < to; i++) {
    const v = (pcm[i] ?? 0) / 32768
    sum += v * v
  }
  return Math.sqrt(sum / (to - from))
}

/** How often the waveform changes sign, per sample (0..1). */
export function zeroCrossingRate(pcm: Int16Array, from: number, to: number): number {
  let crossings = 0
  let prev = pcm[from] ?? 0
  for (let i = from + 1; i < to; i++) {
    const v = pcm[i] ?? 0
    if ((v >= 0) !== (prev >= 0)) crossings++
    prev = v
  }
  return crossings / Math.max(1, to - from - 1)
}
