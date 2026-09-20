/**
 * An MCP server nested inside a plugin has to be connectable.
 *
 * The nested expansion used to hand-roll its own manifest mapping and dropped
 * `auth`, `requires`, `inputs` and `setupUrl`, and nothing ever wrote those
 * servers into `settings.mcpServers`. Between them that made a plugin-bundled
 * server impossible to credential: the connect wizard had no client-id step to
 * show, no inputs to collect, and every save failed with "not in settings yet".
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const ISOLATED_USER_DATA = mkdtempSync(join(tmpdir(), 'vyotiq-plugin-mcp-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => ISOLATED_USER_DATA,
    getAppPath: () => process.cwd(),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => undefined }
}))
vi.mock('@main/app/window', () => ({ getMainWindow: () => null }))
vi.mock('@main/workspace/workspaces', () => ({
  readWorkspacesState: () => ({ openPaths: [], activePath: null, workspaces: [] }),
  findWorkspaceSettingsOverride: () => undefined
}))

import { mcpNeedsOAuthClient } from '@shared/mcpApps'
import { writeMarketplaceIndex } from '@main/marketplace/indexStore'
import { syncMarketplaceMcpIntoSettings } from '@main/marketplace/install'
import {
  invalidateMcpResolveCache,
  resolveEffectiveMcpServers
} from '@main/marketplace/resolve'
import { getSettings, setSettings } from '@main/settings/settings'

const PLUGIN_ID = 'authy'
const VERSION = '1.0.0'
/** How `pluginNestedMcpId` composes the settings id. */
const NESTED_ID = 'plugin-authy-gated'

function installPluginFixture(): void {
  const root = join(ISOLATED_USER_DATA, 'marketplace', 'packages', PLUGIN_ID, VERSION)
  const mcpDir = join(root, 'mcp', 'gated')
  mkdirSync(mcpDir, { recursive: true })

  writeFileSync(
    join(root, 'vyotiq.plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'plugin',
      id: PLUGIN_ID,
      name: 'Authy',
      version: VERSION,
      description: 'Plugin bundling an MCP server that needs a registered OAuth app.',
      mcp: ['mcp/gated'],
      skills: [],
      rules: []
    }),
    'utf8'
  )

  writeFileSync(
    join(mcpDir, 'vyotiq.mcp.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'mcp',
      id: 'gated',
      name: 'Gated',
      version: VERSION,
      description: 'Needs an OAuth app the user registers.',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      auth: 'oauth-client',
      setupUrl: 'https://example.com/apps/new',
      inputs: [{ name: 'X_TEAM_ID', label: 'Team ID', target: 'header', isRequired: true }]
    }),
    'utf8'
  )

  writeMarketplaceIndex({
    schemaVersion: 1,
    items: [
      {
        id: PLUGIN_ID,
        kind: 'plugin',
        name: 'Authy',
        version: VERSION,
        description: 'Plugin bundling a gated MCP server.',
        enabled: true,
        // Not `bundled`: that would send the repair pass looking in resources/.
        installSource: 'git',
        installedAt: new Date().toISOString(),
        packagePath: `${PLUGIN_ID}/${VERSION}`
      }
    ]
  })
}

describe('MCP nested inside a plugin', () => {
  beforeEach(async () => {
    installPluginFixture()
    invalidateMcpResolveCache()
    await setSettings({ mcpServers: [] }, { skipMcpAck: true })
    invalidateMcpResolveCache()
  })

  afterAll(() => {
    rmSync(ISOLATED_USER_DATA, { recursive: true, force: true })
  })

  it('carries the connect metadata the wizard needs', () => {
    const server = resolveEffectiveMcpServers().find((s) => s.id === NESTED_ID)
    expect(server).toBeDefined()
    expect(server?.name).toBe('Authy: Gated')
    expect(server?.transport).toBe('http')

    // Each of these was dropped by the old hand-rolled mapping.
    expect(server?.auth).toBe('oauth-client')
    expect(server?.setupUrl).toBe('https://example.com/apps/new')
    expect(server?.inputs?.map((i) => i.name)).toEqual(['X_TEAM_ID'])

    // The wizard reads exactly this to decide whether to ask for a client id.
    expect(mcpNeedsOAuthClient(server ?? {})).toBe(true)
  })

  it('lands in settings so the connect wizard can find and save it', async () => {
    await syncMarketplaceMcpIntoSettings()

    const stored = getSettings().mcpServers.find((s) => s.id === NESTED_ID)
    expect(stored).toBeDefined()
    expect(stored?.source).toBe('marketplace')
    expect(stored?.auth).toBe('oauth-client')
  })

  it('applies the user credentials written back into settings', async () => {
    await syncMarketplaceMcpIntoSettings()
    const stored = getSettings().mcpServers.find((s) => s.id === NESTED_ID)

    // What the wizard writes: a client id plus the declared header input.
    await setSettings({
      mcpServers: getSettings().mcpServers.map((s) =>
        s.id === NESTED_ID
          ? { ...s, oauthClientId: 'client-abc', headers: { X_TEAM_ID: 'T123' } }
          : s
      )
    })
    invalidateMcpResolveCache()

    const resolved = resolveEffectiveMcpServers().find((s) => s.id === NESTED_ID)
    expect(stored).toBeDefined()
    expect(resolved?.oauthClientId).toBe('client-abc')
    // Headers used to be rebuilt from the manifest, discarding the credential.
    expect(resolved?.headers).toEqual({ X_TEAM_ID: 'T123' })
    // The manifest still owns connect metadata, so it survives the overlay.
    expect(resolved?.auth).toBe('oauth-client')
  })

  it('keeps a binary the user located by hand', async () => {
    await syncMarketplaceMcpIntoSettings()
    await setSettings({
      mcpServers: getSettings().mcpServers.map((s) =>
        s.id === NESTED_ID ? { ...s, binaryPath: '/opt/tools/custom-mcp' } : s
      )
    })
    invalidateMcpResolveCache()

    const resolved = resolveEffectiveMcpServers().find((s) => s.id === NESTED_ID)
    // "Locate binary…" wrote this and resolve used to throw it away, so a
    // server whose command is off PATH stayed unlaunchable.
    expect(resolved?.binaryPath).toBe('/opt/tools/custom-mcp')
  })

  it('drops the nested server when the plugin is disabled', () => {
    writeMarketplaceIndex({
      schemaVersion: 1,
      items: [
        {
          id: PLUGIN_ID,
          kind: 'plugin',
          name: 'Authy',
          version: VERSION,
          description: 'Plugin bundling a gated MCP server.',
          enabled: false,
          installSource: 'git',
          installedAt: new Date().toISOString(),
          packagePath: `${PLUGIN_ID}/${VERSION}`
        }
      ]
    })
    invalidateMcpResolveCache()

    expect(resolveEffectiveMcpServers().find((s) => s.id === NESTED_ID)).toBeUndefined()
  })
})
