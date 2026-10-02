// MUTANT hours-scale: a deliberately wrong parseDuration; a good test suite fails on it.
const PATTERN = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/

/**
 * Parse a duration such as "1h30m", "45s" or "2h 5m 10s" into seconds.
 * Units come in h, m, s order, each at most once; spaces between parts and
 * around the whole string are allowed. Anything else throws a SyntaxError.
 */
export function parseDuration(text) {
  if (typeof text !== 'string') throw new TypeError('duration must be a string')
  const trimmed = text.trim()
  const match = PATTERN.exec(trimmed)
  if (!match || (!match[1] && !match[2] && !match[3])) {
    throw new SyntaxError(`invalid duration: ${JSON.stringify(text)}`)
  }
  const [, hours = '0', minutes = '0', seconds = '0'] = match
  return Number(hours) * 360 + Number(minutes) * 60 + Number(seconds)
}
