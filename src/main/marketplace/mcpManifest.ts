/**
 * One place that turns a `vyotiq.mcp.json` into an `McpServer`, for both
 * standalone MCP packages and the ones nested inside plugins.
 *
 * The nested path used to hand-roll its own mapping, and it quietly dropped
 * everything the connect flow depends on — `auth`, `requires`, `inputs`,
 * `setupUrl` — so a plugin-bundled server could never be credentialed: the
 * wizard had no client-id step to show and no inputs to collect. Sharing the
 * reader is what keeps the two paths from drifting apart again.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { MarketplaceInstalledItem, McpServer } from '../../shared/ipc'
import { VyotiqMcpManifestSchema, VyotiqPluginManifestSchema } from '../../shared/ipc'
import { formatError } from '../../shared/errors'
import { logger } from '../../shared/logger'
import { readMarketplaceIndex } from './indexStore'
import { resolveInstalledPackageRoot } from './paths'
import { resolveInsidePackageRoot } from './safePath'
import { sanitizeMcpManifestEnv } from './sanitizeMcpEnv'

export function mcpServerFromManifest(root: string): McpServer {
  const manifest = VyotiqMcpManifestSchema.parse(
    JSON.parse(readFileSync(join(root, 'vyotiq.mcp.json'), 'utf8'))
  )
  return {
    id: manifest.id,
    name: manifest.name,
    transport: manifest.transport,
    command: manifest.command,
    args: manifest.args,
    env: sanitizeMcpManifestEnv(manifest.env),
    url: manifest.url,
    headers: manifest.headers,
    ...(manifest.allowedTools?.length ? { allowedTools: manifest.allowedTools } : {}),
    ...(manifest.deniedTools?.length ? { deniedTools: manifest.deniedTools } : {}),
    auth: manifest.auth,
    ...(manifest.requires?.length ? { requires: manifest.requires } : {}),
    ...(manifest.inputs?.length ? { inputs: manifest.inputs } : {}),
    ...(manifest.setupUrl ? { setupUrl: manifest.setupUrl } : {}),
    enabled: true,
    source: 'marketplace',
    packageId: manifest.id,
    packageVersion: manifest.version
  }
}

/**
 * Settings id for an MCP server nested in a plugin.
 *
 * `__` is the MCP tool-name separator, so an id carrying one would produce a
 * tool name that cannot be parsed back apart.
 */
export function pluginNestedMcpId(pluginId: string, nestedId: string): string | null {
  const id = `plugin-${pluginId}-${nestedId}`.replace(/__/g, '-')
  return id.includes('__') ? null : id
}

export type PluginNestedMcp = {
  /** The installed plugin that owns this server (for enablement and version). */
  item: MarketplaceInstalledItem
  server: McpServer
}

/**
 * Every MCP server nested inside an installed plugin, read through the same
 * manifest reader standalone packages use. Enablement, workspace overrides and
 * settings overlays are the caller's job.
 */
export function listPluginNestedMcpServers(): PluginNestedMcp[] {
  const index = readMarketplaceIndex()
  const out: PluginNestedMcp[] = []
  for (const item of index.items) {
    if (item.kind !== 'plugin') continue
    const root = resolveInstalledPackageRoot(item.packagePath)
    const manifestPath = join(root, 'vyotiq.plugin.json')
    if (!existsSync(manifestPath)) continue
    try {
      const plugin = VyotiqPluginManifestSchema.parse(
        JSON.parse(readFileSync(manifestPath, 'utf8'))
      )
      for (const rel of plugin.mcp) {
        let mcpRoot: string
        try {
          mcpRoot = resolveInsidePackageRoot(root, rel)
        } catch {
          continue
        }
        if (!existsSync(join(mcpRoot, 'vyotiq.mcp.json'))) continue
        const nested = mcpServerFromManifest(mcpRoot)
        const id = pluginNestedMcpId(plugin.id, nested.id)
        if (!id) continue
        out.push({
          item,
          server: {
            ...nested,
            id,
            name: `${plugin.name}: ${nested.name}`,
            packageId: item.id,
            packageVersion: item.version
          }
        })
      }
    } catch (err) {
      logger.warn('Skipping invalid marketplace plugin MCP', {
        scope: 'marketplace',
        packageId: item.id,
        err: formatError(err)
      })
    }
  }
  return out
}

/**
 * Connection fields the user may edit, layered over the manifest defaults.
 *
 * `auth` / `requires` / `inputs` / `setupUrl` are deliberately absent: the
 * manifest owns them, so an app update can correct a package's connect
 * metadata. Everything here is the user's own choice and must survive.
 */
export function applyMcpSettingsOverlay(
  base: McpServer,
  overlay: McpServer | undefined
): McpServer {
  if (!overlay) return base
  return {
    ...base,
    ...(overlay.transport ? { transport: overlay.transport } : {}),
    ...(overlay.command !== undefined ? { command: overlay.command } : {}),
    ...(overlay.args ? { args: overlay.args } : {}),
    ...(overlay.env ? { env: sanitizeMcpManifestEnv(overlay.env) } : {}),
    ...(overlay.url !== undefined ? { url: overlay.url } : {}),
    ...(overlay.headers ? { headers: overlay.headers } : {}),
    ...(overlay.allowedTools?.length ? { allowedTools: overlay.allowedTools } : {}),
    ...(overlay.deniedTools?.length ? { deniedTools: overlay.deniedTools } : {}),
    ...(overlay.oauthClientId ? { oauthClientId: overlay.oauthClientId } : {}),
    ...(overlay.authScope ? { authScope: overlay.authScope } : {}),
    ...(overlay.authWorkspacePath ? { authWorkspacePath: overlay.authWorkspacePath } : {}),
    ...(overlay.googleAccess ? { googleAccess: overlay.googleAccess } : {}),
    // Without this the "Locate binary…" path wrote a value that resolve then
    // threw away, so a server whose command is off PATH stayed unlaunchable.
    ...(overlay.binaryPath ? { binaryPath: overlay.binaryPath } : {})
  }
}
