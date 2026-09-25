import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from 'react'
import { Icon } from '../icons'
import { SECTION_LABEL } from '../utils/layout'
import { Tooltip } from './Tooltip'
import { cn } from './cn'

/**
 * The app's form grammar: labelled groups of ruled rows.
 *
 * A row is its label and a one-line hint on the left, its control on the right
 * edge. Every control shows its value, but only a row set away from its default
 * carries a mark — an accent rule at its edge, the label in the strong weight,
 * and a Reset on hover — so defaults read quiet and a change finds the eye on
 * its own.
 *
 * `dataAttribute` exists for Settings, which marks its rows with
 * `data-settings-field=<id>`: its search index queries that to scroll and
 * highlight a result, so the attribute name is part of that contract rather
 * than an implementation detail this component may rename.
 */

/** How a changed row goes back: its own Reset, and what that Reset puts back. */
export type FormChange = {
  reset?: () => void
  /**
   * What the reset writes, in the page's own terms. Opaque here: a page that
   * resets many rows at once merges these into one save, where calling every
   * row's Reset would race — two fields of one object setting, each written
   * back whole, keep only the last.
   */
  token?: unknown
}

/**
 * Collects which rows are changed from their default, so a page can say how
 * many there are and reset them together. A row reports while it is changed
 * and withdraws when it is not, so the registry holds the changed rows only.
 * `read` returns the row's latest Reset, not the one it had when it reported.
 * Rows outside a registry just draw their own mark.
 */
export const FormChangesContext = createContext<{
  report: (id: string, read: (() => FormChange) | null) => void
} | null>(null)

/**
 * Report a change to the page's registry without drawing a row — a picker
 * that is its own group, say. `FormRow` reports through this too.
 */
export function useFormChange(changed: boolean, reset?: () => void, token?: unknown): void {
  const changes = useContext(FormChangesContext)
  const id = useId()
  // The latest Reset, read when it is used: a report per render would churn
  // the registry, and one made once would reset to a stale value.
  const latest = useRef<FormChange>({})
  latest.current = { reset, token }
  useEffect(() => {
    if (!changes || !changed) return undefined
    changes.report(id, () => latest.current)
    return () => changes.report(id, null)
  }, [changes, id, changed])
}

export function FormStack({
  children,
  className
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={cn('flex flex-col', className)}>{children}</div>
}

export function FormGroupLabel({ children }: { children: ReactNode }) {
  return <h2 className={SECTION_LABEL}>{children}</h2>
}

/** The rows of a group, ruled above, below and between. */
export function FormCard({
  children,
  className,
  dataAttribute = 'data-form-card'
}: {
  children: ReactNode
  className?: string
  dataAttribute?: string
}) {
  return (
    <div {...{ [dataAttribute]: true }} className={cn('divide-y divide-border border-y border-border', className)}>
      {children}
    </div>
  )
}

/** A caps label — with a note beside it for what its rows share — over its rows. */
export function FormGroup({
  title,
  description,
  children,
  cardDataAttribute,
  anchor,
  plain = false
}: {
  title?: string
  /** One line beside the label, for what the rows share rather than what one row does. */
  description?: string
  children: ReactNode
  cardDataAttribute?: string
  /** Marks the group itself as a target (`{ [attribute]: id }`), for a group whose rows are not. */
  anchor?: { attribute: string; id: string }
  /** The group holds one block that is not rows (a picker, a meter), so nothing rules it. */
  plain?: boolean
}) {
  return (
    <section className="mt-6" {...(anchor ? { [anchor.attribute]: anchor.id } : {})}>
      {title ? (
        <div className="mb-1 flex items-baseline gap-3">
          <FormGroupLabel>{title}</FormGroupLabel>
          {description ? <span className="text-xs text-tertiary">{description}</span> : null}
        </div>
      ) : null}
      {plain ? children : <FormCard dataAttribute={cardDataAttribute}>{children}</FormCard>}
    </section>
  )
}

/** "▢ this workspace" — the row saves to the active workspace's override. */
export function WorkspaceScopeBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-caption text-tertiary" title="Saved for this workspace only">
      <Icon name="workspace" size={11} />
      this workspace
    </span>
  )
}

export function FormRow({
  id,
  title,
  hint,
  help,
  badge,
  wide = false,
  indent = false,
  changed = false,
  onReset,
  resetToken,
  below,
  children,
  className,
  dataAttribute = 'data-form-row'
}: {
  /** Stable row id, written to `dataAttribute` for search scroll/highlight. */
  id: string
  title: string
  /** Short one-liner shown under the title. */
  hint?: ReactNode
  /** Longer technical copy shown in a ? tooltip. */
  help?: string
  /** Small marker after the title — scope ("this workspace"), state. */
  badge?: ReactNode
  /**
   * The control goes under the copy, full width (lists, text areas, cards),
   * instead of on the right edge.
   */
  wide?: boolean
  /**
   * A row that only means something under the one above it — the limits of a
   * cleanup switch. The deeper left edge carries the relationship, so the row
   * needs no "(requires …)" copy to explain it.
   */
  indent?: boolean
  /** Set away from its default: the only rows that get a mark. */
  changed?: boolean
  /** Puts the row back to its default. Shown on hover while `changed`. */
  onReset?: () => void
  /** What `onReset` writes, for a page that resets many rows as one save. */
  resetToken?: unknown
  /** More under the row, full width: chips, a progress bar, a short list. */
  below?: ReactNode
  children?: ReactNode
  className?: string
  dataAttribute?: string
}) {
  useFormChange(changed, onReset, resetToken)

  const control = wide ? null : children
  const under = wide ? children : below
  return (
    <div
      {...{ [dataAttribute]: id }}
      data-changed={changed || undefined}
      className={cn('group relative py-3', indent ? 'pl-6' : '', className)}
    >
      {changed ? (
        <span
          className="absolute -left-3 top-3.5 h-4 w-[2px] rounded-full bg-accent"
          role="img"
          aria-label="Changed from default"
        />
      ) : null}
      <div className="flex items-start gap-8">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn('min-w-0 text-sm', changed ? 'font-medium text-fg-strong' : 'text-fg')}>{title}</span>
            {badge}
            {help ? (
              <Tooltip content={help} side="top" delayMs={200}>
                <button
                  type="button"
                  className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-caption text-tertiary vy-transition hover:text-fg focus-visible:vy-focus-ring"
                  aria-label={`About ${title}`}
                >
                  ?
                </button>
              </Tooltip>
            ) : null}
            {changed && onReset ? (
              <button
                type="button"
                className="rounded-sm text-caption text-tertiary opacity-0 vy-transition hover:text-fg focus-visible:opacity-100 focus-visible:vy-focus-ring group-hover:opacity-100"
                onClick={onReset}
              >
                Reset
              </button>
            ) : null}
          </div>
          {hint ? <div className="mt-0.5 text-xs leading-[18px] text-muted [overflow-wrap:anywhere]">{hint}</div> : null}
        </div>
        {control != null && control !== false ? (
          <div className="flex max-w-[min(100%,24rem)] shrink-0 flex-col items-end gap-1.5 pt-px">{control}</div>
        ) : null}
      </div>
      {under != null && under !== false ? <div className="mt-2.5">{under}</div> : null}
    </div>
  )
}
