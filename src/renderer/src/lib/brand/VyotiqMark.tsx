import { cn } from '@renderer/lib/ui/cn'

/** Vyotiq mark — in-app chrome. Fill follows `currentColor`. */
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
      viewBox="0 0 1024 1024"
      width={size}
      height={size}
      className={cn('shrink-0', className)}
      data-brand-mark=""
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : 'Vyotiq'}
      aria-hidden={decorative || undefined}
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M 802.410 512.000 L 366.795 763.503 L 366.795 260.497 Z"
      />
      <path
        fill="currentColor"
        d="M 858.410 544.332 L 858.410 712.000 L 512.000 912.000 L 366.795 828.166 Z"
      />
      <path
        fill="currentColor"
        d="M 310.795 795.834 L 165.590 712.000 L 165.590 312.000 L 310.795 228.166 Z"
      />
      <path
        fill="currentColor"
        d="M 366.795 195.834 L 512.000 112.000 L 858.410 312.000 L 858.410 479.668 Z"
      />
    </svg>
  )
}
