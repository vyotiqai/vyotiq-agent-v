import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/ui'

/**
 * One titled block on Home. Every section shares this frame so the page reads
 * as a short stack of categories rather than a wall of rows.
 */
export function HomeSection({
  id,
  title,
  count,
  trailing,
  children,
  className
}: {
  /** Heading element id — the section is labelled by it for assistive tech. */
  id: string
  title: string
  /** Shown beside the title when the section's size is itself information. */
  count?: number
  trailing?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section aria-labelledby={id} className={cn('mt-7 first:mt-0', className)}>
      <div className="mb-2 flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2
          id={id}
          className="m-0 text-2xs font-medium uppercase tracking-[var(--vy-tracking-caps)] text-muted"
        >
          {title}
          {count != null ? <span className="ml-1.5 tabular-nums text-tertiary">{count}</span> : null}
        </h2>
        {trailing}
      </div>
      {children}
    </section>
  )
}

/**
 * Bordered list frame with hairline row separators.
 *
 * It is also a query container: Home puts cards in columns of very different
 * widths, so a row has to lay itself out from the width of its own card rather
 * than the width of the window. A viewport breakpoint would give a row in a
 * 320px rail the same two-column layout as one spanning the whole page.
 */
export function HomeCard({
  children,
  role,
  className,
  'aria-label': ariaLabel
}: {
  children: ReactNode
  role?: string
  className?: string
  /** Names the frame when it is a landmark of its own, such as a lane. */
  'aria-label'?: string
}) {
  return (
    <div
      role={role}
      aria-label={ariaLabel}
      className={cn(
        '@container overflow-hidden rounded-lg border border-border bg-card/40',
        role === 'list' && 'divide-y divide-border/40',
        className
      )}
    >
      {children}
    </div>
  )
}

/** Quiet single-line state inside a section frame. */
export function HomeNote({ children }: { children: ReactNode }) {
  return (
    <HomeCard>
      <p role="status" className="m-0 px-3 py-6 text-center text-xs text-muted">
        {children}
      </p>
    </HomeCard>
  )
}
