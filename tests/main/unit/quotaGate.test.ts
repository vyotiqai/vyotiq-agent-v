import { describe, expect, it } from 'vitest'
import { isQuotaExhaustedMessage } from '@main/agent/quotaGate'
import { parseCircuitRetryAfterMs } from '@main/agent/circuitBreaker'
import { planGoalRelaunch } from '@main/agent/goalRelaunchPlan'
import type { RunStatus } from '@shared/ipc'

// Verbatim from %APPDATA%/vyotiq/logs/vyotiq.log run 6265fa90,
// 2026-08-31T17:43:24.373Z (Provider http failure, opencode glm-5.3-flash, 429).
const INCIDENT_QUOTA_MESSAGE =
  'Weekly usage limit reached. Resets in 6 days. To continue using this model now, ' +
  'enable usage from your available balance: https://opencode.ai/workspace/wrk_EXAMPLE/go'
// Verbatim shape of the CircuitOpenError message that went terminal in the storm.
const INCIDENT_CIRCUIT_MESSAGE = 'Circuit open for http:opencode.ai; retry in 58s'

const resumableCircuitStatus: RunStatus = {
  status: 'error',
  step: 29,
  updatedAt: '2026-08-31T17:44:16.904Z',
  error: INCIDENT_CIRCUIT_MESSAGE,
  resumable: true
}

const resumableQuotaStatus: RunStatus = {
  ...resumableCircuitStatus,
  error: INCIDENT_QUOTA_MESSAGE
}

// Verbatim from %APPDATA%/vyotiq/logs/vyotiq.log, 2026-09-29 00:12:58Z
// through 00:44:12Z: 88 occurrences across 7 run ids, 12–13 retries each on
// the same step, all PROVIDER_HTTP 429 on opencode mimo-v2.6-pro.
const VENDOR_USAGE_LIMIT_429 = 'Go usage limit exceeded'
// Same vendor family, longer shapes: the opencode gateway's 5-hour window
// wording (verbatim from the live gateway 2026-09-19, asserted as a retry in
// streamRetry.test.ts) and its "You have exceeded your usage limit" form.
const VENDOR_5H_WINDOW_MESSAGE =
  '5-hour usage limit reached. Resets in 3hr 4min. To continue using this model now, enable usage from your available balance: https://opencode.ai/workspace/wrk_01M2VV4MEG5G6FTWEZYVSBPHY2/go'
const VENDOR_EXCEEDED_YOU_MESSAGE =
  'You have exceeded your usage limit for this plan. Upgrade to continue.'

describe('quotaGate', () => {
  it('matches the verbatim incident quota message', () => {
    expect(isQuotaExhaustedMessage(INCIDENT_QUOTA_MESSAGE)).toBe(true)
  })

  it('matches other usage-limit phrasings', () => {
    expect(isQuotaExhaustedMessage('monthly usage limit exceeded for this key')).toBe(true)
    expect(isQuotaExhaustedMessage('Quota exceeded for model glm-5.3-flash')).toBe(true)
    expect(isQuotaExhaustedMessage('usage limit reached — upgrade your plan')).toBe(true)
  })

  it('does not match transient rate limits, network errors, or empty text', () => {
    expect(isQuotaExhaustedMessage('Rate limit exceeded, retry after 12s')).toBe(false)
    expect(
      isQuotaExhaustedMessage('Connect timed out waiting for response headers after 30000ms')
    ).toBe(false)
    expect(isQuotaExhaustedMessage('socket hang up')).toBe(false)
    expect(isQuotaExhaustedMessage('')).toBe(false)
  })

  // Regression: 88× "Go usage limit exceeded" (2026-09-29) is a plan limit,
  // and the pre-fix regex had no alternative for "exceeded" wording — every
  // phrase it held ended in "reached". All three guards that consult this
  // classifier (goalRelaunchPlan, resumeActiveGoals, runLoopScheduler) were
  // defeated by that gap.
  it('matches the 2026-09-29 vendor 429 message verbatim', () => {
    expect(isQuotaExhaustedMessage(VENDOR_USAGE_LIMIT_429)).toBe(true)
  })

  it('matches the bare "usage limit exceeded" wording', () => {
    expect(isQuotaExhaustedMessage('usage limit exceeded')).toBe(true)
  })

  it('matches real-world variants of the same gate', () => {
    // opencode gateway 5-hour window wording (live gateway, 2026-09-19).
    expect(isQuotaExhaustedMessage(VENDOR_5H_WINDOW_MESSAGE)).toBe(true)
    // opencode "You have exceeded your usage limit" upgrade prompt.
    expect(isQuotaExhaustedMessage(VENDOR_EXCEEDED_YOU_MESSAGE)).toBe(true)
    // Same sentence shape without the leading pronoun, plus plan-limit wording.
    expect(isQuotaExhaustedMessage('Exceeded the monthly usage limit for this account.')).toBe(
      true
    )
    expect(
      isQuotaExhaustedMessage('Plan limit reached for this workspace. Upgrade to continue.')
    ).toBe(true)
    expect(isQuotaExhaustedMessage('Daily usage limit reached — resets at midnight UTC')).toBe(true)
  })

  // "Rate limit exceeded, retry after 12s" is deliberately still FALSE: every
  // gate alternative requires a `usage`/`quota`/`plan` subject, so a bare
  // "limit exceeded" stays the throttling wording.
  it('keeps throttling wordings transient', () => {
    expect(isQuotaExhaustedMessage('Rate limit exceeded, retry after 12s')).toBe(false)
    expect(isQuotaExhaustedMessage('Request limit exceeded (HTTP 429)')).toBe(false)
    expect(isQuotaExhaustedMessage('Too many requests — slow down')).toBe(false)
    // "exceeded your … limit" needs the usage/quota subject; a rate limit with
    // the same sentence shape stays transient.
    expect(isQuotaExhaustedMessage('You have exceeded your rate limit.')).toBe(false)
    expect(isQuotaExhaustedMessage('exceeded your monthly limits')).toBe(false)
    expect(isQuotaExhaustedMessage('file size limit exceeded')).toBe(false)
  })

  it('holds on empty, whitespace-only and abusive short input without throwing', () => {
    expect(isQuotaExhaustedMessage('   ')).toBe(false)
    expect(isQuotaExhaustedMessage('\n\t ')).toBe(false)
    expect(isQuotaExhaustedMessage('limit')).toBe(false)
    expect(isQuotaExhaustedMessage('usage')).toBe(false)
    expect(isQuotaExhaustedMessage('exceeded your ')).toBe(false)
    expect(isQuotaExhaustedMessage('\n\n')).toBe(false)
    // Bounded gaps: no catastrophic backtracking on long near-miss inputs.
    expect(isQuotaExhaustedMessage(`exceeded your ${'x'.repeat(50_000)} rate limit`)).toBe(false)
    expect(isQuotaExhaustedMessage(`${'a'.repeat(50_000)} usage limit exceeded`)).toBe(true)
  })
})

