import { describe, expect, it } from 'vitest'
import type { MarketplaceCatalogEntry, MarketplaceInstalledItem, McpServerStatus } from '@shared/ipc'
import { installedActionLabel, packageActivity } from '@renderer/features/marketplace/packageActivity'

const entry = (partial: Partial<MarketplaceCatalogEntry> & Pick<MarketplaceCatalogEntry, 'id' | 'kind'>): MarketplaceCatalogEntry => ({
  name: partial.name ?? partial.id,
  version: '1.0.0',
  description: '',
  source: 'bundled',
  installable: true,
  ...partial
})

const installed = (partial: Partial<MarketplaceInstalledItem> & Pick<MarketplaceInstalledItem, 'id' | 'enabled'>): MarketplaceInstalledItem => ({
  kind: 'mcp',
  name: partial.id,
  version: '1.0.0',
  description: '',
  installSource: 'bundled',
  installedAt: new Date().toISOString(),
  packagePath: `${partial.id}/1.0.0`,
  ...partial
})

describe('packageActivity', () => {
  it('marks coming soon when installable is false', () => {
    const a = packageActivity(entry({ id: 'x', kind: 'mcp', installable: false }), undefined, undefined)
    expect(a.kind).toBe('coming-soon')
    expect(a.label).toBe('Coming soon')
  })

  it('shows connected for live MCP', () => {
    const status: McpServerStatus = {
      id: 'memory',
      name: 'Memory',
      enabled: true,
      connected: true,
      toolCount: 3
    }
    const a = packageActivity(
      entry({ id: 'memory', kind: 'mcp' }),
      installed({ id: 'memory', enabled: true }),
      status
    )
    expect(a.kind).toBe('connected')
    expect(a.label).toBe('Connected · 3 tools')
    expect(installedActionLabel(a)).toBe('Connected')
  })

  it('surfaces connect error on MCP cards', () => {
    const status: McpServerStatus = {
      id: 'git',
      name: 'Git',
      enabled: true,
      connected: false,
      toolCount: 0,
      error: 'spawn uvx ENOENT'
    }
    const a = packageActivity(
      entry({ id: 'git', kind: 'mcp' }),
      installed({ id: 'git', enabled: true }),
      status
    )
    expect(a.kind).toBe('connect-failed')
    expect(a.label).toContain('Connect failed')
    expect(a.label).toContain('spawn uvx ENOENT')
    expect(a.className).toBe('text-danger')
    expect(installedActionLabel(a)).toBe('Connect failed')
  })

  it('surfaces connect error when all nested plugin MCPs fail', () => {
    const a = packageActivity(
      entry({ id: 'devtools', kind: 'plugin' }),
      installed({ id: 'devtools', kind: 'plugin', enabled: true }),
      undefined,
      {
        nestedMcpStatuses: [
          {
            id: 'a',
            name: 'A',
            enabled: true,
            connected: false,
            toolCount: 0,
            error: 'timeout'
          },
          {
            id: 'b',
            name: 'B',
            enabled: true,
            connected: false,
            toolCount: 0,
            error: 'timeout'
          }
        ]
      }
    )
    expect(a.kind).toBe('connect-failed')
    expect(installedActionLabel(a)).toBe('Connect failed')
  })

  it('shows Disabled when the marketplace package is globally off even if MCP status is connected', () => {
    const a = packageActivity(
      entry({ id: 'memory', kind: 'mcp' }),
      installed({ id: 'memory', enabled: false }),
      {
        id: 'memory',
        name: 'Memory',
        enabled: false,
        connected: true,
        toolCount: 2
      }
    )
    expect(a.kind).toBe('disabled')
    expect(a.label).toBe('Disabled')
  })

  it('shows enabled / disabled for skills', () => {
    expect(
      packageActivity(
        entry({ id: 'docs', kind: 'skill' }),
        installed({ id: 'docs', kind: 'skill', enabled: true }),
        undefined
      ).label
    ).toBe('Enabled')
    expect(
      packageActivity(
        entry({ id: 'docs', kind: 'skill' }),
        installed({ id: 'docs', kind: 'skill', enabled: false }),
        undefined
      ).label
    ).toBe('Disabled')
  })

  it('does not show connected when the MCP is disabled even if a session is leftover', () => {
    const status: McpServerStatus = {
      id: 'memory',
      name: 'Memory',
      enabled: false,
      connected: true,
      toolCount: 4
    }
    const a = packageActivity(
      entry({ id: 'memory', kind: 'mcp' }),
      installed({ id: 'memory', enabled: true }),
      status
    )
    expect(a.kind).toBe('disabled')
    expect(a.label).toBe('Disabled')
    expect(installedActionLabel(a)).toBe('Disabled')
  })

  it('does not show connected for catalog items that are not installed', () => {
    const status: McpServerStatus = {
      id: 'filesystem',
      name: 'Filesystem',
      enabled: true,
      connected: true,
      toolCount: 8
    }
    const a = packageActivity(entry({ id: 'filesystem', kind: 'mcp' }), undefined, status)
    expect(a.kind).toBe('available')
    expect(a.label).toBe('MCP')
    expect(installedActionLabel(a)).toBe('Installed')
  })

  it('shows Not connected for an enabled MCP with no live session', () => {
    const status: McpServerStatus = {
      id: 'git',
      name: 'Git',
      enabled: true,
      connected: false,
      toolCount: 0
    }
    const a = packageActivity(
      entry({ id: 'git', kind: 'mcp' }),
      installed({ id: 'git', enabled: true }),
      status
    )
    expect(a.kind).toBe('not-connected')
    expect(a.label).toBe('Not connected')
    expect(installedActionLabel(a)).toBe('Not connected')
  })

  it('shows Force off here when workspace disables an installed package', () => {
    const a = packageActivity(
      entry({ id: 'memory', kind: 'mcp' }),
      installed({ id: 'memory', enabled: true }),
      {
        id: 'memory',
        name: 'Memory',
        enabled: false,
        connected: true,
        toolCount: 2
      },
      { workspaceEnabled: false }
    )
    expect(a.kind).toBe('disabled')
    expect(a.label).toBe('Force off here · connected globally · 2 tools')
    expect(installedActionLabel(a)).toBe('Force off')
  })

  it('aggregates nested MCP status for plugins', () => {
    const a = packageActivity(
      entry({ id: 'devtools', kind: 'plugin' }),
      installed({ id: 'devtools', kind: 'plugin', enabled: true }),
      undefined,
      {
        nestedMcpStatuses: [
          { id: 'a', name: 'A', enabled: true, connected: true, toolCount: 2 },
          { id: 'b', name: 'B', enabled: true, connected: true, toolCount: 1 }
        ]
      }
    )
    expect(a.kind).toBe('connected')
    expect(a.label).toBe('Connected · 3 tools')
  })
})

