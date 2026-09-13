import { createServer } from 'http'
import { describe, expect, it, vi } from 'vitest'
import { mcpOAuthFixedPortBusyMessage } from '@shared/mcpApps'

// oauth.ts has no pure, side-effect-free token/URL helpers exported (PKCE and
// redirect URL building live inside the MCP SDK / localhost HTTP server which
// bind sockets and shell out to Electron). We therefore mock electron + the
// secrets store and exercise the deterministic, network-free surface of
// createMcpOAuthProvider: its redirect URL getter, client metadata, and the
// invalidateCredentials state clears.

const clearMcpOAuthState = vi.fn()
const setMcpOAuthState = vi.fn()
const patchMcpOAuthState = vi.fn()
const getMcpOAuthState = vi.fn(() => ({}))

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() }
}))
vi.mock('@main/settings/secrets', () => ({
  clearMcpOAuthState: (...args: unknown[]) => clearMcpOAuthState(...args),
  setMcpOAuthState: (...args: unknown[]) => setMcpOAuthState(...args),
  patchMcpOAuthState: (...args: unknown[]) => patchMcpOAuthState(...args),
  getMcpOAuthState: (...args: unknown[]) => getMcpOAuthState(...args)
}))

import {
  beginMcpOAuthCallback,
  cancelMcpOAuthCallback,
  createMcpOAuthProvider,
  googleMcpOAuthScope
} from '@main/agent/mcp/oauth'

describe('createMcpOAuthProvider', () => {
  it('exposes the redirect URL verbatim', () => {
    const provider = createMcpOAuthProvider('srv-1', 'http://127.0.0.1:9999/oauth/callback')
    expect(provider.serverId).toBe('srv-1')
    expect(provider.redirectUrl).toBe('http://127.0.0.1:9999/oauth/callback')
  })

  it('builds the expected client metadata', () => {
    const provider = createMcpOAuthProvider('srv-2', 'https://cb.example/oauth/callback')
    expect(provider.clientMetadata).toMatchObject({
      client_name: 'Vyotiq',
      redirect_uris: ['https://cb.example/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    })
  })

  it('clearMcpOAuthState on invalidateCredentials(all)', () => {
    const provider = createMcpOAuthProvider('srv-3', 'http://127.0.0.1/cb')
    provider.invalidateCredentials('all')
    expect(clearMcpOAuthState).toHaveBeenCalledWith('srv-3')
  })

  it('delegates token persistence to the secrets store', () => {
    getMcpOAuthState.mockReturnValue({})
    const provider = createMcpOAuthProvider('srv-4', 'http://127.0.0.1/cb')
    provider.saveTokens({ access_token: 'abc' } as never)
    expect(patchMcpOAuthState).toHaveBeenCalledWith('srv-4', { tokens: { access_token: 'abc' } })
  })

  it('returns static client metadata and skips stored DCR client info', () => {
    getMcpOAuthState.mockReturnValue({
      clientInformation: { client_id: 'dcr-client' }
    })
    const provider = createMcpOAuthProvider('gmail', 'http://127.0.0.1:19847/oauth/callback', {
      staticClient: { client_id: 'static-id', client_secret: 'static-secret' }
    })
    expect(provider.clientInformation()).toEqual({
      client_id: 'static-id',
      client_secret: 'static-secret'
    })
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('client_secret_post')
    expect(provider.clientMetadata.redirect_uris).toEqual(['http://127.0.0.1:19847/oauth/callback'])
  })

  it('keeps DCR public-client metadata when no static client is set', () => {
    getMcpOAuthState.mockReturnValue({ clientInformation: { client_id: 'dcr-client' } })
    const provider = createMcpOAuthProvider('github', 'http://127.0.0.1:9/oauth/callback')
    expect(provider.clientInformation()).toEqual({ client_id: 'dcr-client' })
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('none')
  })

  it('requests Google readonly vs full MCP scopes from googleAccess', () => {
    const cb = 'http://127.0.0.1:19847/oauth/callback'
    const staticClient = { client_id: 'gid', client_secret: 'gsecret' }
    const gmailRead = createMcpOAuthProvider('gmail', cb, {
      staticClient,
      googleAccess: 'read'
    })
    expect(gmailRead.clientMetadata.scope).toBe(googleMcpOAuthScope('gmail', 'read'))
    expect(gmailRead.clientMetadata.scope?.split(' ')).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly'
    ])

    const gmailWrite = createMcpOAuthProvider('gmail', cb, {
      staticClient,
      googleAccess: 'read-write'
    })
    expect(gmailWrite.clientMetadata.scope?.split(' ')).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose'
    ])

    const driveWrite = createMcpOAuthProvider('google-drive', cb, {
      staticClient,
      googleAccess: 'read-write'
    })
    expect(driveWrite.clientMetadata.scope?.split(' ')).toEqual([
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file'
    ])

    const calendarRead = createMcpOAuthProvider('google-calendar', cb, {
      staticClient,
      googleAccess: 'read'
    })
    expect(calendarRead.clientMetadata.scope?.split(' ')).toEqual([
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.events.freebusy',
      'https://www.googleapis.com/auth/calendar.events.readonly'
    ])
    expect(calendarRead.clientMetadata.scope?.split(' ')).not.toContain(
      'https://www.googleapis.com/auth/calendar.events'
    )

    const calendarWrite = createMcpOAuthProvider('google-calendar', cb, {
      staticClient,
      googleAccess: 'read-write'
    })
    expect(calendarWrite.clientMetadata.scope?.split(' ')).toContain(
      'https://www.googleapis.com/auth/calendar.events'
    )

    const implicitWrite = createMcpOAuthProvider('gmail', cb, { staticClient })
    expect(implicitWrite.clientMetadata.scope).toBe(googleMcpOAuthScope('gmail'))
    expect(implicitWrite.clientMetadata.scope).toContain('gmail.compose')

    const github = createMcpOAuthProvider('github', 'http://127.0.0.1:9/oauth/callback')
    expect(github.clientMetadata.scope).toBeUndefined()
    expect(googleMcpOAuthScope('github', 'read')).toBeUndefined()
  })
})

describe('beginMcpOAuthCallback fixed port', () => {
  it('fails clearly when the requested port is already bound', async () => {
    const blocker = createServer()
    const port = await new Promise<number>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(0, '127.0.0.1', () => {
        const addr = blocker.address()
        if (!addr || typeof addr === 'string') {
          reject(new Error('no port'))
          return
        }
        resolve(addr.port)
      })
    })
    try {
      await expect(beginMcpOAuthCallback('busy', { fixedPort: port })).rejects.toThrow(
        mcpOAuthFixedPortBusyMessage(port)
      )
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('binds the requested fixed port', async () => {
    const blocker = createServer()
    const port = await new Promise<number>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(0, '127.0.0.1', () => {
        const addr = blocker.address()
        if (!addr || typeof addr === 'string') {
          reject(new Error('no port'))
          return
        }
        resolve(addr.port)
      })
    })
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
    try {
      const { redirectUrl } = await beginMcpOAuthCallback('fixed', { fixedPort: port })
      expect(redirectUrl).toBe(`http://127.0.0.1:${port}/oauth/callback`)
    } finally {
      cancelMcpOAuthCallback('fixed')
    }
  })
})
