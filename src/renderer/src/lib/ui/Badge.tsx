import type { ReactNode } from 'react'
import { cn } from './cn'

/**
 * Small status or count pill.
 *
 * Tones are semantic, not decorative: pick the one that matches what the label
 * means, so the colour survives all five skins and both themes. `dot` adds a
 * leading marker for states that read better as presence than as a word.
 */

const badgeTones = {
  neutral: 'bg-surface-2 text-muted',
  accent: 'bg-accent/15 text-accent',
  success: 'bg-success/15 text-success',
  danger: 'bg-danger/15 text-danger',
  warning: 'bg-warning/15 text-warning'
} as const

const badgeDotTones: Record<keyof typeof badgeTones, string> = {
  neutral: 'bg-muted',
  accent: 'bg-accent',
  success: 'bg-success',
  danger: 'bg-danger',
  warning: 'bg-warning'
}

const badgeSizes = {
  sm: 'min-h-4 px-1.5 text-3xs',
  md: 'min-h-5 px-2 text-2xs'
} as const

export function Badge({
  children,
  tone = 'neutral',
  size = 'sm',
  dot = false,
  className,
  title
}: {
  children: ReactNode
  tone?: keyof typeof badgeTones
  size?: keyof typeof badgeSizes
  dot?: boolean
  className?: string
  title?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-pill font-medium leading-none',
        badgeSizes[size],
        badgeTones[tone],
        className
      )}
      title={title}
    >
      {dot ? (
        <span className={cn('size-1.5 shrink-0 rounded-full', badgeDotTones[tone])} aria-hidden />
      ) : null}
      {children}
    </span>
  )
}
