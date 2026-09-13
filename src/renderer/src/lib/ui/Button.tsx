import { type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from './cn'
import { Tooltip } from './Tooltip'

const interactive = 'vy-transition disabled:vy-disabled-state'

export const buttonVariants = {
  primary: cn(
    'rounded-md bg-accent text-accent-fg',
    'hover:bg-[var(--vy-accent-hover)] active:opacity-90'
  ),
  subtle: cn(
    'rounded-md border border-border bg-surface text-fg',
    'hover:bg-surface-2 hover:border-border-strong active:bg-surface-2'
  ),
  ghost: cn('rounded-md bg-transparent text-fg', 'hover:bg-surface active:bg-surface-2'),
  /** Destructive intent — quiet at rest, danger fill on press-in surfaces. */
  danger: cn(
    'rounded-md border border-danger/40 bg-surface text-danger',
    'hover:bg-danger hover:border-danger hover:text-white active:bg-danger'
  )
} as const

const buttonBase = cn(
  'inline-flex min-h-[var(--vy-control-min-h)] items-center justify-center gap-[var(--vy-control-gap)] px-[var(--vy-control-px)] text-sm tracking-[var(--vy-tracking)]',
  'focus-visible:vy-focus-ring active:scale-[0.98]',
  interactive
)

export function Button({
  variant = 'primary',
  children,
  className = '',
  type = 'button',
  pending = false,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof buttonVariants
  children?: ReactNode
  /** Disables the control and marks it busy for assistive tech. */
  pending?: boolean
}) {
  const isDisabled = Boolean(disabled || pending)
  const why = isDisabled && typeof props.title === 'string' ? props.title : ''

  const button = (
    <button
      className={cn(buttonBase, buttonVariants[variant], className)}
      type={type}
      disabled={isDisabled}
      aria-busy={pending || undefined}
      aria-disabled={isDisabled || undefined}
      {...props}
      title={why ? undefined : props.title}
    >
      {children}
    </button>
  )

  // Disabled buttons ignore pointer events — a native title never shows. Wrap
  // so hover still shows why (same pattern as IconButton).
  if (why) {
    return (
      <Tooltip content={why}>
        <span className="inline-flex cursor-not-allowed">{button}</span>
      </Tooltip>
    )
  }

  return button
}
