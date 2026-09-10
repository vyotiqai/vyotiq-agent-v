import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import {
  MarketplaceCatalogSchema,
  type MarketplaceCatalog,
  type MarketplaceCatalogEntry,
  type MarketplaceKind
} from '../../shared/ipc'
import { enrichCatalogEntryIcons } from './catalogIcons'
import { getSettings } from '../settings/settings'
import { bundledCatalogPath, marketplaceCatalogCachePath } from './paths'
import { logger } from '../../shared/logger'
import { formatError } from '../../shared/errors'

function readJsonCatalog(path: string): MarketplaceCatalog {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  return MarketplaceCatalogSchema.parse(raw)
}

export function loadBundledCatalog(): MarketplaceCatalog {
  const path = bundledCatalogPath()
  if (!existsSync(path)) return { schemaVersion: 1, packages: [] }
  try {
    return readJsonCatalog(path)
  } catch (err) {
    logger.warn('Failed to load bundled marketplace catalog', { scope: 'marketplace', err })
    return { schemaVersion: 1, packages: [] }
  }
}

export function loadCachedRemoteCatalog(): MarketplaceCatalog {
  const path = marketplaceCatalogCachePath()
  if (!existsSync(path)) return { schemaVersion: 1, packages: [] }
  try {
    return readJsonCatalog(path)
  } catch {
    return { schemaVersion: 1, packages: [] }
  }
}

function writeCachedRemoteCatalog(catalog: MarketplaceCatalog): void {
  const path = marketplaceCatalogCachePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(catalog, null, 2), 'utf8')
}

import { fetchPublicResponse } from '../agent/tools/webFetch'

/** Fetch remote catalog when registryUrl is set; cache on success. */
export async function refreshRemoteCatalog(): Promise<MarketplaceCatalog> {
  const registryUrl = (getSettings().marketplace?.registryUrl ?? '').trim().replace(/\/$/, '')
  if (!registryUrl) {
    return { schemaVersion: 1, packages: [] }
  }
  const url = `${registryUrl}/v1/catalog`
  try {
    // Network registries must be https; plain http is refused here and falls
    // through to the cached catalog below (same as any fetch failure).
    if (new URL(url).protocol !== 'https:') {
      throw new Error('Marketplace registry URL must use https: (plain http is not allowed)')
    }
    const { response, body } = await fetchPublicResponse(
      new URL(url),
      AbortSignal.timeout(15_000),
      { accept: 'application/json' }
    )
    if (!response.ok) throw new Error(`Catalog fetch failed: HTTP ${response.status}`)
    const raw = JSON.parse(body.toString('utf8')) as unknown
    const catalog = MarketplaceCatalogSchema.parse(raw)
    const withSource: MarketplaceCatalog = {
      schemaVersion: 1,
      packages: catalog.packages.map((p) => ({ ...p, source: 'remote' as const }))
    }
    writeCachedRemoteCatalog(withSource)
    return withSource
  } catch (err) {
    logger.warn('Marketplace remote catalog refresh failed', {
      scope: 'marketplace',
      err: formatError(err)
    })
    return loadCachedRemoteCatalog()
  }
}

export function mergeCatalogs(
  bundled: MarketplaceCatalog,
  remote: MarketplaceCatalog
): MarketplaceCatalogEntry[] {
  const byId = new Map<string, MarketplaceCatalogEntry>()
  for (const p of bundled.packages) {
    byId.set(p.id, { ...p, source: 'bundled' })
  }
  for (const p of remote.packages) {
    if (!byId.has(p.id)) byId.set(p.id, { ...p, source: 'remote' })
  }
  return [...byId.values()]
}

export async function browseCatalog(opts?: {
  kind?: MarketplaceKind
  q?: string
}): Promise<MarketplaceCatalogEntry[]> {
  const bundled = loadBundledCatalog()
  const registryUrl = (getSettings().marketplace?.registryUrl ?? '').trim()
  let remote: MarketplaceCatalog = { schemaVersion: 1, packages: [] }
  if (registryUrl) {
    remote = loadCachedRemoteCatalog()
    if (remote.packages.length === 0) {
      remote = await refreshRemoteCatalog()
    }
  }
  let entries = mergeCatalogs(bundled, remote)
  if (opts?.kind) {
    entries = entries.filter((e) => e.kind === opts.kind)
  }
  const q = opts?.q?.trim().toLowerCase()
  if (q) {
    entries = entries.filter(
      (e) =>
        e.id.toLowerCase().includes(q) ||
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q)
    )
  }
  return enrichCatalogEntryIcons(entries)
}
