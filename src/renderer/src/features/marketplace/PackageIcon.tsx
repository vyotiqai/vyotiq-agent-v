import { cn } from '@renderer/lib/ui'
import { isAllowedMarketplaceIconUrl } from '@shared/utils/marketplaceIconUrl'

/**
 * The backing every icon sits on, as a percentage so it holds at every render
 * size. Nothing paints its own tile any more — the art is one black ink on
 * nothing — so this backing is the only silhouette, and it is the same for all.
 */
const TILE_RADIUS = '22%'

export function PackageIcon({
  name,
  iconUrl,
  iconMono,
  size = 40,
  className
}: {
  name: string
  iconUrl?: string
  /** Art that is a single black ink, so a dark theme can invert it. */
  iconMono?: boolean
  size?: number
  className?: string
}) {
  const letter = (name.trim()[0] ?? '?').toUpperCase()
  const safeIcon = iconUrl && isAllowedMarketplaceIconUrl(iconUrl) ? iconUrl : undefined

  if (safeIcon) {
    return (
      // The backing is a wrapper rather than a class on the <img>, because a
      // filter applies to everything the element paints. With `bg-surface` on
      // the image itself, `dark:invert` flipped the tile to a pale grey and
      // left a white glyph sitting on it. `overflow-hidden` keeps a vendored
      // square (deepwiki.png is fully opaque) inside the rounded corner.
      <span
        className={cn('inline-block shrink-0 overflow-hidden bg-surface', className)}
        style={{ width: size, height: size, borderRadius: TILE_RADIUS }}
      >
        <img
          src={safeIcon}
          alt=""
          width={size}
          height={size}
          // An <img>-loaded SVG is its own document and cannot inherit
          // currentColor, so the dark theme flips the ink here instead. Only
          // for monochrome art: inverting a vendor's colour mark is a negative.
          className={cn('block h-full w-full object-contain', iconMono && 'dark:invert')}
        />
      </span>
    )
  }

  return (
    <span
      className={cn(
        'inline-grid shrink-0 place-items-center border border-border bg-surface text-sm font-medium text-secondary',
        className
      )}
      style={{ width: size, height: size, borderRadius: TILE_RADIUS }}
      aria-hidden
    >
      {letter}
    </span>
  )
}
