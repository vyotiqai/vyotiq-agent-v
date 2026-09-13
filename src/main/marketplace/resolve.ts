import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type {
  MarketplaceOverrides,
  McpServer,
  MarketplaceInstalledItem
} from '../../shared/ipc'
import { VyotiqMcpManifestSchema, VyotiqPluginManifestSchema } from '../../shared/ipc'
import { effectiveMarketplaceEnabled } from '../../shared/domain/marketplaceEnablement'
import { formatError } from '../../shared/errors'
import { logger } from '../../shared/logger'
import { getSettings } from '../settings/settings'
import { findWorkspaceSettingsOverride, readWorkspacesState } from '../workspace/workspaces'
import { readMarketplaceIndex } from './indexStore'
import { resolveInstalledPackageRoot } from './paths'
import { resolveInsidePackageRoot } from './safePath'
import { mcpServerFromManifest } from './install'
import { sanitizeMcpManifestEnv } from './sanitizeMcpEnv'

function packageRoot(item: MarketplaceInstalledItem): string {
  return resolveInstalledPackageRoot(item.packagePath)
}

type ResolveCacheEntry = {
  fingerprint: string
  servers: McpServer[]
}

let effectiveCache: ResolveCacheEntry | null = null
let sessionMapCache: ResolveCacheEntry | null = null

function overridesFingerprint(overrides?: MarketplaceOverrides | null): string {
  if (!overrides) return ''
  return JSON.stringify(overrides)
}

function marketplaceIndexFingerprint(): string {
  const index = readMarketplaceIndex()
  return index.items.map((i) => `${i.id}:${i.version}:${i.enabled}:${i.kind}`).join('|')
}

