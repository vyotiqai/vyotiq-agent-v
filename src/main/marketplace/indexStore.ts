import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { atomicWriteJson } from '../storage/atomicWrite'
import {
  MarketplaceIndexSchema,
  VyotiqMcpManifestSchema,
  VyotiqPluginManifestSchema,
  type MarketplaceIndex,
  type MarketplaceInstalledItem
} from '../../shared/ipc'
import { clearMcpAuthToken, clearMcpOAuthState, clearMcpOAuthClientSecret, clearMcpServerSecrets } from '../settings/secrets'
import { notifySkillsChanged } from '../agent/skills/notify'
import { marketplaceIndexPath, marketplacePackageDir, marketplaceRoot, resolveInstalledPackageRoot } from './paths'
import { resolveInsidePackageRoot } from './safePath'
import { logger } from '../../shared/logger'

const EMPTY_INDEX: MarketplaceIndex = { schemaVersion: 1, items: [] }

let marketplaceIndexCache: MarketplaceIndex | null = null

export function readMarketplaceIndex(): MarketplaceIndex {
  if (marketplaceIndexCache) {
    return { schemaVersion: marketplaceIndexCache.schemaVersion, items: [...marketplaceIndexCache.items] }
  }
  const path = marketplaceIndexPath()
  if (!existsSync(path)) return { ...EMPTY_INDEX, items: [] }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    marketplaceIndexCache = MarketplaceIndexSchema.parse(raw)
    return { schemaVersion: marketplaceIndexCache.schemaVersion, items: [...marketplaceIndexCache.items] }
  } catch (err) {
    logger.warn('Marketplace index unreadable; backing up corrupt file', {
      scope: 'marketplace',
      err
    })
    try {
      renameSync(path, `${path}.bak`)
    } catch {
      // best-effort — corrupt file stays in place if the rename fails
    }
    if (marketplaceIndexCache) {
      return { schemaVersion: marketplaceIndexCache.schemaVersion, items: [...marketplaceIndexCache.items] }
    }
    return { ...EMPTY_INDEX, items: [] }
  }
}

export function writeMarketplaceIndex(index: MarketplaceIndex): void {
  mkdirSync(dirname(marketplaceIndexPath()), { recursive: true })
  mkdirSync(marketplaceRoot(), { recursive: true })
  const parsed = MarketplaceIndexSchema.parse(index)
  atomicWriteJson(marketplaceIndexPath(), parsed)
  marketplaceIndexCache = parsed
}

export function upsertInstalledItem(item: MarketplaceInstalledItem): MarketplaceIndex {
  const index = readMarketplaceIndex()
  const prior = index.items.find((i) => i.id === item.id)
  const nextItems = index.items.filter((i) => i.id !== item.id)
  nextItems.push(item)
  const next = { schemaVersion: 1 as const, items: nextItems }
  writeMarketplaceIndex(next)
  if (prior && prior.version !== item.version) {
    const oldDir = marketplacePackageDir(prior.id, prior.version)
    if (existsSync(oldDir)) {
      try {
        rmSync(oldDir, { recursive: true, force: true })
      } catch (err) {
        logger.warn('Failed to remove prior marketplace package version', {
          scope: 'marketplace',
          id: prior.id,
          version: prior.version,
          err
        })
      }
    }
  }
  notifySkillsChanged()
  return next
}

export function setInstalledEnabled(id: string, enabled: boolean): MarketplaceIndex {
  const index = readMarketplaceIndex()
  const items = index.items.map((i) => (i.id === id ? { ...i, enabled } : i))
  const next = { schemaVersion: 1 as const, items }
  writeMarketplaceIndex(next)
  notifySkillsChanged()
  return next
}

/** Clear Bearer + OAuth + env/header secrets for an MCP server id (best-effort). */
function clearMcpSecrets(serverId: string): void {
  try {
    clearMcpAuthToken(serverId)
    clearMcpOAuthState(serverId)
    clearMcpOAuthClientSecret(serverId)
    clearMcpServerSecrets(serverId)
  } catch {
    // ignore
  }
}

/**
 * Nested plugin MCP ids match resolve.ts: `plugin-{pluginId}-{nestedId}`.
 * Must run before the package directory is removed.
 * Exported for unit tests (path containment).
 */
export function clearNestedPluginMcpSecrets(item: MarketplaceInstalledItem): void {
  if (item.kind !== 'plugin') return
  const root = marketplacePackageDir(item.id, item.version)
  const manifestPath = join(root, 'vyotiq.plugin.json')
  if (!existsSync(manifestPath)) return
  try {
    const plugin = VyotiqPluginManifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, 'utf8'))
    )
    for (const rel of plugin.mcp) {
      let mcpRoot: string
      try {
        mcpRoot = resolveInsidePackageRoot(root, rel)
      } catch (err) {
        logger.warn('Skipping nested MCP secret cleanup outside package root', {
          scope: 'marketplace',
          id: item.id,
          rel,
          err
        })
        continue
      }
      const mcpManifestPath = join(mcpRoot, 'vyotiq.mcp.json')
      if (!existsSync(mcpManifestPath)) continue
      try {
        const nested = VyotiqMcpManifestSchema.parse(
          JSON.parse(readFileSync(mcpManifestPath, 'utf8'))
        )
        const nestedId = `plugin-${plugin.id}-${nested.id}`.replace(/__/g, '-')
        clearMcpSecrets(nestedId)
      } catch {
        // skip invalid nested manifest
      }
    }
  } catch {
    // skip invalid plugin manifest
  }
}

export function removeInstalledItem(id: string): MarketplaceIndex {
  const index = readMarketplaceIndex()
  const item = index.items.find((i) => i.id === id)
  const next = {
    schemaVersion: 1 as const,
    items: index.items.filter((i) => i.id !== id)
  }
  writeMarketplaceIndex(next)
  if (item) {
    clearNestedPluginMcpSecrets(item)
    clearMcpSecrets(item.id)
    let dir: string | null = null
    try {
      dir = resolveInstalledPackageRoot(item.packagePath)
    } catch (err) {
      logger.warn('Marketplace uninstall: invalid packagePath; falling back to id/version', {
        scope: 'marketplace',
        correlationId: id,
        err
      })
      try {
        dir = marketplacePackageDir(item.id, item.version)
      } catch {
        dir = null
      }
    }
    if (dir && existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }
  }
  notifySkillsChanged()
  return next
}

export function getInstalledItem(id: string): MarketplaceInstalledItem | undefined {
  return readMarketplaceIndex().items.find((i) => i.id === id)
}
