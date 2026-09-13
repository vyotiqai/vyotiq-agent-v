import type { ReactNode } from 'react'
import { Tooltip, cn } from '@renderer/lib/ui'

export function SettingsStack({
  children,
  className
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={cn('flex flex-col gap-6', className)}>{children}</div>
}

export function SettingsGroupLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="m-0 mb-2 px-0.5 text-xs font-normal leading-snug tracking-[var(--vy-tracking)] text-muted">
      {children}
    </h2>
  )
}

export function SettingsCard({
  children,
  className
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      data-settings-card
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
export function SettingsGroup({
  title,
  children
}: {
  title?: string
  children: ReactNode
}) {
  return (
    <section className="flex flex-col">
      {title ? <SettingsGroupLabel>{title}</SettingsGroupLabel> : null}
      <SettingsCard>{children}</SettingsCard>
    </section>
  )
}

export function SettingsField({
  id,
  title,
  hint,
  help,
  wide = false,
  children,
  className
}: {
  /** Stable field id for search scroll/highlight (`data-settings-field`). */
  id: string
  title: string
  /** Short one-liner shown under the title. */
  hint?: string
  /** Longer technical copy shown in a ? tooltip. */
  help?: string
  /**
   * Full-width control under the title (accordions, textareas, lists).
   * Default is Cursor-style: copy left, control right.
   */
  wide?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <div
      data-settings-field={id}
      className={cn('px-4 py-3.5', className)}
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
