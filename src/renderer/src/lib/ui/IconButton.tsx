import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Icon, type IconName } from '../icons'
import { cn } from './cn'
import { Tooltip } from './Tooltip'

const interactive = 'vy-transition disabled:vy-disabled-state'

const iconButtonVariants = {
  ghost: 'text-fg hover:bg-surface active:bg-surface-2',
  /** No fill at rest or hover — icon-only chrome (sidebar toggle). */
  bare: 'text-fg hover:text-fg-strong active:opacity-80',
  primary: 'bg-accent text-accent-fg hover:bg-fg-strong active:opacity-90',
  subtle:
    'border border-border bg-surface text-fg hover:bg-surface-2 hover:border-border-strong active:bg-surface-2'
} as const

const iconButtonSizes = {
  xs: 'size-6',
  sm: 'size-7',
  md: 'size-8',
  lg: 'size-9'
} as const

const iconSizes: Record<keyof typeof iconButtonSizes, number> = {
  xs: 16,
  sm: 18,
  md: 20,
  lg: 24
}

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    icon: IconName
    label: string
    variant?: keyof typeof iconButtonVariants
    size?: keyof typeof iconButtonSizes
  }
>(function IconButton(
  {
    icon,
    label,
    variant = 'ghost',
    size = 'md',
    className = '',
    type = 'button',
    title,
    disabled,
    ...props
  },
  ref
) {
  const tip = title ?? label
  const buttonClass = cn(
    'inline-grid place-items-center rounded-md focus-visible:vy-focus-ring active:scale-[0.98]',
    interactive,
    iconButtonSizes[size],
    iconButtonVariants[variant],
    className
  )

  const button = (
    <button
      ref={ref}
      className={buttonClass}
      type={type}
      aria-label={label}
      disabled={disabled}
      {...props}
    >
      <Icon name={icon} size={iconSizes[size]} />
    </button>
  )

  // Disabled buttons ignore pointer events — wrap so hover still shows why.
  if (disabled) {
    return (
      <Tooltip content={tip}>
        <span className="inline-grid cursor-not-allowed" aria-disabled="true">
          {button}
        </span>
      </Tooltip>
    )
  }

  return <Tooltip content={tip}>{button}</Tooltip>
})
