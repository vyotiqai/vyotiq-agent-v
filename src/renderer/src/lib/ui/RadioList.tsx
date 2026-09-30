import type { KeyboardEvent, ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { CONTROL_HOVER, SELECTED } from '@renderer/lib/utils/layout'
import { cn } from './cn'

/**
 * The 14px box Checkbox draws, for a row that is itself the checkbox (an
 * option in a list) and so can't nest a button inside it.
 */
export function CheckMark({ on, className }: { on: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-grid size-3.5 shrink-0 place-items-center rounded-[3px] border vy-transition',
        on ? 'border-accent bg-accent text-accent-fg' : 'border-border-strong bg-bg',
        className
      )}
    >
      {on ? <Icon name="check" size={10} weight="bold" /> : null}
    </span>
  )
}

/** The radio's 14px ring, in the accent CheckMark uses, so one form reads as one. */
export function RadioMark({ on, className }: { on: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-grid size-3.5 shrink-0 place-items-center rounded-full border vy-transition',
        on ? 'border-accent' : 'border-border-strong',
        className
      )}
    >
      {on ? <span className="size-1.5 rounded-full bg-accent" /> : null}
    </span>
  )
}

export type RadioChoice<T extends string> = {
  value: T
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
}

/**
 * One radio per row with a line of description under each label, the chosen
 * row filled. Arrow keys, Home and End move the choice, skipping rows that are
 * unavailable, as in any radio group. Name the group with `label` or
 * `labelledBy`.
 */
export function RadioList<T extends string>({
  value,
  choices,
  onChange,
  label,
  labelledBy,
  className
}: {
  value: T
  choices: ReadonlyArray<RadioChoice<T>>
  onChange: (value: T) => void
  label?: string
  labelledBy?: string
  className?: string
}) {
  const enabled = choices.filter((c) => !c.disabled).map((c) => c.value)
  const move = (e: KeyboardEvent<HTMLButtonElement>): void => {
    const i = enabled.indexOf(value)
    let next = -1
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (i + 1) % enabled.length
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (i - 1 + enabled.length) % enabled.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = enabled.length - 1
    if (next < 0 || enabled.length === 0) return
    e.preventDefault()
    const to = enabled[next]!
    onChange(to)
    e.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[role="radio"][data-value="${to}"]`)?.focus()
  }
  return (
    <div
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      className={cn('-mx-2 space-y-px', className)}
    >
      {choices.map((c) => {
        const on = c.value === value
        return (
          <button
            key={c.value}
            type="button"
            role="radio"
            data-value={c.value}
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={c.disabled}
            onClick={() => onChange(c.value)}
            onKeyDown={move}
            className={cn(
              'flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left vy-transition focus-visible:vy-focus-ring disabled:vy-disabled-state',
              on ? SELECTED : c.disabled ? 'text-fg' : cn('text-fg', CONTROL_HOVER)
            )}
          >
            {/* 3px down centres the 14px ring on the label's 20px line. */}
            <RadioMark on={on} className="mt-[3px]" />
            <span className="min-w-0">
              <span className="block text-sm">{c.label}</span>
              {c.description ? <span className="block text-xs text-muted">{c.description}</span> : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}
