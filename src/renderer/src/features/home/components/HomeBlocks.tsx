import type { ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'

/**
 * A Home section: a caps label with an optional link on its right edge, over
 * rows ruled by one hairline. The region is named by the label alone, so the
 * link's text never leaks into it.
 */
export function HomeSection({
  id,
  label,
  trailing,
  className,
  children
}: {
  id: string
  label: string
  trailing?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section aria-labelledby={id} className={cn('min-w-0', className)}>
      <h2 className={cn('flex h-6 items-center gap-2', SECTION_LABEL)}>
        <span id={id}>{label}</span>
        <span className="flex-1" />
        {trailing}
      </h2>
      <ul className="divide-y divide-border border-t border-border">{children}</ul>
    </section>
  )
}

/** One row of a Home section: a leading glyph, two lines, trailing controls. */
export function HomeRow({ children, className }: { children: ReactNode; className?: string }) {
  return <li className={cn('flex min-h-12 items-center gap-3 py-2', className)}>{children}</li>
}

/** The quiet link in a section label: "+ Add", "Usage →". */
export function HomeLink({
  children,
  icon,
  onClick
}: {
  children: ReactNode
  /** A leading plus; without one the link points onward with an arrow. */
  icon?: 'plus'
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-sm text-caption font-medium normal-case tracking-normal text-muted vy-transition hover:text-fg focus-visible:vy-focus-ring"
    >
      {icon ? <Icon name={icon} size={11} /> : null}
      {children}
      {icon ? null : <Icon name="arrowRight" size={11} />}
    </button>
  )
}
