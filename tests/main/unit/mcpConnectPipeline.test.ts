import { describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getAppPath: () => process.cwd(),
    isPackaged: false
  }
}))

import { mcpServerFromManifest } from '@main/marketplace/install'
import { findMissingMcpBinary, resolveMcpBinary } from '@main/agent/mcp/binaries'
import { mcpRequiresOAuth, mcpSupportsOAuth, mcpUsesTokenAuth } from '@shared/mcpApps'

const PACKAGES = join(process.cwd(), 'resources/marketplace/packages')

/** The real bundled manifest, through the same reader the installer uses. */
function bundledServer(id: string) {
  return mcpServerFromManifest(join(PACKAGES, id))
}

/**
 * End-to-end over the real bundled packages: manifest on disk → the McpServer
 * that lands in settings → the predicates the UI and connect path branch on.
 * A schema unit test alone would not catch a field dropped in
 * `mcpServerFromManifest`.
 */
describe('bundled package → connect decision', () => {
  it('carries a public server through as connect-on-install', () => {
    const server = bundledServer('context7')
    expect(server.url).toBe('https://mcp.context7.com/mcp')
    expect(server.transport).toBe('http')
    expect(server.auth).toBe('none')
    expect(server.enabled).toBe(true)
    expect(server.source).toBe('marketplace')

    // Nothing to sign into, so no Connect button and no pre-connect block.
    expect(mcpSupportsOAuth(server)).toBe(false)
    expect(mcpRequiresOAuth(server)).toBe(false)
    expect(findMissingMcpBinary(server)).toBeNull()
  })

  it('carries a DCR server through as one-click sign-in', () => {
    const server = bundledServer('linear')
    expect(server.url).toBe('https://mcp.linear.app/mcp')
    expect(server.auth).toBe('oauth')
    // No client id is stored: Linear advertises dynamic client registration.
    expect(server.oauthClientId).toBeUndefined()
    expect(mcpSupportsOAuth(server)).toBe(true)
    expect(mcpRequiresOAuth(server)).toBe(true)
  })

  it('carries a non-DCR server through as needing a registered app', () => {
    const server = bundledServer('slack')
    expect(server.auth).toBe('oauth-client')
    // The wizard cannot ask the user to register an app without telling them where.
    expect(server.setupUrl).toBe('https://api.slack.com/apps')
    expect(mcpSupportsOAuth(server)).toBe(true)
    expect(mcpRequiresOAuth(server)).toBe(true)
    expect(mcpUsesTokenAuth(server)).toBe(false)
  })

  it('carries an sse server through with its transport intact', () => {
    const server = bundledServer('asana')
    expect(server.transport).toBe('sse')
    expect(server.auth).toBe('oauth')
    expect(mcpSupportsOAuth(server)).toBe(true)
  })

  it('carries runtime requirements onto stdio servers', () => {
    for (const id of ['playwright', 'chrome-devtools']) {
      const server = bundledServer(id)
      expect(server.transport).toBe('stdio')
      expect(server.command).toBe('npx')
      expect(server.requires).toContain('node')
      // stdio never offers OAuth — startMcpOAuth refuses it.
      expect(mcpSupportsOAuth(server)).toBe(false)
    }
  })

  it('preflights the real bundled stdio servers against this machine', () => {
    // npx ships with Node, so the Node-backed servers must pass here. If this
    // fails, the resolver is broken rather than the environment.
    expect(resolveMcpBinary('npx')).toBeTruthy()
    expect(findMissingMcpBinary(bundledServer('filesystem'))).toBeNull()

    // uv may or may not be installed. Either outcome is correct — what matters
    // is that a missing one is reported as a named, fixable requirement rather
    // than surfacing later as a raw spawn ENOENT.
    const git = bundledServer('git')
    const missing = findMissingMcpBinary(git)
    if (missing) {
      expect(['uvx', 'git']).toContain(missing.binary)
      expect(missing.requirement).toBeTruthy()
      expect(missing.installUrl).toMatch(/^https:\/\//)
    }
  })

  it('leaves every hosted Google server on the OAuth path', () => {
    for (const id of ['gmail', 'google-drive', 'google-calendar']) {
      const server = bundledServer(id)
      expect(server.auth).toBe('oauth')
      expect(mcpRequiresOAuth(server)).toBe(true)
    }
  })
})
