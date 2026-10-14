/**
 * The agent hearing itself (docs/voice-mode.md §6.4, defence 3). On speakers
 * the mic can pick up the agent's own voice; the listener then transcribes
 * it as if you'd said it. This remembers what was just spoken and recognises
 * a transcript that is mostly those words, so it is neither shown as your
 * caption nor sent to the agent as a message.
 *
 * Deliberately cautious, because dropping something you really said is
 * worse than letting an echo through:
 *  - only while the agent's audio plays, and for a short tail after (audio
 *    still in the room, the listener's lag);
 *  - one or two words count only while audio is actually playing, and only
 *    as an exact run of what was said, so "yes" right after "Say yes or no."
 *    is your answer, not an echo;
 *  - longer transcripts must be at least ECHO_MATCH of the way made of the
 *    spoken words, in order.
 *
 * Pure: the clock is passed in.
 */

/** How long after the agent stops that its words can still come back. */
export const ECHO_TAIL_MS = 2500
/** Share of a transcript's words, in order, that must be the agent's for it to be an echo. */
export const ECHO_MATCH = 0.75
/** Spoken words remembered, at most (the most recent). */
const MAX_WORDS = 300
/** Below this many words, a transcript is an echo only by exact run while audio plays. */
const SHORT_WORDS = 3

export function echoWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
}

/** Length of the longest common subsequence of `a` in `b` (a is short). */
function lcs(a: readonly string[], b: readonly string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0)
  for (const word of a) {
    const row = new Array<number>(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j++) {
      row[j] = word === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!)
    }
    prev = row
  }
  return prev[b.length]!
}

function containsRun(haystack: readonly string[], run: readonly string[]): boolean {
  outer: for (let i = 0; i + run.length <= haystack.length; i++) {
    for (let k = 0; k < run.length; k++) if (haystack[i + k] !== run[k]) continue outer
    return true
  }
  return false
}

export class EchoGuard {
  private words: string[] = []
  private playing = false
  /** Until when the remembered words still count; null when nothing was spoken. */
  private until: number | null = null
  /** When the agent's audio last stopped. */
  private stoppedAt = Number.NEGATIVE_INFINITY
  /** When the remembered words began: talk heard before then can't be their echo. */
  private since = Number.NEGATIVE_INFINITY

  /** The agent is about to say this (a caption went out for it). */
  said(text: string, now: number): void {
    // A new stretch of speech after a quiet gap starts a new memory.
    if (!this.playing && (this.until === null || now > this.until)) {
      this.words = []
      this.since = now
    }
    this.words.push(...echoWords(text))
    if (this.words.length > MAX_WORDS) this.words = this.words.slice(-MAX_WORDS)
    if (!this.playing) this.until = now + ECHO_TAIL_MS
  }

  /** The agent's audio started (true) or stopped — drained or cut off — (false). */
  setPlaying(playing: boolean, now: number): void {
    this.playing = playing
    if (!playing) {
      this.until = now + ECHO_TAIL_MS
      this.stoppedAt = now
    }
  }

  /** How long the agent's voice has been quiet: 0 while it plays, Infinity if it never spoke. */
  msSinceVoice(now: number): number {
    return this.playing ? 0 : now - this.stoppedAt
  }

  reset(): void {
    this.words = []
    this.playing = false
    this.until = null
    this.stoppedAt = Number.NEGATIVE_INFINITY
    this.since = Number.NEGATIVE_INFINITY
  }

  /** Whether a transcript is most likely the agent's own voice coming back. */
  isEcho(transcript: string, now: number): boolean {
    if (this.words.length === 0) return false
    if (!this.playing && (this.until === null || now > this.until)) return false
    // Words you finished before the agent said these (a slow listener's turn) aren't their echo.
    if (now < this.since) return false
    const heard = echoWords(transcript)
    if (heard.length === 0) return false
    if (heard.length < SHORT_WORDS) return this.playing && containsRun(this.words, heard)
    return lcs(heard, this.words) / heard.length >= ECHO_MATCH
  }
}
