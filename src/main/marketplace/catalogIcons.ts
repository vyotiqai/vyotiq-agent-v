import { existsSync, readFileSync } from 'fs'
import { MarketplaceCatalogEntrySchema, type MarketplaceCatalogEntry } from '../../shared/ipc'
import { bundledMarketplaceAssetPath } from './paths'

/** Attach data-URL iconUrl from iconPath when missing. */
export function enrichCatalogEntryIcons(
  entries: MarketplaceCatalogEntry[]
): MarketplaceCatalogEntry[] {
  return entries.map((entry) => {
    if (entry.iconUrl || !entry.iconPath) return entry
    const abs = bundledMarketplaceAssetPath(entry.iconPath)
    if (!existsSync(abs)) return entry
    try {
      const buf = readFileSync(abs)
      const lower = entry.iconPath.toLowerCase()
      const mime = lower.endsWith('.svg')
        ? 'image/svg+xml'
        : lower.endsWith('.png')
          ? 'image/png'
          : lower.endsWith('.webp')
            ? 'image/webp'
            : lower.endsWith('.jpg') || lower.endsWith('.jpeg')
              ? 'image/jpeg'
              : lower.endsWith('.gif')
                ? 'image/gif'
                : null
      if (!mime) return entry
      return MarketplaceCatalogEntrySchema.parse({
        ...entry,
        iconUrl: `data:${mime};base64,${buf.toString('base64')}`
      })
    } catch {
      return entry
    }
  })
}
