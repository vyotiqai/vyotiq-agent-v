import type { ReactNode } from 'react'
import { cn } from './cn'

export function PageHeader({
  title,
  description,
  trailing,
  bordered = true,
  className
}: {
  title: string
  description?: string
  trailing?: ReactNode
  bordered?: boolean
  className?: string
}) {
  return (
    <header
      className={cn(
        bordered && 'mb-1 border-b border-border/30 pb-4 pt-1',
        trailing ? 'flex flex-wrap items-start justify-between gap-3' : undefined,
        className
      )}
    >
      <div className="min-w-0">
        <h1 className="m-0 text-heading font-medium tracking-[var(--vy-tracking)] text-fg-strong">
          {title}
        </h1>
        {description ? (
          <p className="m-0 mt-1 text-xs leading-snug tracking-[var(--vy-tracking)] text-secondary">
            {description}
          </p>
        ) : null}
      </div>
      {trailing}
    </header>
  )
}
