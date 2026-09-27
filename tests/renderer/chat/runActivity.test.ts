import { describe, expect, it } from 'vitest'
import { formatRunActivityLabel } from '@renderer/features/chat/utils/runActivity'

describe('formatRunActivityLabel', () => {
  it('joins tool verb and detail', () => {
    expect(
      formatRunActivityLabel({ kind: 'tool', label: 'Reading', detail: 'package.json' })
    ).toBe('Reading package.json')
  })

  it('formats non-tool phases', () => {
    expect(formatRunActivityLabel({ kind: 'thinking' })).toBe('Thinking')
    expect(formatRunActivityLabel({ kind: 'writing' })).toBe('Writing')
    expect(formatRunActivityLabel({ kind: 'planning' })).toBe('Planning')
    expect(formatRunActivityLabel({ kind: 'working' })).toBe('Working')
    expect(formatRunActivityLabel({ kind: 'compacting' })).toBe('Compacting…')
    expect(formatRunActivityLabel({ kind: 'verifying_compact' })).toBe('Verifying summary…')
    expect(formatRunActivityLabel({ kind: 'retrying_compact' })).toBe('Retrying summary…')
    expect(formatRunActivityLabel({ kind: 'awaiting_approval' })).toBe('Awaiting approval')
  })
})

describe('reconnecting label', () => {
  it('keeps the counted form when there is an attempt ceiling', () => {
    expect(formatRunActivityLabel({ kind: 'reconnecting', attempt: 2, maxAttempts: 5 })).toBe(
      'Reconnecting (2/5)'
    )
  })

  it('does not print a "/0" ceiling for unbounded retries', () => {
    // Provider retries carry maxAttempts 0 by design (retry until recovery);
    // every real network_wait event measured used it, so "(17/0)" was what
    // users actually saw.
    const label = formatRunActivityLabel({ kind: 'reconnecting', attempt: 17, maxAttempts: 0 })
    expect(label).toBe('Reconnecting (attempt 17)')
    expect(label).not.toContain('/0')
  })

  it("shows the provider's own reason when it gave one", () => {
    expect(
      formatRunActivityLabel({
        kind: 'reconnecting',
        attempt: 3,
        maxAttempts: 0,
        reason: '5-hour usage limit reached. Resets in 3hr 16min.'
      })
    ).toBe('Reconnecting (attempt 3) — 5-hour usage limit reached. Resets in 3hr 16min.')
  })

  it('truncates a long provider reason instead of flooding the status line', () => {
    const long = 'x'.repeat(300)
    const label = formatRunActivityLabel({
      kind: 'reconnecting',
      attempt: 1,
      maxAttempts: 0,
      reason: long
    })
    expect(label.length).toBeLessThan(140)
    expect(label.startsWith('Reconnecting (attempt 1) — ')).toBe(true)
  })

  it('falls back to the plain label when the reason is blank', () => {
    expect(
      formatRunActivityLabel({ kind: 'reconnecting', attempt: 4, maxAttempts: 0, reason: '   ' })
    ).toBe('Reconnecting (attempt 4)')
  })
})
