/**
 * Cuts a take into segments at the pauses between phrases, so each piece can
 * be transcribed while you are still talking — words land as you speak, the
 * wait after you stop is one short segment, and a failure costs one segment
 * rather than the take.
 *
 * Pure: it sees one 20 ms frame's loudness at a time and says where to cut.
 * Cutting in a pause matters — a cut mid-word garbles that word in both
 * halves — so a segment that runs long is cut at its quietest recent frame.
 */

export const FRAME_SAMPLES = 320 // 20 ms at 16 kHz
const FRAME_MS = 20

export type SegmenterOptions = {
  /** A pause this long closes the segment. */
  minSilenceMs: number
  /** Never close a segment shorter than this — one word alone transcribes badly. */
  minSegmentMs: number
  /** Close it anyway past this, at the quietest point of the last `lookbackMs`. */
  maxSegmentMs: number
  lookbackMs: number
}

export const DEFAULT_SEGMENTER: SegmenterOptions = {
  minSilenceMs: 600,
  minSegmentMs: 1200,
  maxSegmentMs: 12000,
  lookbackMs: 2500
}

/** Loudness of a frame: root mean square of the samples, 0..1. */
export function rmsOfInt16(pcm: Int16Array, from = 0, to = pcm.length): number {
  const n = to - from
  if (n <= 0) return 0
  let sum = 0
  for (let i = from; i < to; i++) {
    const v = pcm[i]! / 32768
    sum += v * v
  }
  return Math.sqrt(sum / n)
}

/** Loudness as a bar height for the level meter: -55 dBFS is the floor, -10 the top. */
export function levelFromRms(rms: number): number {
  const db = 20 * Math.log10(rms + 1e-9)
  return Math.max(0, Math.min(1, (db + 55) / 45))
}

export type FrameResult = {
  voiced: boolean
  /** Close the open segment at this sample; it carried `closedVoicedMs` of speech. */
  cut: { at: number; closedVoicedMs: number } | null
}

export class Segmenter {
  private readonly opts: SegmenterOptions
  private segStart: number
  private voicedMs = 0
  private silenceMs = 0
  /** Adaptive noise floor: speech is loud relative to the room, not to a fixed level. */
  private floor = 0.004
  private recent: Array<{ end: number; rms: number; voiced: boolean }> = []

  constructor(startSample = 0, opts: SegmenterOptions = DEFAULT_SEGMENTER) {
    this.opts = opts
    this.segStart = startSample
  }

  /** Speech seen in the open segment so far. */
  get openVoicedMs(): number {
    return this.voicedMs
  }

  get openStart(): number {
    return this.segStart
  }

  isVoiced(rms: number): boolean {
    return rms > Math.max(0.012, this.floor * 3)
  }

  frame(rms: number, endSample: number): FrameResult {
    const voiced = this.isVoiced(rms)
    // The floor follows quiet frames quickly and loud ones barely, so a
    // sentence never raises it enough to hide the next one.
    this.floor = voiced ? this.floor * 0.9995 + rms * 0.0005 : this.floor * 0.95 + rms * 0.05
    this.floor = Math.max(0.0008, Math.min(0.05, this.floor))

    this.recent.push({ end: endSample, rms, voiced })
    const keep = Math.ceil(this.opts.lookbackMs / FRAME_MS)
    if (this.recent.length > keep) this.recent.splice(0, this.recent.length - keep)

    if (voiced) {
      this.voicedMs += FRAME_MS
      this.silenceMs = 0
    } else {
      this.silenceMs += FRAME_MS
    }

    const lengthMs = ((endSample - this.segStart) / FRAME_SAMPLES) * FRAME_MS
    const hasSpeech = this.voicedMs >= 100

    if (hasSpeech && lengthMs >= this.opts.minSegmentMs && this.silenceMs >= this.opts.minSilenceMs) {
      return { voiced, cut: this.cutAt(endSample) }
    }
    if (lengthMs >= this.opts.maxSegmentMs) {
      let quiet = this.recent[0]!
      for (const f of this.recent) if (f.rms <= quiet.rms) quiet = f
      return { voiced, cut: this.cutAt(quiet.end) }
    }
    return { voiced, cut: null }
  }

  /** Close the open segment at `at`; frames after it start the next one. */
  private cutAt(at: number): { at: number; closedVoicedMs: number } {
    const carried = this.recent.filter((f) => f.end > at)
    const carriedVoiced = carried.filter((f) => f.voiced).length * FRAME_MS
    const closedVoicedMs = Math.max(0, this.voicedMs - carriedVoiced)
    this.segStart = at
    this.voicedMs = carriedVoiced
    let trailing = 0
    for (let i = carried.length - 1; i >= 0 && !carried[i]!.voiced; i--) trailing += FRAME_MS
    this.silenceMs = trailing
    this.recent = carried
    return { at, closedVoicedMs }
  }

  /** Close whatever is open at `at` (the take stopped). */
  close(at: number): { from: number; voicedMs: number } {
    const out = { from: this.segStart, voicedMs: this.voicedMs }
    this.segStart = at
    this.voicedMs = 0
    this.silenceMs = 0
    this.recent = []
    return out
  }
}
