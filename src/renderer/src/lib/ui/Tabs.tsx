import { type KeyboardEvent, type ReactNode } from 'react'
import { Icon, type IconName } from '../icons'
import { cn } from './cn'
import { Count } from './Count'

export type TabItem<T extends string> = {
  id: T
  label: string
  icon?: IconName
  count?: number | string
  /** Something inside is working right now (a live dot). */
  live?: boolean
  /** Shown on hover, e.g. the tab's shortcut. */
  title?: string
  /** Anything else after the label (a close button, a menu). */
  trailing?: ReactNode
}

/** Arrow keys, Home and End move between a row of mutually exclusive buttons. */
function moveFocus<T extends string>(
  e: KeyboardEvent<HTMLButtonElement>,
  ids: readonly T[],
  current: T,
  onChange?: (id: T) => void
) {
  const i = ids.indexOf(current)
  let next = -1
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % ids.length
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + ids.length) % ids.length
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = ids.length - 1
  if (next < 0) return
  e.preventDefault()
  onChange?.(ids[next])
  const group = e.currentTarget.parentElement
  const target = group?.querySelectorAll<HTMLButtonElement>('[data-roving]')[next]
  target?.focus()
}

/**
 * The one tab style: an underline under the current tab. The renderer had
 * three (pills in the dock, underlines in PR, rounded tops in Browser).
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className,
  size = 'md',
  label,
  panelIdPrefix
}: {
  items: readonly TabItem<T>[]
  value: T
  onChange?: (id: T) => void
  className?: string
  size?: 'sm' | 'md'
  /** Accessible name for the tab list. */
  label?: string
  /** Each tab controls the element `${panelIdPrefix}${id}`. */
  panelIdPrefix?: string
}) {
  const ids = items.map((t) => t.id)
  return (
    <div role="tablist" aria-label={label} className={cn('flex min-w-0 items-stretch gap-4', className)}>
      {items.map((t) => {
        const on = t.id === value
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-roving
            aria-selected={on}
            aria-controls={panelIdPrefix ? `${panelIdPrefix}${t.id}` : undefined}
            tabIndex={on ? 0 : -1}
            title={t.title}
            onClick={() => onChange?.(t.id)}
            onKeyDown={(e) => moveFocus(e, ids, value, onChange)}
            className={cn(
              'relative inline-flex shrink-0 items-center gap-1.5 font-medium vy-transition focus-visible:vy-focus-ring',
              size === 'sm' ? 'h-8 text-xs' : 'h-10 text-sm',
              on ? 'text-fg-strong' : 'text-muted hover:text-fg'
            )}
          >
            {t.icon ? <Icon name={t.icon} size={15} /> : null}
            {t.label}
            {t.count !== undefined ? <Count n={t.count} /> : null}
            {t.live ? (
              <>
                <span aria-hidden="true" className="size-1.5 animate-live rounded-full bg-accent" />
                <span className="sr-only">, working now</span>
              </>
            ) : null}
            {t.trailing}
            <span
              aria-hidden="true"
              className={cn('absolute inset-x-0 -bottom-px h-[2px] rounded-full', on ? 'bg-fg-strong' : 'bg-transparent')}
            />
          </button>
        )
      })}
    </div>
  )
}

/** Two to five mutually exclusive options that change a view: 7d/30d, Unified/Split. */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
  className,
  label,
  disabled = false
}: {
  items: ReadonlyArray<{ id: T; label?: string; icon?: IconName; title?: string }>
  value: T
  onChange?: (id: T) => void
  className?: string
  /** Accessible name for the group. */
  label?: string
  disabled?: boolean
}) {
  const ids = items.map((t) => t.id)
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cn('inline-flex h-7 items-center rounded-md bg-surface p-0.5', disabled && 'opacity-45', className)}
    >
      {items.map((it) => {
        const on = it.id === value
        return (
          <button
            key={it.id}
            type="button"
            role="radio"
            data-roving
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={disabled}
            title={it.title}
            aria-label={it.label ? undefined : it.title}
            onClick={() => onChange?.(it.id)}
            onKeyDown={(e) => moveFocus(e, ids, value, onChange)}
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-[calc(var(--vy-radius-md)-2px)] px-2 text-xs font-medium vy-transition focus-visible:vy-focus-ring',
              on ? 'bg-bg text-fg-strong shadow-[0_0_0_1px_var(--vy-border)]' : 'text-muted hover:text-fg'
            )}
          >
            {it.icon ? <Icon name={it.icon} size={14} /> : null}
            {it.label}
          </button>
        )
      })}
    </div>
  )
}
