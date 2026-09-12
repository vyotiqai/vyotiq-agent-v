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
