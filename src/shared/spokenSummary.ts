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

/**
 * A blank line inside the block ends it too. The block is one to three
 * sentences, never paragraphs, but models drop the closing tag: in run
 * c79e6792 (2026-10-17) ten of 22 spoken replies had no `</spoken>`, so
 * every list item and "1." of the written answer after them was read aloud,
 * and the screen, which hid an unclosed block, showed none of it.
 */
const BLOCK_BREAK = /\n[ \t]*\r?\n/

/** Where the block that starts at 0 of `inner` ends: its contents' length and where the rest begins. */
function blockEnd(inner: string): { length: number; restAt: number } | null {
  const close = inner.indexOf(SPOKEN_CLOSE)
  const brk = BLOCK_BREAK.exec(inner)
  if (brk && (close === -1 || brk.index < close)) return { length: brk.index, restAt: brk.index + brk[0].length }
  if (close !== -1) return { length: close, restAt: close + SPOKEN_CLOSE.length }
  return null
}

/** The written part after a block that a blank line ended; a closing tag the model added later isn't shown. */
function withoutStrayClose(rest: string): string {
  return rest.replace(SPOKEN_CLOSE, '')
}

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
  const inner = rest.slice(SPOKEN_OPEN.length)
  const end = blockEnd(inner)
  if (!end) return ''
  return withoutStrayClose(inner.slice(end.restAt)).replace(/^\s+/, '')
}

/** The block's contents when the answer opens with a complete one, else null. */
export function extractSpokenBlock(text: string): string | null {
  const rest = text.trimStart()
  if (!rest.startsWith(SPOKEN_OPEN)) return null
  const inner = rest.slice(SPOKEN_OPEN.length)
  const end = blockEnd(inner)
  if (!end) return null
  return inner.slice(0, end.length).trim()
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
    const end = blockEnd(this.pending)
    if (end) {
      const out = this.pending.slice(0, end.length)
      this.pending = ''
      this.phaseValue = 'after'
      return out
    }
    // Hold back a tail that could be the start of the closing tag, or of a blank line.
    let hold = 0
    for (let n = Math.min(SPOKEN_CLOSE.length - 1, this.pending.length); n > 0; n--) {
      if (SPOKEN_CLOSE.startsWith(this.pending.slice(-n))) {
        hold = n
        break
      }
    }
    const lineBreak = /\n[ \t\r]*$/.exec(this.pending)
    if (lineBreak) hold = Math.max(hold, lineBreak[0].length)
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
