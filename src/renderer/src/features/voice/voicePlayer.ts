/**
 * Plays the agent's voice (docs/voice-mode.md §10). Raw Int16 PCM arrives
 * from main in chunks; each becomes an AudioBuffer scheduled back to back on
 * one AudioContext clock, so playback is gapless however the chunks were cut.
 *
 * No <audio> element and no blob: URLs: the renderer CSP has no `blob:` in
 * `media-src`, and a test keeps object URLs out of the renderer.
 */

/** Wait this long before the first chunk of a reply, to absorb network jitter. */
export const JITTER_BUFFER_S = 0.06
/** Volume while you talk over the agent, before the barge-in is confirmed (§6.2). */
export const DUCKED_GAIN = 0.2
/** Gain ramp time constant: short enough to feel instant, long enough not to click. */
const RAMP_S = 0.03
/**
 * A reply whose end never arrives (its speech stream hung) still counts as
 * drained after this much silence, so the session can't stay "speaking".
 */
export const STALL_DRAIN_MS = 8000

/** `piece`: the chunk starts that sentence of the reply (for captions). */
export type PlayerChunk = { pcm: Int16Array; sampleRate: number; contextId: string; piece?: number }

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
  /**
   * A context marked ended (`endContext`) has played its last chunk (B9). A
   * gap while more speech is still coming is not this.
   */
  onContextDrained?: (contextId: string) => void
  /**
   * One context at a time (live sessions): another context's audio waits
   * until this one's speech has all arrived. Scheduled by arrival, "One
   * moment." and the reply that came 0.2 s after it were cut into each other
   * chunk by chunk, two voices at once (2026-10-17 kept conversations: 20 of
   * 58 short lines had the reply start within 2.5 s). Off for read-aloud,
   * which never ends a context.
   */
  oneAtATime?: boolean
  /** A chunk was scheduled to be heard in `delayMs`, now or once its turn came. */
  onScheduled?: (chunk: PlayerChunk, delayMs: number) => void
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
  /** Contexts whose speech is complete: drained once their last chunk has played. */
  private ended = new Set<string>()
  /** Started contexts gone quiet without an end: drained anyway after STALL_DRAIN_MS. */
  private stalls = new Map<string, ReturnType<typeof setTimeout>>()
  private ducked = false
  private levelBuf: Float32Array<ArrayBuffer> | null = null
  /** `oneAtATime`: the context being scheduled now. */
  private current: string | null = null
  /** `oneAtATime`: chunks of later contexts, oldest context first, and those whose speech already all arrived. */
  private held = new Map<string, PlayerChunk[]>()
  private heldEnded = new Set<string>()

  constructor(private readonly opts: VoicePlayerOptions = {}) {}

  get playing(): boolean {
    return this.scheduled.length > 0
  }

  /** Audio of this context is scheduled and hasn't played out. */
  sounding(contextId: string): boolean {
    return this.scheduled.some((s) => s.contextId === contextId)
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

  /** Schedule a chunk; how many ms until it is heard, or null when it was dropped or waits its turn (`oneAtATime`). */
  enqueue(chunk: PlayerChunk): number | null {
    if (this.cancelled.has(chunk.contextId) || chunk.pcm.length === 0) return null
    if (this.opts.oneAtATime) {
      if (this.current !== null && this.current !== chunk.contextId) {
        const waiting = this.held.get(chunk.contextId) ?? []
        waiting.push(chunk)
        this.held.set(chunk.contextId, waiting)
        return null
      }
      this.current = chunk.contextId
    }
    return this.schedule(chunk)
  }

  /** The context scheduled now is done arriving (or gone): the oldest waiting one goes next, after it. */
  private releaseNext(): void {
    this.current = null
    for (;;) {
      const next = this.held.keys().next()
      if (next.done) return
      const contextId = next.value
      const chunks = this.held.get(contextId) ?? []
      this.held.delete(contextId)
      this.current = contextId
      for (const c of chunks) this.schedule(c)
      if (!this.heldEnded.delete(contextId)) return
      // Its speech had all arrived while it waited.
      this.current = null
      this.ended.add(contextId)
      this.checkDrained(contextId)
    }
  }

  private schedule(chunk: PlayerChunk): number {
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
    this.clearStall(chunk.contextId)
    source.start(startAt)
    this.nextStart = entry.endsAt
    this.scheduled.push(entry)
    if (!this.started.has(chunk.contextId)) {
      this.started.add(chunk.contextId)
      this.opts.onContextStart?.(chunk.contextId)
    }
    const delayMs = Math.max(0, (startAt - now) * 1000)
    this.opts.onScheduled?.(chunk, delayMs)
    return delayMs
  }

  private onEnded(entry: Scheduled): void {
    const i = this.scheduled.indexOf(entry)
    if (i === -1) return
    this.scheduled.splice(i, 1)
    this.checkDrained(entry.contextId)
    if (this.scheduled.length === 0) this.opts.onIdle?.()
  }

  /**
   * All of this context's speech has arrived. Drained now if it has played
   * out, else when its last chunk ends. A context that never sounded isn't.
   */
  endContext(contextId: string): void {
    if (this.cancelled.has(contextId)) return
    if (this.held.has(contextId)) {
      this.heldEnded.add(contextId)
      return
    }
    this.ended.add(contextId)
    this.checkDrained(contextId)
    if (this.current === contextId) this.releaseNext()
  }

  private checkDrained(contextId: string): void {
    // Only live sessions track ends; a read-aloud finishes on `onIdle`.
    if (!this.opts.onContextDrained) return
    if (!this.started.has(contextId) || this.scheduled.some((s) => s.contextId === contextId)) return
    if (this.ended.has(contextId)) {
      this.drained(contextId)
      return
    }
    // More may be coming (the next sentence is being made); a stream that hung isn't waited on forever.
    if (!this.stalls.has(contextId)) {
      this.stalls.set(
        contextId,
        setTimeout(() => {
          this.stalls.delete(contextId)
          if (!this.scheduled.some((s) => s.contextId === contextId)) this.drained(contextId)
        }, STALL_DRAIN_MS)
      )
    }
  }

  private drained(contextId: string): void {
    this.clearStall(contextId)
    this.ended.delete(contextId)
    // Played out: later chunks for it (there shouldn't be any) are dropped.
    this.started.delete(contextId)
    this.cancelled.add(contextId)
    this.opts.onContextDrained?.(contextId)
    // A stream that hung (drained by the stall timer) mustn't hold the next one back for good.
    if (this.current === contextId) this.releaseNext()
  }

  private clearStall(contextId: string): void {
    const t = this.stalls.get(contextId)
    if (t !== undefined) clearTimeout(t)
    this.stalls.delete(contextId)
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
    // Cancelled is not drained: whoever cancelled it already knows it stopped.
    for (const id of contextId ? [contextId] : [...this.stalls.keys(), ...this.ended]) {
      this.clearStall(id)
      this.ended.delete(id)
    }
    // What waits its turn goes too: everything, or the one cancelled.
    for (const id of contextId ? [contextId] : [...this.held.keys()]) {
      this.held.delete(id)
      this.heldEnded.delete(id)
      if (!contextId) this.cancelled.add(id)
    }
    const releases = contextId !== undefined && this.current === contextId
    if (!contextId) this.current = null
    this.stopVictims(ctx, victims)
    if (releases) this.releaseNext()
  }

  private stopVictims(ctx: PlayerAudioContext | null, victims: Scheduled[]): void {
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
    this.ended.clear()
    this.held.clear()
    this.heldEnded.clear()
    this.current = null
    for (const t of this.stalls.values()) clearTimeout(t)
    this.stalls.clear()
    if (ctx && ctx.state !== 'closed') await ctx.close()
  }
}
