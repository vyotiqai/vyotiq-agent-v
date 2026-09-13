import { cn } from '@renderer/lib/ui'
import { isAllowedMarketplaceIconUrl } from '@shared/utils/marketplaceIconUrl'

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
        className={cn('shrink-0 rounded-md object-contain', className)}
        style={{ width: size, height: size }}
      />
    )
  }

  return (
    <span
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-md border border-border bg-surface text-sm font-medium text-secondary',
        className
      )}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {letter}
    </span>
  )
}
