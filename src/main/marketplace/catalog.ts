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
import { MARKETPLACE_ICON_URL_MAX_LENGTH } from '../../shared/utils/marketplaceIconUrl'

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

import { fetchPublicResponse } from '@main/net/webFetch'

const INLINE_ICON_MIME_ALLOWLIST = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml'
])

/** Max binary bytes so the base64 data URL stays under the renderer icon gate. */
const INLINE_ICON_MAX_BYTES = Math.floor(((MARKETPLACE_ICON_URL_MAX_LENGTH - 64) * 3) / 4)

/** Remote registry iconUrl values are https URLs; the renderer only accepts data URLs. */
function collectRemoteIconUrls(raw: unknown): Map<string, string> {
  const result = new Map<string, string>()
  const packages = (raw as { packages?: unknown } | null)?.packages
  if (!Array.isArray(packages)) return result
  for (const entry of packages) {
    const id = (entry as { id?: unknown } | null)?.id
    const iconUrl = (entry as { iconUrl?: unknown } | null)?.iconUrl
    if (typeof id === 'string' && typeof iconUrl === 'string' && iconUrl.startsWith('https:')) {
      result.set(id, iconUrl)
    }
  }
  return result
}

async function inlineRemoteCatalogIcons(
  entries: Array<{ id: string }>,
  iconUrls: Map<string, string>
): Promise<Map<string, string>> {
  const inlined = new Map<string, string>()
  const pending = entries.filter((entry) => iconUrls.has(entry.id))
  const CHUNK = 4
  for (let i = 0; i < pending.length; i += CHUNK) {
    const results = await Promise.all(
      pending.slice(i, i + CHUNK).map(async (entry): Promise<readonly [string, string] | null> => {
        const url = iconUrls.get(entry.id)
        if (!url) return null
        try {
          const { response, body } = await fetchPublicResponse(
            new URL(url),
            AbortSignal.timeout(8_000),
            { accept: 'image/*' }
          )
          if (!response.ok) return null
          const mime = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
          if (!INLINE_ICON_MIME_ALLOWLIST.has(mime)) return null
          if (body.byteLength === 0 || body.byteLength > INLINE_ICON_MAX_BYTES) return null
          return [entry.id, `data:${mime};base64,${body.toString('base64')}`] as const
        } catch {
          return null
        }
      })
    )
    for (const item of results) {
      if (item) inlined.set(item[0], item[1])
    }
  }
  return inlined
}

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
    // Bundled entries keep their local asset icons; only inline remote-only entries.
    const bundledIds = new Set(loadBundledCatalog().packages.map((p) => p.id))
    const iconUrls = collectRemoteIconUrls(raw)
    const inlinedIcons = await inlineRemoteCatalogIcons(
      catalog.packages.filter((p) => !bundledIds.has(p.id)),
      iconUrls
    )
    const withSource: MarketplaceCatalog = {
      schemaVersion: 1,
      packages: catalog.packages.map((p) => ({
        ...p,
        ...(inlinedIcons.has(p.id) ? { iconUrl: inlinedIcons.get(p.id) } : {}),
        source: 'remote' as const
      }))
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
