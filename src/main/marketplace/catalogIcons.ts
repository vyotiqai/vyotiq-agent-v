import { existsSync, readFileSync } from 'fs'
import { MarketplaceCatalogEntrySchema, type MarketplaceCatalogEntry } from '../../shared/ipc'
import { bundledMarketplaceAssetPath } from './paths'

/**
 * An icon may be inverted for a dark theme only if every colour in it is the
 * ink. Deciding it from the bytes rather than from a list of exceptions means
 * replacing a vendor's colour art with a monochrome version flips it on with
 * no code change — and adding a new coloured one can never render as a
 * negative by being forgotten.
 */
function isMonochrome(iconPath: string, buf: Buffer): boolean {
  if (!iconPath.toLowerCase().endsWith('.svg')) return false
  const colours = new Set(buf.toString('utf8').match(/#[0-9A-Fa-f]{3,6}/g) ?? [])
  return colours.size > 0 && [...colours].every((c) => c.toLowerCase() === '#000000')
}

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
        iconMono: isMonochrome(entry.iconPath, buf),
        iconUrl: `data:${mime};base64,${buf.toString('base64')}`
      })
    } catch {
      return entry
    }
  })
}
