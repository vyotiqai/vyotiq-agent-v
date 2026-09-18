import { describe, expect, it } from 'vitest'
import {
  mcpRequiresOAuth,
  mcpSupportsOAuth,
  mcpUsesTokenAuth
} from '@shared/mcpApps'

/**
 * `mcpSupportsOAuth` answers "should the UI offer Sign in?" and
 * `mcpRequiresOAuth` answers "is an unauthenticated connect pointless?".
 * They differ for manually added servers, where auth is unknown — conflating
 * them breaks public endpoints added through the paste box.
 */
describe('MCP OAuth predicates', () => {
  it('offers and requires sign-in for an oauth package', () => {
    const server = { auth: 'oauth', transport: 'http' }
    expect(mcpSupportsOAuth(server)).toBe(true)
    expect(mcpRequiresOAuth(server)).toBe(true)
  })

  it('offers sign-in for a manual remote server but still tries connecting first', () => {
    const manual = { transport: 'http' }
    expect(mcpSupportsOAuth(manual)).toBe(true)
    expect(mcpRequiresOAuth(manual)).toBe(false)
  })

  it('does neither for a declared public endpoint', () => {
    const publicServer = { auth: 'none', transport: 'http' }
    expect(mcpSupportsOAuth(publicServer)).toBe(false)
    expect(mcpRequiresOAuth(publicServer)).toBe(false)
  })

  it('does neither for a token package — it has no browser flow', () => {
    const token = { auth: 'token', transport: 'http' }
    expect(mcpSupportsOAuth(token)).toBe(false)
    expect(mcpRequiresOAuth(token)).toBe(false)
    expect(mcpUsesTokenAuth(token)).toBe(true)
  })

  it('never offers OAuth for stdio, which startMcpOAuth rejects', () => {
    expect(mcpSupportsOAuth({ transport: 'stdio' })).toBe(false)
    expect(mcpSupportsOAuth({})).toBe(false)
    expect(mcpRequiresOAuth({ auth: 'oauth', transport: 'stdio' })).toBe(false)
  })

  it('treats sse like http', () => {
    expect(mcpSupportsOAuth({ auth: 'oauth', transport: 'sse' })).toBe(true)
    expect(mcpRequiresOAuth({ auth: 'oauth', transport: 'sse' })).toBe(true)
  })
})
