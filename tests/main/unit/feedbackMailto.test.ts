import { describe, expect, it } from 'vitest'
import { buildFeedbackMailto, FEEDBACK_EMAIL } from '@main/feedback/mailto'
import type { FeedbackMailtoInput } from '@main/feedback/mailto'

const base: FeedbackMailtoInput = {
  type: 'bug',
  title: 'Crash on save',
  message: 'App crashed when saving',
  includeDiagnostics: false,
  appVersion: '1.2.3',
  os: 'Windows_NT 10.0.26200 (x64)',
  locale: 'en-US',
  now: new Date('2026-09-08T12:00:00.000Z')
}

describe('buildFeedbackMailto', () => {
  it('targets vyotiq@gmail.com with exact subject/body (no diagnostics)', () => {
    const url = buildFeedbackMailto(base)
    expect(url.startsWith(`mailto:${FEEDBACK_EMAIL}?subject=`)).toBe(true)
    expect(url).toBe(
      `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(
        '[Vyotiq 1.2.3] bug: Crash on save'
      )}&body=${encodeURIComponent('App crashed when saving')}`
    )
  })

  it('appends the exact diagnostics block only when requested', () => {
    const expectedBody = [
      'App crashed when saving',
      '',
      '---',
      'App version: 1.2.3',
      'OS: Windows_NT 10.0.26200 (x64)',
      'Locale: en-US',
      'Timestamp: 2026-09-08T12:00:00.000Z'
    ].join('\n')
    expect(buildFeedbackMailto(base)).not.toContain('App%20version')
    expect(buildFeedbackMailto({ ...base, includeDiagnostics: true })).toBe(
      `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(
        '[Vyotiq 1.2.3] bug: Crash on save'
      )}&body=${encodeURIComponent(expectedBody)}`
    )
  })

  it('uses the now param for a deterministic timestamp', () => {
    const url = buildFeedbackMailto({
      ...base,
      includeDiagnostics: true,
      now: new Date('2027-01-01T00:00:00.000Z')
    })
    expect(url).toContain(encodeURIComponent('Timestamp: 2027-01-01T00:00:00.000Z'))
  })

  it('reflects every feedback type in the subject', () => {
    for (const type of ['bug', 'feature', 'praise', 'other'] as const) {
      const url = buildFeedbackMailto({ ...base, type })
      expect(url).toContain(
        encodeURIComponent(`[Vyotiq 1.2.3] ${type}: Crash on save`)
      )
    }
  })

  it('encodes title and message specials', () => {
    const url = buildFeedbackMailto({
      ...base,
      type: 'feature',
      title: 'A & B <test> 100% "quoted" ?',
      message: 'line1\nline2 & more'
    })
    expect(url).toContain(
      encodeURIComponent('[Vyotiq 1.2.3] feature: A & B <test> 100% "quoted" ?')
    )
    expect(url.endsWith(`&body=${encodeURIComponent('line1\nline2 & more')}`)).toBe(true)
  })

  it('never injects chat/conversation content into diagnostics', () => {
    const url = buildFeedbackMailto({
      ...base,
      includeDiagnostics: true,
      message: 'User typed this'
    })
    const body = decodeURIComponent(url.split('&body=')[1] as string)
    expect(body).toBe(
      [
        'User typed this',
        '',
        '---',
        'App version: 1.2.3',
        'OS: Windows_NT 10.0.26200 (x64)',
        'Locale: en-US',
        'Timestamp: 2026-09-08T12:00:00.000Z'
      ].join('\n')
    )
  })
})
