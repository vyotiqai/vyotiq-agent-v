import type { ReactNode } from 'react'
import { Tooltip } from './Tooltip'
import { cn } from './cn'

/**
 * The app's form grammar: a stack of labelled groups, each a card of rows.
 *
 * This layout was written for Settings and lived there, so every other surface
 * that needed a labelled form either imported across features or re-invented
 * the spacing. It is generic, so it lives here;
 * `features/settings/components/SettingsField.tsx` re-exports it under the old
 * names and no Settings call site changed.
 *
 * `dataAttribute` exists for that shim. Settings marks its rows with
 * `data-settings-field=<id>`, which its search index queries to scroll and
 * highlight a result, so the attribute name is part of that contract rather
 * than an implementation detail this component may rename.
 */

export function FormStack({
  children,
  className
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={cn('flex flex-col gap-6', className)}>{children}</div>
}

export function FormGroupLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="m-0 mb-2 px-0.5 text-xs font-normal leading-snug tracking-[var(--vy-tracking)] text-muted">
      {children}
    </h2>
  )
}

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
    <div
      {...{ [dataAttribute]: true }}
      className={cn(
        'divide-y divide-border/60 overflow-hidden rounded-xl bg-surface',
        className
      )}
    >
      {children}
    </div>
  )
}

/** Group label + card. Pass `title` for the muted heading above the card. */
export function FormGroup({
  title,
  description,
  children,
  cardDataAttribute
}: {
  title?: string
  /**
   * One sentence under the heading, for a group whose rows only make sense
   * together — three prompt fields that are all handed to the model, say.
   * A per-row `hint` cannot carry that, because the point is what the rows
   * share.
   */
  description?: string
  children: ReactNode
  cardDataAttribute?: string
}) {
  return (
    <section className="flex flex-col">
      {title ? (
        description ? (
          <div className="mb-2 flex flex-col gap-0.5 px-0.5">
            <h2 className="m-0 text-xs font-normal leading-snug tracking-[var(--vy-tracking)] text-muted">
              {title}
            </h2>
            <p className="m-0 max-w-[38rem] text-2xs leading-snug text-tertiary">{description}</p>
          </div>
        ) : (
          <FormGroupLabel>{title}</FormGroupLabel>
        )
      ) : null}
      <FormCard dataAttribute={cardDataAttribute}>{children}</FormCard>
    </section>
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
  children,
  className,
  dataAttribute = 'data-form-row'
}: {
  /** Stable row id, written to `dataAttribute` for search scroll/highlight. */
  id: string
  title: string
  /** Short one-liner shown under the title. */
  hint?: string
  /** Longer technical copy shown in a ? tooltip. */
  help?: string
  /** Small marker after the title — scope ("Workspace"), state. */
  badge?: ReactNode
  /**
   * Full-width control under the title (accordions, textareas, lists).
   * Default is copy left, control right.
   */
  wide?: boolean
  /**
   * A row that only means something under the one above it — the count and
   * age limits of a cleanup switch. The deeper left edge carries the
   * relationship, so the rows need no "(requires …)" copy to explain it.
   */
  indent?: boolean
  children: ReactNode
  className?: string
  dataAttribute?: string
}) {
  return (
    <div
      {...{ [dataAttribute]: id }}
      className={cn(indent ? 'py-3.5 pl-10 pr-4' : 'px-4 py-3.5', className)}
    >
      <div
        className={cn(
          'flex gap-x-6 gap-y-2',
          wide ? 'flex-col items-stretch' : 'flex-nowrap items-center justify-between'
        )}
      >
        <div className={cn(wide ? 'min-w-0 w-full' : 'min-w-0 flex-1')}>
          <div className="flex items-center gap-1.5">
            <p className="m-0 text-sm tracking-[var(--vy-tracking)] text-fg-strong">{title}</p>
            {badge}
            {help ? (
              <Tooltip content={help} side="top" delayMs={200}>
                <button
                  type="button"
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-2xs font-medium text-muted hover:text-fg"
                  aria-label={`About ${title}`}
                >
                  ?
                </button>
              </Tooltip>
            ) : null}
          </div>
          {hint ? (
            <p className="m-0 mt-0.5 text-xs leading-snug tracking-[var(--vy-tracking)] text-secondary [overflow-wrap:break-word]">
              {hint}
            </p>
          ) : null}
        </div>
        <div
          className={cn(
            'flex min-w-0',
            wide
              ? 'w-full flex-col items-stretch gap-2'
              : 'max-w-full flex-col items-end gap-1.5 sm:max-w-[min(100%,24rem)]'
          )}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
