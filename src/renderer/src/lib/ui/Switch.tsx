import { cn } from './cn'

/**
 * On/off. One geometry everywhere (the redesign dropped the second track);
 * `size` is accepted so callers written for two sizes keep compiling.
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  className,
  disabled
}: {
  checked: boolean
  onCheckedChange: (next: boolean) => void
  label?: string
  className?: string
  disabled?: boolean
  size?: 'sm' | 'md'
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cn(
        'relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full vy-transition focus-visible:vy-focus-ring',
        'disabled:vy-disabled-state',
        checked ? 'bg-accent' : 'bg-border-strong',
        className
      )}
      onClick={() => {
        if (disabled) return
        onCheckedChange(!checked)
      }}
    >
      <span
        className={cn(
          'absolute size-3.5 rounded-full bg-bg shadow-[0_0_0_0.5px_var(--vy-border-strong)] vy-transition',
          checked ? 'left-[16px]' : 'left-[2px]'
        )}
      />
    </button>
  )
}
