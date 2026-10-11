/**
 * Plays the agent's voice (docs/voice-mode.md §10). Raw Int16 PCM arrives
 * from main in chunks; each becomes an AudioBuffer scheduled back to back on
 * one AudioContext clock, so playback is gapless however the chunks were cut.
 *
 * No <audio> element and no blob: URLs: the renderer CSP has no `blob:` in
 * `media-src`, and a test bans `URL.createObjectURL` in the renderer.
 */

/** Wait this long before the first chunk of a reply, to absorb network jitter. */
export const JITTER_BUFFER_S = 0.06
/** Volume while you talk over the agent, before the barge-in is confirmed (§6.2). */
export const DUCKED_GAIN = 0.2
/** Gain ramp time constant: short enough to feel instant, long enough not to click. */
const RAMP_S = 0.03

export type PlayerChunk = { pcm: Int16Array; sampleRate: number; contextId: string }

/** The slice of the Web Audio API the player uses; tests pass a fake. */
export type PlayerAudioContext = Pick<
  AudioContext,
  'currentTime' | 'destination' | 'createBuffer' | 'createBufferSource' | 'createGain' | 'createAnalyser' | 'close'
> & { state: AudioContextState; resume?: () => Promise<void> }

export type VoicePlayerOptions = {
  createContext?: () => PlayerAudioContext
  /** Every scheduled chunk of every context has finished playing. */
  onIdle?: () => void
  /** The first chunk of a context started (drives `audio_start`). */
  onContextStart?: (contextId: string) => void
}

export function int16ToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = (pcm[i] ?? 0) / 0x8000
  return out
}

type Scheduled = { source: AudioBufferSourceNode; contextId: string; endsAt: number }

export class VoicePlayer {
  private ctx: PlayerAudioContext | null = null
  private gain: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private scheduled: Scheduled[] = []
  private nextStart = 0
  private started = new Set<string>()
  /** Contexts cancelled by barge-in: late chunks for them are dropped. */
  private cancelled = new Set<string>()
  private ducked = false
  private levelBuf: Float32Array<ArrayBuffer> | null = null

  constructor(private readonly opts: VoicePlayerOptions = {}) {}

  get playing(): boolean {
    return this.scheduled.length > 0
  }

  private ensure(): { ctx: PlayerAudioContext; gain: GainNode } {
    if (this.ctx && this.gain && this.ctx.state !== 'closed') return { ctx: this.ctx, gain: this.gain }
    const ctx = this.opts.createContext ? this.opts.createContext() : new AudioContext({ sampleRate: 24000 })
    const gain = ctx.createGain()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    gain.connect(analyser)
    analyser.connect(ctx.destination)
    gain.gain.value = this.ducked ? DUCKED_GAIN : 1
    this.ctx = ctx
    this.gain = gain
    this.analyser = analyser
    this.levelBuf = new Float32Array(analyser.fftSize)
    return { ctx, gain }
  }

  enqueue(chunk: PlayerChunk): void {
    if (this.cancelled.has(chunk.contextId) || chunk.pcm.length === 0) return
    const { ctx, gain } = this.ensure()
    if (ctx.state === 'suspended') void ctx.resume?.()
    const buffer = ctx.createBuffer(1, chunk.pcm.length, chunk.sampleRate)
    buffer.getChannelData(0).set(int16ToFloat32(chunk.pcm))
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(gain)
    const now = ctx.currentTime
    // A fresh start (or an underrun) waits out the jitter buffer; otherwise butt-join.
    const startAt = this.nextStart > now ? this.nextStart : now + JITTER_BUFFER_S
    const entry: Scheduled = { source, contextId: chunk.contextId, endsAt: startAt + buffer.duration }
    source.onended = () => this.onEnded(entry)
    source.start(startAt)
    this.nextStart = entry.endsAt
    this.scheduled.push(entry)
    if (!this.started.has(chunk.contextId)) {
      this.started.add(chunk.contextId)
      this.opts.onContextStart?.(chunk.contextId)
    }
  }

  private onEnded(entry: Scheduled): void {
    const i = this.scheduled.indexOf(entry)
    if (i === -1) return
    this.scheduled.splice(i, 1)
    if (this.scheduled.length === 0) this.opts.onIdle?.()
  }

  /**
   * Stop now: fade out over ~30 ms, drop everything queued, and ignore any
   * late chunks for the cancelled contexts. With no id, cancels everything.
   */
  cancel(contextId?: string): void {
    const ctx = this.ctx
    const victims = contextId ? this.scheduled.filter((s) => s.contextId === contextId) : [...this.scheduled]
    for (const s of victims) this.cancelled.add(s.contextId)
    if (contextId) this.cancelled.add(contextId)
    if (!ctx || !this.gain || victims.length === 0) return
    const stopAt = ctx.currentTime + RAMP_S * 3
    if (victims.length === this.scheduled.length) {
      this.gain.gain.setTargetAtTime(0, ctx.currentTime, RAMP_S)
      this.gain.gain.setTargetAtTime(this.ducked ? DUCKED_GAIN : 1, stopAt, RAMP_S)
    }
    for (const s of victims) {
      s.source.onended = null
      try {
        s.source.stop(stopAt)
      } catch {
        // already stopped
      }
    }
    this.scheduled = this.scheduled.filter((s) => !victims.includes(s))
    this.nextStart = this.scheduled.reduce((end, s) => Math.max(end, s.endsAt), 0)
    if (this.scheduled.length === 0) this.opts.onIdle?.()
  }

  /** Lower the agent's voice while you might be talking over it; restore if it was a false alarm. */
  duck(on: boolean): void {
    this.ducked = on
    if (!this.ctx || !this.gain) return
    this.gain.gain.setTargetAtTime(on ? DUCKED_GAIN : 1, this.ctx.currentTime, RAMP_S)
  }

  /** Output level 0..1 for the orb while speaking. */
  level(): number {
    if (!this.analyser || !this.levelBuf || this.scheduled.length === 0) return 0
    this.analyser.getFloatTimeDomainData(this.levelBuf)
    let sum = 0
    for (const v of this.levelBuf) sum += v * v
    const rms = Math.sqrt(sum / this.levelBuf.length)
    // Same -55..-10 dBFS mapping as the mic meter (segmenter.levelFromRms).
    const db = 20 * Math.log10(Math.max(rms, 1e-6))
    return Math.min(1, Math.max(0, (db + 55) / 45))
  }

  async close(): Promise<void> {
    this.cancel()
    const ctx = this.ctx
    this.ctx = null
    this.gain = null
    this.analyser = null
    this.started.clear()
    this.cancelled.clear()
    if (ctx && ctx.state !== 'closed') await ctx.close()
  }
}
