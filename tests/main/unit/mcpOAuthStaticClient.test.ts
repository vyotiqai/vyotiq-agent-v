import { describe, expect, it, vi } from 'vitest'

const getMcpOAuthClientSecret = vi.fn((): string | null => null)
const getGoogleMcpClientSecret = vi.fn((): string | null => null)
const getSettings = vi.fn(() => ({ googleMcpClientId: '' }))

vi.mock('@main/settings/secrets', () => ({
  getMcpOAuthClientSecret: (...args: unknown[]) => getMcpOAuthClientSecret(...args),
  getGoogleMcpClientSecret: (...args: unknown[]) => getGoogleMcpClientSecret(...args)
}))
vi.mock('@main/settings/settings', () => ({
  getSettings: (...args: unknown[]) => getSettings(...args)
}))

import {
  mcpOAuthCallbackListenOpts,
  resolveMcpOAuthStaticClient
} from '@main/agent/mcp/oauthStaticClient'
import { MCP_OAUTH_FIXED_LOOPBACK_PORT } from '@shared/mcpApps'

describe('resolveMcpOAuthStaticClient', () => {
  it('returns per-server client id and secret', () => {
    getMcpOAuthClientSecret.mockReturnValue('per-secret')
    expect(
      resolveMcpOAuthStaticClient({ id: 'custom', oauthClientId: 'per-id' })
    ).toEqual({ client_id: 'per-id', client_secret: 'per-secret' })
    expect(mcpOAuthCallbackListenOpts({ client_id: 'per-id' })).toEqual({
      fixedPort: MCP_OAUTH_FIXED_LOOPBACK_PORT
    })
  })

  it('falls back to the shared Google client for Gmail/Drive/Calendar', () => {
    getMcpOAuthClientSecret.mockReturnValue(null)
    getGoogleMcpClientSecret.mockReturnValue('shared-secret')
    getSettings.mockReturnValue({ googleMcpClientId: 'shared-id' })
    expect(resolveMcpOAuthStaticClient({ id: 'gmail' })).toEqual({
      client_id: 'shared-id',
      client_secret: 'shared-secret'
    })
    expect(resolveMcpOAuthStaticClient({ id: 'github' })).toBeUndefined()
    expect(mcpOAuthCallbackListenOpts(undefined)).toBeUndefined()
  })
})
