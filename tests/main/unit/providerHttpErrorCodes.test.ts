import { describe, expect, it } from 'vitest'
import { providerHttpErrorCode } from '@main/agent/providers/httpErrors'

describe('providerHttpErrorCode', () => {
  it('classifies auth and plan failures as PROVIDER_AUTH (permanent)', () => {
    expect(providerHttpErrorCode(401)).toBe('PROVIDER_AUTH')
    expect(providerHttpErrorCode(403)).toBe('PROVIDER_AUTH')
  })

  it('classifies credit/billing failures as PROVIDER_BILLING (permanent)', () => {
    expect(providerHttpErrorCode(402)).toBe('PROVIDER_BILLING')
  })

  it('keeps transient statuses retryable as PROVIDER_HTTP', () => {
    expect(providerHttpErrorCode(404)).toBe('PROVIDER_HTTP')
    expect(providerHttpErrorCode(429)).toBe('PROVIDER_HTTP')
    expect(providerHttpErrorCode(500)).toBe('PROVIDER_HTTP')
    expect(providerHttpErrorCode(503)).toBe('PROVIDER_HTTP')
  })

  it('defaults to PROVIDER_HTTP when no status is known', () => {
    expect(providerHttpErrorCode(undefined)).toBe('PROVIDER_HTTP')
  })
})
