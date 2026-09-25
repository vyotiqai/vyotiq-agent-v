import type { CSSProperties } from 'react'
import { Icon, type IconName } from '@renderer/lib/icons'
import { isAllowedMarketplaceIconUrl } from '@shared/utils/marketplaceIconUrl'

/**
 * One-ink catalog art is the kit scripts/sync-marketplace-brand-icons.mjs draws:
 * about 40 units of ink centred on a 64-unit canvas. The mockup's marks are ink
 * edge to edge, so the kit's canvas is sized for its ink to be the mark.
 */
const KIT_INK = 40 / 64

/** One-ink art as a mask over `currentColor`, on a canvas of `canvas` px. */
function inkMaskStyle(art: string, canvas: number): CSSProperties {
  return {
    width: canvas,
    height: canvas,
    maskImage: `url("${art}")`,
    WebkitMaskImage: `url("${art}")`,
    maskSize: 'contain',
    WebkitMaskSize: 'contain',
    maskRepeat: 'no-repeat',
    WebkitMaskRepeat: 'no-repeat',
    maskPosition: 'center',
    WebkitMaskPosition: 'center'
  }
}

/**
 * A package's mark on a tile — the extension list (32) and the detail header
 * (44). The mark's ink is half the tile.
 *
 * Catalog art that is one black ink (`iconMono`) is drawn as a mask filled
 * with `currentColor`, so it takes the tile's ink in every skin and theme the
 * way the mockup's inline paths do. Art with its own colours is shown as it
 * is: recolouring a vendor's mark would be a different mark. Anything without
 * art gets a monogram, and a rule gets the rules glyph.
 */
export function BrandTile({
  name,
  iconUrl,
  iconMono,
  icon,
  size = 36
}: {
  name: string
  iconUrl?: string
  iconMono?: boolean
  /** A glyph from the allowlist instead of art or a monogram. */
  icon?: IconName
  size?: number
}) {
  const mark = Math.round(size * 0.5)
  const kitCanvas = Math.round(mark / KIT_INK)
  const art = iconUrl && isAllowedMarketplaceIconUrl(iconUrl) ? iconUrl : undefined
  const letter = (name.trim()[0] ?? '·').toUpperCase()
  return (
    <span
      aria-hidden="true"
      data-brand-tile
      className="inline-grid shrink-0 place-items-center rounded-lg bg-surface text-fg-strong"
      style={{ width: size, height: size }}
    >
      {art ? (
        iconMono ? (
          <span data-brand-mask className="block bg-current" style={inkMaskStyle(art, kitCanvas)} />
        ) : (
          <img src={art} alt="" width={mark} height={mark} className="block object-contain" />
        )
      ) : icon ? (
        <Icon name={icon} size={mark} />
      ) : (
        <span
          className="font-bold leading-none tracking-tight"
          style={{ fontSize: Math.round(mark * 0.82) }}
        >
          {letter}
        </span>
      )}
    </span>
  )
}

/**
 * A package's mark with no tile, in a menu row's icon slot: its ink is `size`
 * and, for one-ink art, takes the text colour. Without allowed art it is the
 * `fallback` glyph.
 */
export function BrandMark({
  iconUrl,
  iconMono,
  fallback,
  size = 15,
  className
}: {
  iconUrl?: string
  iconMono?: boolean
  fallback: IconName
  size?: number
  /** Ink colour, e.g. `text-muted`. */
  className: string
}) {
  const art = iconUrl && isAllowedMarketplaceIconUrl(iconUrl) ? iconUrl : undefined
  if (!art) return <Icon name={fallback} size={size} className={`shrink-0 ${className}`} />
  if (!iconMono) {
    return <img src={art} alt="" width={size} height={size} className="block shrink-0 object-contain" />
  }
  // The kit's canvas is wider than its ink; it overflows the slot on every side equally.
  return (
    <span aria-hidden="true" className={`relative block shrink-0 ${className}`} style={{ width: size, height: size }}>
      <span
        data-brand-mask
        className="absolute left-1/2 top-1/2 block -translate-x-1/2 -translate-y-1/2 bg-current"
        style={inkMaskStyle(art, Math.round(size / KIT_INK))}
      />
    </span>
  )
}
