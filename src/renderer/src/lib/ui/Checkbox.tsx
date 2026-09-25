import type { ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn } from './cn'

/**
 * A 14px box that ticks. The label, when given, sits beside it inside the same
 * target; without one the caller names the box with `aria-label`.
 */
export function Checkbox({
  checked,
  onCheckedChange,
  label,
  'aria-label': ariaLabel,
  title,
  disabled,
  className
}: {
  checked: boolean
  onCheckedChange: (next: boolean) => void
  label?: ReactNode
  'aria-label'?: string
  title?: string
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      className={cn(
        'inline-flex shrink-0 items-center gap-2 rounded-sm focus-visible:vy-focus-ring disabled:vy-disabled-state',
        className
      )}
      onClick={() => {
        if (disabled) return
        onCheckedChange(!checked)
      }}
    >
      <span
        aria-hidden
        className={cn(
          'inline-grid size-3.5 shrink-0 place-items-center rounded-[3px] border vy-transition',
          checked ? 'border-accent bg-accent text-accent-fg' : 'border-border-strong bg-bg'
        )}
      >
        {checked ? <Icon name="check" size={10} weight="bold" /> : null}
      </span>
      {label ? <span className="text-xs text-muted">{label}</span> : null}
    </button>
  )
}
