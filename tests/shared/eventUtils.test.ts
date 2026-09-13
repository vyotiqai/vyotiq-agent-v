import { describe, expect, it } from 'vitest'
import { isAgentEvent, formatDisplayTime } from '@shared/eventUtils'

describe('isAgentEvent', () => {
  it('accepts valid agent events', () => {
    expect(
      isAgentEvent({
        type: 'tool_start',
        runId: 'r1',
        toolCallId: 'c1',
        name: 'read',
        summary: 'a.ts'
      })
    ).toBe(true)
  })

  it('rejects objects with only a type field', () => {
    expect(isAgentEvent({ type: 'status' })).toBe(false)
    expect(isAgentEvent({ type: 'tool_start' })).toBe(false)
    expect(isAgentEvent(null)).toBe(false)
    expect(isAgentEvent('text_delta')).toBe(false)
  })
})

describe('formatDisplayTime', () => {
  it('formats a valid ISO timestamp', () => {
    const label = formatDisplayTime('2026-07-24T15:30:45.000Z')
    expect(label.length).toBeGreaterThan(0)
    expect(label).not.toBe('2026-07-24T15:30:45.000Z')
  })

  it('includes seconds when requested', () => {
    const withSeconds = formatDisplayTime('2026-07-24T15:30:45.000Z', { seconds: true })
    const withoutSeconds = formatDisplayTime('2026-07-24T15:30:45.000Z')
    expect(withSeconds.length).toBeGreaterThanOrEqual(withoutSeconds.length)
  })

  it('returns empty string for invalid timestamps', () => {
    expect(formatDisplayTime('not-a-date')).toBe('')
    expect(formatDisplayTime('')).toBe('')
  })
})
