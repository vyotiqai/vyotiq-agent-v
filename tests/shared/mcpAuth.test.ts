import { describe, expect, it } from 'vitest'
import {
  getBearerToken,
  getAuthorizationHeader,
  hasNonBearerAuthorization,
  headersWithoutAuthorization,
  remoteMcpIdFromUrl,
  withBearerToken
} from '@shared/utils/mcpAuth'

describe('mcpAuth', () => {
  it('round-trips bearer tokens into Authorization header', () => {
    const headers = withBearerToken({ 'X-Custom': '1' }, 'secret-token')
    expect(getBearerToken(headers)).toBe('secret-token')
    expect(getAuthorizationHeader(headers)).toBe('Bearer secret-token')
    expect(headersWithoutAuthorization(headers)).toEqual({ 'X-Custom': '1' })
  })

  it('clears Authorization when bearer is empty', () => {
    const headers = withBearerToken({ Authorization: 'Bearer old', 'X-Custom': '1' }, '')
    expect(getAuthorizationHeader(headers)).toBeUndefined()
    expect(headers).toEqual({ 'X-Custom': '1' })
  })

  it('detects non-bearer Authorization', () => {
    expect(hasNonBearerAuthorization({ Authorization: 'Basic abc' })).toBe(true)
    expect(hasNonBearerAuthorization({ Authorization: 'Bearer abc' })).toBe(false)
  })

  it('builds stable remote MCP ids from URLs', () => {
    const id = remoteMcpIdFromUrl('https://mcp.example.com/v1/sse')
    expect(id.startsWith('remote-')).toBe(true)
    expect(id.includes('__')).toBe(false)
    const other = remoteMcpIdFromUrl(
      'https://mcp.example.com/v1/sse-extra-path-that-shares-prefix'
    )
    expect(other).not.toBe(id)
  })
})
