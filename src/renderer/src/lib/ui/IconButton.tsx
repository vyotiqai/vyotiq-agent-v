import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Icon, type IconName } from '../icons'
import { cn } from './cn'
import { Tooltip } from './Tooltip'

const interactive = 'vy-transition disabled:vy-disabled-state'

/**
 * Tone is how loud the icon is at rest. `default` for an action the row is
 * about, `muted` for secondary chrome (thumbs, attach, dismiss), `inherit`
 * when the caller sets the colour itself — one class, so nothing to override.
 */
const tones = {
  default: 'text-secondary hover:bg-surface hover:text-fg-strong',
  muted: 'text-tertiary hover:bg-surface hover:text-fg',
  inherit: 'hover:bg-surface'
} as const

/** Legacy looks, kept until their last caller is ported. */
const legacyVariants = {
  ghost: 'text-fg hover:bg-surface active:bg-surface-2',
  /** No fill at rest or hover — icon-only chrome. */
  bare: 'text-fg hover:text-fg-strong active:opacity-80',
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover active:opacity-90',
  subtle: 'border border-border bg-bg text-fg hover:border-border-strong hover:bg-surface'
} as const

const sizes = {
  xs: 'size-5 rounded-sm',
  sm: 'size-6 rounded-md',
  md: 'size-7 rounded-md',
  lg: 'size-8 rounded-md'
} as const

const glyphs: Record<keyof typeof sizes, number> = { xs: 13, sm: 15, md: 16, lg: 18 }

export type IconButtonTone = keyof typeof tones

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    icon: IconName
    label: string
    size?: keyof typeof sizes
    tone?: IconButtonTone
    /** Pressed / current (a toggle that is on, the open panel). */
    active?: boolean
    weight?: 'regular' | 'bold' | 'fill'
    /** @deprecated Use `tone`. Kept for surfaces not yet ported. */
    variant?: keyof typeof legacyVariants
  }
>(function IconButton(
  {
    icon,
    label,
    size = 'md',
    tone = 'default',
    active = false,
    weight,
    variant,
    className = '',
    type = 'button',
    title,
    disabled,
    ...props
  },
  ref
) {
  const tip = title ?? label
  const look = active ? 'bg-surface-2 text-fg-strong' : variant ? legacyVariants[variant] : tones[tone]

  const button = (
    <button
      ref={ref}
      className={cn(
        'inline-grid shrink-0 place-items-center focus-visible:vy-focus-ring',
        interactive,
        sizes[size],
        look,
        className
      )}
      type={type}
      aria-label={label}
      aria-pressed={active || undefined}
      disabled={disabled}
      {...props}
    >
      <Icon name={icon} size={glyphs[size]} weight={weight} />
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