/**
 * Every installed package used to render the same permanently disabled chip.
 * A GitHub server waiting for a sign-in and a DeepWiki server that had timed
 * out looked the same and behaved the same: red text, dead button, no way
 * forward without going to Manage and expanding Advanced.
 */
describe('the control an installed package offers', () => {
  const mcp = (status: Partial<McpServerStatus>, auth?: MarketplaceCatalogEntry['auth']) =>
    packageActivity(
      entry({ id: 'srv', kind: 'mcp', ...(auth ? { auth } : {}) }),
      installed({ id: 'srv', enabled: true }),
      { id: 'srv', name: 'Srv', enabled: true, connected: false, toolCount: 0, ...status }
    )

  it('asks for a sign-in instead of reporting a failure', () => {
    const a = mcp({ error: 'Sign in required', errorKind: 'sign-in' }, 'oauth-client')
    expect(a.kind).toBe('needs-auth')
    expect(a.label).toBe('Sign in to connect')
    expect(a.action).toEqual({ kind: 'sign-in', label: 'Sign in' })
    // Needing a credential is the expected first state, not an error.
    expect(a.className).toBeUndefined()
  })

  it('asks for a sign-in before the first connect has even been tried', () => {
    // Freshly installed: no session, no error yet, no stored credential.
    const a = mcp({}, 'oauth')
    expect(a.kind).toBe('needs-auth')
    expect(a.action?.kind).toBe('sign-in')
  })

  it('stops asking once a credential is stored', () => {
    const a = mcp({ hasAuthToken: true }, 'oauth')
    expect(a.kind).not.toBe('needs-auth')
  })

  it('offers a retry for a network failure', () => {
    const a = mcp({
      error: 'Timed out reaching mcp.deepwiki.com — check your network or proxy, then retry.',
      errorKind: 'network'
    })
    expect(a.kind).toBe('connect-failed')
    expect(a.action).toEqual({ kind: 'retry', label: 'Retry' })
    expect(a.className).toBe('text-danger')
  })

  it('offers no retry for a failure a retry cannot fix', () => {
    // Retrying cannot install uvx. The card says what is wrong and the fix
    // lives where the Install / Locate controls are.
    const a = mcp({ error: 'uvx was not found on PATH', errorKind: 'binary' })
    expect(a.kind).toBe('connect-failed')
    expect(a.action).toBeUndefined()
  })

  it('offers a retry to an enabled server that simply has no session', () => {
    const a = mcp({})
    expect(a.kind).toBe('not-connected')
    expect(a.action?.kind).toBe('retry')
  })

  it('says it is dialling rather than offering to dial again', () => {
    // During the first seconds of a launch every enabled server is
    // not-connected with no error yet. A Retry here would restart the attempt
    // that is already running.
    const a = mcp({ connecting: true })
    expect(a.label).toBe('Connecting…')
    expect(a.action).toBeUndefined()
    expect(a.className).toBe('text-secondary')
  })

  it('offers nothing once the server is connected or switched off', () => {
    expect(mcp({ connected: true, toolCount: 2 }).action).toBeUndefined()
    expect(mcp({ enabled: false }).action).toBeUndefined()
  })

  it('carries a nested plugin MCP sign-in up to the package card', () => {
    const a = packageActivity(
      entry({ id: 'devtools', kind: 'plugin' }),
      installed({ id: 'devtools', kind: 'plugin', enabled: true }),
      undefined,
      {
        nestedMcpStatuses: [
          {
            id: 'a',
            name: 'A',
            enabled: true,
            connected: false,
            toolCount: 0,
            error: 'Sign in required',
            errorKind: 'sign-in'
          }
        ]
      }
    )
    expect(a.kind).toBe('needs-auth')
    expect(a.action?.kind).toBe('sign-in')
  })
})

