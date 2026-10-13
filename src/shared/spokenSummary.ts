/**
 * The `<spoken>` block (docs/voice-mode.md §8.2): in voice mode the model
 * opens its final answer with a short spoken summary inside this tag. Main
 * streams the block's contents to text-to-speech as they arrive; the record
 * hides the block so the answer isn't shown twice.
 *
 * Shared because both sides need it: main parses it from the token stream,
 * the renderer strips it from displayed text.
 */

export const SPOKEN_OPEN = '<spoken>'
export const SPOKEN_CLOSE = '</spoken>'

/** True when `s` could still grow into `full` (it is a prefix of it). */
function isPrefixOf(s: string, full: string): boolean {
  return s.length <= full.length && full.startsWith(s)
}

/**
 * Remove a leading `<spoken>…</spoken>` block from an answer for display.
 * While the answer is still streaming, an unterminated block (or a partial
 * opening tag) hides everything after it, so the summary never flashes on
 * screen before the tag closes.
 */
export function stripSpokenBlock(text: string): string {
  const lead = text.length - text.trimStart().length
  const rest = text.slice(lead)
  if (rest.length > 0 && rest.length < SPOKEN_OPEN.length && isPrefixOf(rest, SPOKEN_OPEN)) return ''
  if (!rest.startsWith(SPOKEN_OPEN)) return text
  const close = rest.indexOf(SPOKEN_CLOSE, SPOKEN_OPEN.length)
  if (close === -1) return ''
  return rest.slice(close + SPOKEN_CLOSE.length).replace(/^\s+/, '')
}

/** The block's contents when the answer opens with a complete one, else null. */
export function extractSpokenBlock(text: string): string | null {
  const rest = text.trimStart()
  if (!rest.startsWith(SPOKEN_OPEN)) return null
  const close = rest.indexOf(SPOKEN_CLOSE, SPOKEN_OPEN.length)
  if (close === -1) return null
  return rest.slice(SPOKEN_OPEN.length, close).trim()
}

export type SpokenParserPhase =
  /** Nothing but whitespace (or part of the opening tag) seen yet. */
  | 'leading'
  /** Inside the block: text is being emitted. */
  | 'inside'
  /** The block closed; the rest of the answer is for the screen. */
  | 'after'
  /** The answer didn't open with the tag; the caller falls back (§8.2). */
  | 'absent'

/**
 * Incremental parser for a streamed answer. Feed it every text delta in
 * order; it returns the spoken text that became safe to speak with that
 * delta. A closing tag split across deltas is held back, never spoken.
 */
export class SpokenStreamParser {
  private phaseValue: SpokenParserPhase = 'leading'
  /** Text not yet classified: a possible opening tag, or a possible closing-tag prefix. */
  private pending = ''

  get phase(): SpokenParserPhase {
    return this.phaseValue
  }

  push(delta: string): string {
    if (!delta) return ''
    if (this.phaseValue === 'after' || this.phaseValue === 'absent') return ''
    this.pending += delta
    if (this.phaseValue === 'leading') {
      const rest = this.pending.trimStart()
      if (rest.length === 0) return ''
      if (rest.length < SPOKEN_OPEN.length) {
        if (isPrefixOf(rest, SPOKEN_OPEN)) return ''
        return this.giveUp()
      }
      if (!rest.startsWith(SPOKEN_OPEN)) return this.giveUp()
      this.phaseValue = 'inside'
      this.pending = rest.slice(SPOKEN_OPEN.length)
    }
    return this.drainInside()
  }

  /** The stream ended. Returns any spoken text still held back. */
  end(): string {
    if (this.phaseValue === 'inside') {
      // Unterminated block: speak what we have; a stray partial "</spo" is dropped.
      const out = this.pending
      this.pending = ''
      this.phaseValue = 'after'
      return stripPartialClose(out)
    }
    if (this.phaseValue === 'leading') this.phaseValue = 'absent'
    this.pending = ''
    return ''
  }

  private giveUp(): string {
    this.phaseValue = 'absent'
    this.pending = ''
    return ''
  }

  private drainInside(): string {
    const close = this.pending.indexOf(SPOKEN_CLOSE)
    if (close !== -1) {
      const out = this.pending.slice(0, close)
      this.pending = ''
      this.phaseValue = 'after'
      return out
    }
    // Hold back a tail that could be the start of the closing tag.
    let hold = 0
    for (let n = Math.min(SPOKEN_CLOSE.length - 1, this.pending.length); n > 0; n--) {
      if (SPOKEN_CLOSE.startsWith(this.pending.slice(-n))) {
        hold = n
        break
      }
    }
    const out = this.pending.slice(0, this.pending.length - hold)
    this.pending = this.pending.slice(this.pending.length - hold)
    return out
  }
}

function stripPartialClose(text: string): string {
  for (let n = Math.min(SPOKEN_CLOSE.length - 1, text.length); n > 0; n--) {
    if (SPOKEN_CLOSE.startsWith(text.slice(-n))) return text.slice(0, -n)
  }
  return text
}
