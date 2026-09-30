import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Icon, type IconName } from '../icons'
import { cn } from './cn'
import { Tooltip } from './Tooltip'

const interactive = 'vy-transition disabled:vy-disabled-state'

/**
 * Tone is how loud the icon is at rest. `default` for an action the row is
 * about, `muted` for secondary chrome (thumbs, attach, dismiss), `inherit`
 * when the caller sets the colour itself — one class, so nothing to override.
 * `onSurface` is `muted` for a button whose base is already `bg-surface`,
 * where that hover fill would not show (HOVER_ON_SURFACE).
 */
const tones = {
  default: 'text-secondary hover:bg-surface hover:text-fg-strong',
  muted: 'text-tertiary hover:bg-surface hover:text-fg',
  onSurface: 'text-tertiary hover:bg-surface-2 hover:text-fg',
  inherit: 'hover:bg-surface'
} as const

/**
 * `xs` draws at 20px but hits at 24px: the `before:` plate reaches 2px past each
 * edge, so a row action or a pair of neighbours still meets WCAG 2.5.8 without
 * the pane header growing. Keep neighbours `gap-1` apart so plates never overlap.
 */
const sizes = {
  xs: 'relative size-5 rounded-sm before:absolute before:-inset-0.5',
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
  }
>(function IconButton(
  {
    icon,
    label,
    size = 'md',
    tone = 'default',
    active = false,
    weight,
    className = '',
    type = 'button',
    title,
    disabled,
    ...props
  },
  ref
) {
  const tip = title ?? label
  const look = active ? 'bg-surface-2 text-fg-strong' : tones[tone]

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
