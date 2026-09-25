import type { ReactNode } from 'react'
import { cn } from './cn'

/**
 * Small status or count tag.
 *
 * Tones are semantic, not decorative. The redesign uses three — `outline` (a
 * quiet tag), `accent` (asks for you) and `success` (passed). `neutral`,
 * `danger` and `warning` stay for surfaces not yet ported. Tints come from the
 * named `-soft` tokens, never an invented opacity.
 */
const badgeTones = {
  outline: 'border border-border text-muted',
  neutral: 'bg-surface-2 text-muted',
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  danger: 'bg-danger-soft text-danger',
  warning: 'bg-warning-soft text-warning'
} as const

export type BadgeTone = keyof typeof badgeTones

const badgeDotTones: Record<BadgeTone, string> = {
  outline: 'bg-muted',
  neutral: 'bg-muted',
  accent: 'bg-accent',
  success: 'bg-success',
  danger: 'bg-danger',
  warning: 'bg-warning'
}

const badgeSizes = {
  sm: 'h-[18px] px-1.5 text-caption',
  md: 'h-5 px-2 text-xs'
} as const

export function Badge({
  children,
  tone = 'neutral',
  size = 'sm',
  dot = false,
  mono = false,
  className,
  title
}: {
  children: ReactNode
  tone?: BadgeTone
  size?: keyof typeof badgeSizes
  dot?: boolean
  /** Tabular digits, for versions and counts. */
  mono?: boolean
  className?: string
  title?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm font-medium leading-none',
        badgeSizes[size],
        badgeTones[tone],
        mono && 'font-mono tnum',
        className
      )}
      title={title}
    >
      {dot ? <span className={cn('size-1.5 shrink-0 rounded-full', badgeDotTones[tone])} aria-hidden /> : null}
      {children}
    </span>
  )
}
