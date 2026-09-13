import { normalizeTrigger } from './normalize'

export type ActiveSlashToken = {
  /** Absolute start index of `/` in the full text. */
  start: number
  /** Absolute end index (exclusive) of the trigger token (before trailing args). */
  end: number
  /** Trigger without leading `/`. */
  trigger: string
  /** Text after the trigger token (may be empty). */
  trailingText: string
  /** Raw query used for filtering (trigger as typed). */
  query: string
}

/**
 * Detect an active slash token at the cursor.
 * Active when the caret is inside `/word` at the start of the draft or after whitespace.
 */
export function findActiveSlashToken(
  text: string,
  cursor: number
): ActiveSlashToken | null {
  const pos = Math.max(0, Math.min(cursor, text.length))
  // Walk left to the start of the current token.
  let start = pos
  while (start > 0) {
    const ch = text[start - 1]
    if (ch === '\n' || ch === ' ' || ch === '\t') break
    start -= 1
  }
  if (text[start] !== '/') return null
  // Only activate when `/` is at line start or after whitespace (always true from walk).
  if (start > 0) {
    const before = text[start - 1]
    if (before !== '\n' && before !== ' ' && before !== '\t') return null
  }

  // Trigger runs until whitespace or end of text.
  let end = start + 1
  while (end < text.length) {
    const ch = text[end]
    if (ch === ' ' || ch === '\t' || ch === '\n') break
    end += 1
  }

  // Menu is open while typing the trigger (cursor within token) or just after `/`.
  // Once the user types a space after the trigger, the menu closes unless they
  // move the caret back into the token.
  if (pos > end) return null

  const rawTrigger = text.slice(start + 1, end)
  // Disallow second `/` inside the token (paths).
  if (rawTrigger.includes('/')) return null

  // Trailing text is everything after the trigger token (for resolve on submit).
  const afterToken = text.slice(end).replace(/^\s+/, '')

  return {
    start,
    end,
    trigger: normalizeTrigger(rawTrigger),
    trailingText: afterToken,
    query: rawTrigger
  }
}

/** Parse a full submit string that starts with `/command …args`. */
export function parseSlashSubmit(text: string): {
  trigger: string
  trailingText: string
} | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (!m) return null
  return {
    trigger: normalizeTrigger(m[1] ?? ''),
    trailingText: (m[2] ?? '').trim()
  }
}
