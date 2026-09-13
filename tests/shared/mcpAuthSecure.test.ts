import { describe, expect, it } from 'vitest'
import {
  getBearerToken,
  headersWithoutAuthorization,
  withBearerToken
} from '@shared/utils/mcpAuth'

describe('mcp auth header stripping for secure storage', () => {
  it('strips Authorization so tokens are not persisted in settings', () => {
    const withAuth = withBearerToken({ 'X-Trace': '1' }, 'secret')
    expect(getBearerToken(withAuth)).toBe('secret')
    expect(headersWithoutAuthorization(withAuth)).toEqual({ 'X-Trace': '1' })
  })
})
