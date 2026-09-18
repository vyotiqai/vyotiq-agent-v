import { cn } from '@renderer/lib/ui'
import { isAllowedMarketplaceIconUrl } from '@shared/utils/marketplaceIconUrl'

/**
 * Matches the `rx="14"` on a 64px brand tile, as a percentage so it holds at
 * every render size. Brand art paints its own tile over the neutral backing;
 * a plain glyph keeps the backing so both read as the same silhouette.
 */
const TILE_RADIUS = '22%'

export function PackageIcon({
  name,
  iconUrl,
  size = 40,
  className
}: {
  name: string
  iconUrl?: string
  size?: number
  className?: string
}) {
  const letter = (name.trim()[0] ?? '?').toUpperCase()
  const safeIcon = iconUrl && isAllowedMarketplaceIconUrl(iconUrl) ? iconUrl : undefined

  if (safeIcon) {
    return (
      <img
        src={safeIcon}
        alt=""
        width={size}
        height={size}
        className={cn('shrink-0 bg-surface object-contain', className)}
        style={{ width: size, height: size, borderRadius: TILE_RADIUS }}
      />
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
