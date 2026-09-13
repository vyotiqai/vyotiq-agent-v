import { describe, expect, it } from 'vitest'
import { isTruncatedStop, normalizeStopReason } from '@main/agent/providers/stopReason'

describe('normalizeStopReason', () => {
  it('returns undefined for empty input', () => {
    expect(normalizeStopReason(undefined)).toBeUndefined()
    expect(normalizeStopReason(null)).toBeUndefined()
    expect(normalizeStopReason('')).toBeUndefined()
    expect(normalizeStopReason('   ')).toBeUndefined()
  })

  it('maps length / max_tokens variants before generic tool substrings', () => {
    expect(normalizeStopReason('length')).toBe('length')
    expect(normalizeStopReason('max_tokens')).toBe('length')
    expect(normalizeStopReason('MAX_TOKENS')).toBe('length')
    expect(normalizeStopReason('max_output_tokens')).toBe('length')
  })

  it('maps tool / function stop reasons', () => {
    expect(normalizeStopReason('tool_calls')).toBe('tool_calls')
    expect(normalizeStopReason('tool_use')).toBe('tool_calls')
    expect(normalizeStopReason('function_call')).toBe('tool_calls')
  })

  it('maps content filter / safety variants', () => {
    expect(normalizeStopReason('content_filter')).toBe('content_filter')
    expect(normalizeStopReason('safety')).toBe('content_filter')
    expect(normalizeStopReason('recitation')).toBe('content_filter')
    expect(normalizeStopReason('refusal')).toBe('content_filter')
  })

  it('maps clean stop variants', () => {
    expect(normalizeStopReason('stop')).toBe('stop')
    expect(normalizeStopReason('end_turn')).toBe('stop')
    expect(normalizeStopReason('stop_sequence')).toBe('stop')
    expect(normalizeStopReason('completed')).toBe('stop')
  })

  it('maps error variants and unknown leftovers', () => {
    expect(normalizeStopReason('error')).toBe('error')
    expect(normalizeStopReason('failed')).toBe('error')
    expect(normalizeStopReason('weird_provider_stop')).toBe('unknown')
  })
})

describe('isTruncatedStop', () => {
  it('is true only for length', () => {
    expect(isTruncatedStop('length')).toBe(true)
    expect(isTruncatedStop('stop')).toBe(false)
    expect(isTruncatedStop(undefined)).toBe(false)
  })
})