describe('planGoalRelaunch (goal relaunch gate)', () => {
  const base = {
    terminalStatus: 'error' as const,
    goalActive: true
  }

  it('blocks relaunch on a quota-exhausted stop even with an active goal', () => {
    expect(planGoalRelaunch({ ...base, persisted: resumableQuotaStatus })).toEqual({
      kind: 'blocked_quota',
      reason: 'quota_exhausted'
    })
  })

  it('honors the circuit retry window as a delayed relaunch (incident: 58s)', () => {
    expect(planGoalRelaunch({ ...base, persisted: resumableCircuitStatus })).toEqual({
      kind: 'delayed',
      delayMs: 58_000
    })
  })

  it('clamps the delay to [1s, 120s]', () => {
    const soon = planGoalRelaunch({
      ...base,
      persisted: { ...resumableCircuitStatus, error: 'Circuit open for http:x; retry in 1s' }
    })
    expect(soon).toEqual({ kind: 'delayed', delayMs: 1_000 })
    const far = planGoalRelaunch({
      ...base,
      persisted: { ...resumableCircuitStatus, error: 'Circuit open for http:x; retry in 900s' }
    })
    expect(far).toEqual({ kind: 'delayed', delayMs: 120_000 })
  })

  it('keeps planning delayed relaunches no matter how many relaunches already happened (cap removed)', () => {
    // No relaunch budget (run-stopping caps removed): the plan API no longer
    // takes a relaunch count, and repeated calls keep yielding the same
    // delayed relaunch until the goal completes or the user stops it.
    for (let i = 0; i < 10; i++) {
      expect(planGoalRelaunch({ ...base, persisted: resumableCircuitStatus })).toEqual({
        kind: 'delayed',
        delayMs: 58_000
      })
    }
  })

  it('still relaunches immediately for plain network stops', () => {
    expect(
      planGoalRelaunch({
        ...base,
        persisted: {
          ...resumableCircuitStatus,
          error: 'Connect timed out waiting for response headers after 30000ms'
        }
      })
    ).toEqual({ kind: 'immediate' })
  })

  it('does not relaunch non-resumable, non-error, inline-instance, or inactive-goal stops', () => {
    const none: { kind: 'none' } = { kind: 'none' }
    expect(
      planGoalRelaunch({ ...base, persisted: { ...resumableCircuitStatus, resumable: undefined } })
    ).toEqual(none)
    expect(
      planGoalRelaunch({ ...base, terminalStatus: 'done', persisted: resumableCircuitStatus })
    ).toEqual(none)
    expect(
      planGoalRelaunch({
        ...base,
        persisted: { ...resumableCircuitStatus, inlineInstance: true }
      })
    ).toEqual(none)
    expect(planGoalRelaunch({ ...base, goalActive: false, persisted: resumableCircuitStatus })).toEqual(
      none
    )
    expect(planGoalRelaunch({ ...base, persisted: null })).toEqual(none)
  })

  it('parses the incident circuit-message shape for the retry window', () => {
    expect(parseCircuitRetryAfterMs(INCIDENT_CIRCUIT_MESSAGE)).toBe(58_000)
    expect(parseCircuitRetryAfterMs('Circuit open for provider:opencode:http:x; retry in 60s')).toBe(
      60_000
    )
    expect(parseCircuitRetryAfterMs('Provider stream failed after 2 attempts')).toBeNull()
  })
})
