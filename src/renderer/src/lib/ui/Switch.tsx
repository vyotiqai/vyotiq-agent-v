import { cn } from './cn'

/**
 * Compact `sm` track for menu rows; `md` for settings cards.
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  className,
  disabled,
  size = 'sm'
}: {
  checked: boolean
  onCheckedChange: (next: boolean) => void
  label?: string
  className?: string
  disabled?: boolean
  /** `md` is the settings-row track; default stays compact for menus. */
  size?: 'sm' | 'md'
}) {
  const md = size === 'md'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full vy-transition',
        'disabled:vy-disabled-state',
        md ? 'h-5 w-9' : 'h-4 w-7',
        checked ? 'bg-success' : 'bg-surface-2',
        className
      )}
      onClick={() => {
        if (disabled) return
        onCheckedChange(!checked)
      }}
    >
      <span
        className={cn(
          'inline-block rounded-full bg-fg shadow vy-transition',
          md ? 'size-4' : 'size-3',
          checked ? (md ? 'translate-x-4' : 'translate-x-3.5') : 'translate-x-0.5'
        )}
      />
    </button>
  )
}
