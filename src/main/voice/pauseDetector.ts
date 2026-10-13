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

const SILENCE_MS: Readonly<Record<TurnPatience, number>> = { quick: 500, normal: 750, patient: 1200 }
/** Speech shorter than this is a cough or a click, not a turn. */
const MIN_SPEECH_MS = 200

export type PauseEvent = { kind: 'speech_start' } | { kind: 'pause'; speechMs: number }

export class PauseDetector {
  private floor = 0.004
  private carry: Int16Array = new Int16Array(0)
  private speechMs = 0
  private silenceMs = 0
  private inSpeech = false
  /** Raise while the agent is talking, so its own voice leaking into the mic isn't speech (§6.4). */
  private threshold = 3

  constructor(private patience: TurnPatience = 'normal') {}

  setPatience(p: TurnPatience): void {
    this.patience = p
  }

  /** Stricter detection while the agent speaks (echo); normal otherwise. */
  setAgentSpeaking(on: boolean): void {
    this.threshold = on ? 6 : 3
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
      const ev = this.frame(rms(data, i, i + FRAME))
      if (ev) events.push(ev)
    }
    this.carry = data.slice(i)
    return events
  }

  private frame(level: number): PauseEvent | null {
    const frameMs = (FRAME / SAMPLE_RATE) * 1000
    const voiced = level > Math.max(0.012, this.floor * this.threshold)
    // The floor tracks quiet frames quickly and voiced ones barely.
    this.floor = Math.min(0.05, Math.max(0.0008, voiced ? this.floor * 0.9995 + level * 0.0005 : this.floor * 0.95 + level * 0.05))
    if (voiced) {
      this.speechMs += frameMs
      this.silenceMs = 0
      if (!this.inSpeech && this.speechMs >= MIN_SPEECH_MS) {
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
    if (this.silenceMs >= SILENCE_MS[this.patience]) {
      const speechMs = this.speechMs
      this.reset()
      return { kind: 'pause', speechMs }
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
