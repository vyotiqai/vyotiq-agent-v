import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@renderer/lib/ui'

export function TextShimmer({
  children,
  className,
  duration = 1.2
}: {
  children: ReactNode
  className?: string
  duration?: number
}) {
  return (
    <span
      className={cn('vy-text-shimmer vy-text-shimmer--active', className)}
      style={{ '--vy-shimmer-duration': `${duration}s` } as CSSProperties}
    >
      {children}
    </span>
  )
}
