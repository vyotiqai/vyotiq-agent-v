import type { StopReason } from './types'

/**
 * Providers spell the same outcome many ways (`max_tokens`, `MAX_TOKENS`,
 * `max_output_tokens`, `length`). Normalize on substrings so an unseen variant
 * still lands in the right bucket instead of silently reading as a clean stop.
 */
export function normalizeStopReason(raw: unknown): StopReason | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const value = raw.trim().toLowerCase()

  // Length before generic "tool" so strings like max_tokens win over tool_calls.
  if (value.includes('max_token') || value.includes('max_output') || value === 'length') {
    return 'length'
  }
  if (value.includes('tool') || value.includes('function')) return 'tool_calls'
  if (
    value.includes('safety') ||
    value.includes('content_filter') ||
    value.includes('prohibited') ||
    value.includes('blocklist') ||
    value.includes('recitation') ||
    value.includes('refusal')
  ) {
    return 'content_filter'
  }
  if (value === 'stop' || value === 'end_turn' || value === 'stop_sequence' || value === 'completed') {
    return 'stop'
  }
  if (value === 'error' || value === 'failed') return 'error'
  return 'unknown'
}

/** True when the model was cut off before it could finish its turn. */
export function isTruncatedStop(reason: StopReason | undefined): boolean {
  return reason === 'length'
}
