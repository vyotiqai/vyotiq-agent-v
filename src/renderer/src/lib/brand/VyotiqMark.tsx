import { cn } from '@renderer/lib/ui/cn'
import { VYOTIQ_MARK_PATHS, VYOTIQ_MARK_VIEW_BOX } from '@shared/brand/vyotiqMark'

/**
 * Vyotiq mark — in-app chrome. Fill follows `currentColor`, which is why this
 * draws the geometry rather than loading the SVG the kit ships: an <img>
 * cannot inherit a colour. The path data is generated, not copied — see
 * scripts/generate-precision-mono-brand.mjs.
 */
export function VyotiqMark({
  size = 24,
  className,
  decorative = false
}: {
  size?: number
  className?: string
  decorative?: boolean
}) {
  return (
    <svg
      viewBox={VYOTIQ_MARK_VIEW_BOX}
      width={size}
      height={size}
      className={cn('shrink-0', className)}
      data-brand-mark=""
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : 'Vyotiq'}
      aria-hidden={decorative || undefined}
      focusable="false"
    >
      {VYOTIQ_MARK_PATHS.map((d) => (
        <path key={d} fill="currentColor" d={d} />
      ))}
    </svg>
  )
}
