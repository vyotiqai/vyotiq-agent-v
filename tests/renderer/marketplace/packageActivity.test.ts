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