function settingsMcpFingerprint(): string {
  const settings = getSettings()
  return (settings.mcpServers ?? [])
    .map((s) => {
      const envFp = Object.entries(s.env ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
      const headerFp = Object.entries(s.headers ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
      const allowed = (s.allowedTools ?? []).join(',')
      const denied = (s.deniedTools ?? []).join(',')
      return [
        s.id,
        s.enabled,
        s.source ?? '',
        s.transport ?? '',
        s.command ?? '',
        (s.args ?? []).join(','),
        s.url ?? '',
        envFp,
        headerFp,
        allowed,
        denied,
        s.oauthClientId ?? '',
        s.authScope ?? '',
        s.authWorkspacePath ?? '',
        s.googleAccess ?? ''
      ].join(':')
    })
    .join('|')
}

/** Invalidate MCP resolve caches after marketplace/settings mutations. */
export function invalidateMcpResolveCache(): void {
  effectiveCache = null
  sessionMapCache = null
}

/**
 * Cheap fingerprint for skipping redundant per-step MCP sync when nothing
 * about settings / marketplace / open workspaces changed.
 */
export function mcpSessionMapFingerprint(): string {
  const state = readWorkspacesState()
  const openPaths = state.openPaths ?? []
  const overrideFp = openPaths
    .map((path) => {
      const override = findWorkspaceSettingsOverride(state, path)
      return `${path}:${overridesFingerprint(override?.marketplaceOverrides ?? null)}`
    })
    .join('|')
  return [
    settingsMcpFingerprint(),
    marketplaceIndexFingerprint(),
    openPaths.join(','),
    overrideFp
  ].join('::')
}

/** @internal */
export function clearMcpResolveCacheForTests(): void {
  invalidateMcpResolveCache()
}

/**
 * Build the MCP server list: manual settings entries + marketplace MCP packages +
 * MCP nested in enabled plugins. When `marketplaceOverrides` is set, it applies
 * to marketplace-sourced servers (standalone + plugin-nested) and to manual
 * entries (Marketplace is the sole MCP management UI).
 *
 * Per-run tool filtering should call this with that workspace's overrides.
 * Global session connect/disconnect should use `resolveMcpServersForSessionMap`
 * so Force-off disconnects only when no workspace still needs the server.
 */
export function resolveEffectiveMcpServers(
  marketplaceOverrides?: MarketplaceOverrides | null
): McpServer[] {
  const fingerprint = [
    settingsMcpFingerprint(),
    marketplaceIndexFingerprint(),
    overridesFingerprint(marketplaceOverrides)
  ].join('::')
  if (effectiveCache?.fingerprint === fingerprint) {
    return effectiveCache.servers.map((s) => ({ ...s }))
  }

  const settings = getSettings()
  const index = readMarketplaceIndex()
  const byId = new Map<string, McpServer>()

  // Manual (non-marketplace) entries — still honor per-server workspace mcp overrides
  // now that Marketplace is the sole MCP UI.
  for (const server of settings.mcpServers ?? []) {
    if (server.source === 'marketplace') continue
    const enabled = effectiveMarketplaceEnabled(
      server.id,
      server.enabled,
      marketplaceOverrides,
      'mcp'
    )
    byId.set(server.id, { ...server, enabled })
  }

  // Standalone marketplace MCP packages (overwrite same id as manual — install
  // must reject that collision; see installMarketplacePackage)
  for (const item of index.items) {
    if (item.kind !== 'mcp') continue
    const root = packageRoot(item)
    if (!existsSync(join(root, 'vyotiq.mcp.json'))) continue
    try {
      const server = mcpServerFromManifest(root)
      if (byId.has(server.id) && byId.get(server.id)?.source !== 'marketplace') {
        // Keep the manual entry; marketplace package is shadowed until uninstall
        continue
      }
      const enabled = effectiveMarketplaceEnabled(
        item.id,
        item.enabled,
        marketplaceOverrides,
        'mcp'
      )
      const settingsOverlay = (settings.mcpServers ?? []).find(
        (s) => s.id === server.id && s.source === 'marketplace'
      )
      byId.set(server.id, {
        ...server,
        enabled,
        ...(settingsOverlay
          ? {
              ...(settingsOverlay.transport ? { transport: settingsOverlay.transport } : {}),
              ...(settingsOverlay.command !== undefined
                ? { command: settingsOverlay.command }
                : {}),
              ...(settingsOverlay.args ? { args: settingsOverlay.args } : {}),
              ...(settingsOverlay.env
                ? { env: sanitizeMcpManifestEnv(settingsOverlay.env) }
                : {}),
              ...(settingsOverlay.url !== undefined ? { url: settingsOverlay.url } : {}),
              ...(settingsOverlay.headers ? { headers: settingsOverlay.headers } : {}),
              ...(settingsOverlay.allowedTools?.length
                ? { allowedTools: settingsOverlay.allowedTools }
                : {}),
              ...(settingsOverlay.deniedTools?.length
                ? { deniedTools: settingsOverlay.deniedTools }
                : {}),
              ...(settingsOverlay.oauthClientId
                ? { oauthClientId: settingsOverlay.oauthClientId }
                : {}),
              ...(settingsOverlay.authScope ? { authScope: settingsOverlay.authScope } : {}),
              ...(settingsOverlay.authWorkspacePath
                ? { authWorkspacePath: settingsOverlay.authWorkspacePath }
                : {}),
              ...(settingsOverlay.googleAccess
                ? { googleAccess: settingsOverlay.googleAccess }
                : {})
            }
          : {})
      })
    } catch (err) {
      logger.warn('Skipping invalid marketplace MCP package', {
        scope: 'marketplace',
        packageId: item.id,
        err: formatError(err)
      })
    }
  }

  // Plugin-bundled MCP (plugin enable + optional per-nested mcp override)
  for (const item of index.items) {
    if (item.kind !== 'plugin') continue
    const pluginEnabled = effectiveMarketplaceEnabled(
      item.id,
      item.enabled,
      marketplaceOverrides,
      'plugins'
    )
    if (!pluginEnabled) continue
    const root = packageRoot(item)
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
        const mcpManifestPath = join(mcpRoot, 'vyotiq.mcp.json')
        if (!existsSync(mcpManifestPath)) continue
        const nested = VyotiqMcpManifestSchema.parse(
          JSON.parse(readFileSync(mcpManifestPath, 'utf8'))
        )
        const id = `plugin-${plugin.id}-${nested.id}`.replace(/__/g, '-')
        if (id.includes('__')) continue
        const enabled = effectiveMarketplaceEnabled(id, true, marketplaceOverrides, 'mcp')
        const settingsOverlay = (settings.mcpServers ?? []).find((s) => s.id === id)
        byId.set(id, {
          id,
          name: `${plugin.name}: ${nested.name}`,
          transport: nested.transport,
          command: nested.command,
          args: nested.args,
          env: sanitizeMcpManifestEnv(nested.env),
          url: nested.url,
          headers: nested.headers,
          ...(nested.allowedTools?.length ? { allowedTools: nested.allowedTools } : {}),
          ...(nested.deniedTools?.length ? { deniedTools: nested.deniedTools } : {}),
          ...(settingsOverlay?.allowedTools?.length
            ? { allowedTools: settingsOverlay.allowedTools }
            : {}),
          ...(settingsOverlay?.deniedTools?.length
            ? { deniedTools: settingsOverlay.deniedTools }
            : {}),
          ...(settingsOverlay?.oauthClientId
            ? { oauthClientId: settingsOverlay.oauthClientId }
            : {}),
          ...(settingsOverlay?.authScope ? { authScope: settingsOverlay.authScope } : {}),
          ...(settingsOverlay?.authWorkspacePath
            ? { authWorkspacePath: settingsOverlay.authWorkspacePath }
            : {}),
          ...(settingsOverlay?.googleAccess
            ? { googleAccess: settingsOverlay.googleAccess }
            : {}),
          enabled,
          source: 'marketplace',
          packageId: item.id,
          packageVersion: item.version
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

  const servers = [...byId.values()]
  effectiveCache = { fingerprint, servers }
  return servers.map((s) => ({ ...s }))
}

/**
 * MCP servers that should stay connected in the global session map: any server
 * enabled for at least one open workspace (honoring Force on/off), or globally
 * when no workspaces are registered.
 */
export function resolveMcpServersForSessionMap(): McpServer[] {
  const fingerprint = mcpSessionMapFingerprint()
  if (sessionMapCache?.fingerprint === fingerprint) {
    return sessionMapCache.servers.map((s) => ({ ...s }))
  }

  const state = readWorkspacesState()
  const openPaths = state.openPaths ?? []

  if (openPaths.length === 0) {
    const servers = resolveEffectiveMcpServers().filter((s) => s.enabled)
    sessionMapCache = { fingerprint, servers }
    return servers.map((s) => ({ ...s }))
  }

  const byId = new Map<string, McpServer>()
  for (const path of openPaths) {
    const override = findWorkspaceSettingsOverride(state, path)
    const marketplaceOverrides = override?.marketplaceOverrides ?? null
    for (const server of resolveEffectiveMcpServers(marketplaceOverrides)) {
      if (!server.enabled) continue
      byId.set(server.id, { ...server, enabled: true })
    }
  }
  const servers = [...byId.values()]
  sessionMapCache = { fingerprint, servers }
  return servers.map((s) => ({ ...s }))
}

/** Standalone skill packages that are effectively enabled (not plugin containers). */
export function listEffectivelyEnabledSkills(
  marketplaceOverrides?: MarketplaceOverrides | null
): MarketplaceInstalledItem[] {
  const index = readMarketplaceIndex()
  const out: MarketplaceInstalledItem[] = []
  for (const item of index.items) {
    if (item.kind !== 'skill') continue
    if (effectiveMarketplaceEnabled(item.id, item.enabled, marketplaceOverrides, 'skills')) {
      out.push(item)
    }
  }
  return out
}
