/**
 * Generation repetition monitor — tail-occurrence counting.
 *
 * Why this exists: run be413e92 audited a runaway generation that emitted 192
 * identical ~1.5K-char blocks — a loop whose unit length is deliberately NOT
 * aligned to any power-of-two chunk size (gcd(1500, 256) = 4). The previous
 * implementation counted fixed-size 256-char chunks; with a 1500-char unit the
 * chunk window slides out of phase once every ~64 chunks, so 192 repetitions
 * smear into ~375 phase-shifted chunk variants with only ~3 identical counts
 * each and the detector never fires. Root cause: chunk-phase aliasing.
 *
 * Why tail-occurrence counting is immune: instead of carving the stream into
 * fixed windows, we take the LAST `tailLength` chars of the accumulated text
 * and count how many times that exact tail occurs anywhere in the full text
 * (overlapping indexOf loop). Any repeated unit — larger or smaller than the
 * tail, at any phase — contains the tail repeatedly, because the tail is
 * sampled from inside the repetition itself rather than from an arbitrary
 * fixed grid. Detection is therefore independent of both the unit length and
 * the stream's chunk phase.
 *
 * Memory cost: the full accumulated text is retained for the lifetime of one
 * generation so occurrences can be counted against earlier text; this is
 * bounded by a single generation's output (typically well under a few MB of
 * chars), never across generations.
 *
 * Pure TypeScript: no crypto, no clock, no I/O — deterministic on its inputs.
 */

const DEFAULT_MIN_LENGTH = 8192
const DEFAULT_TAIL_LENGTH = 1024
const DEFAULT_THRESHOLD = 6
const DEFAULT_CHECK_INTERVAL = 4096

export interface GenerationRepetitionOptions {
  /** Minimum accumulated length before detection runs at all. */
  minLength?: number
  /** Length of the trailing sample whose occurrences are counted. */
  tailLength?: number
  /** Minimum occurrence count of the tail needed to latch detection. */
  threshold?: number
  /** New input chars between occurrence checks (past minLength). */
  checkInterval?: number
}

/** Count overlapping occurrences of `needle` in `haystack` via indexOf loop. */
export function countOverlappingOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0 || haystack.length < needle.length) return 0
  let count = 0
  let from = 0
  for (;;) {
    const idx = haystack.indexOf(needle, from)
    if (idx === -1) break
    count++
    from = idx + 1
  }
  return count
}

/**
 * Detects degenerate repetition in a streamed generation. `append(delta)`
 * feeds new output; once `threshold` occurrences of the trailing
 * `tailLength`-char sample exist in the accumulated text (checked every
 * `checkInterval` new chars past `minLength`), detection latches and
 * `detected` stays true. `append` returns the latched state.
 */
export class GenerationRepetitionMonitor {
  private readonly minLength: number
  private readonly tailLength: number
  private readonly threshold: number
  private readonly checkInterval: number
  private text = ''
  private charsSinceCheck = 0
  private latched = false

  constructor(options: GenerationRepetitionOptions = {}) {
    this.minLength = options.minLength ?? DEFAULT_MIN_LENGTH
    this.tailLength = Math.max(1, options.tailLength ?? DEFAULT_TAIL_LENGTH)
    this.threshold = Math.max(1, options.threshold ?? DEFAULT_THRESHOLD)
    this.checkInterval = Math.max(1, options.checkInterval ?? DEFAULT_CHECK_INTERVAL)
  }

  /** Latched once the tail-occurrence threshold has ever been reached. */
  get detected(): boolean {
    return this.latched
  }

  /** Feed new generated text; returns the (latched) detected state. */
  append(delta: string): boolean {
    if (this.latched) return true
    if (!delta) return false
    this.text += delta
    if (this.text.length < this.minLength) return false
    this.charsSinceCheck += delta.length
    if (this.charsSinceCheck < this.checkInterval) return false
    this.charsSinceCheck = 0
    const tail = this.text.slice(-this.tailLength)
    if (countOverlappingOccurrences(this.text, tail) >= this.threshold) {
      this.latched = true
    }
    return this.latched
  }
}
