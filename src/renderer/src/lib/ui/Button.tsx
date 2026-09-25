import { type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react'
import { Icon, type IconName } from '../icons'
import { cn } from './cn'
import { Keys } from './Kbd'
import { Tooltip } from './Tooltip'

const interactive = 'vy-transition disabled:vy-disabled-state'

export const buttonVariants = {
  /** One per surface: the action the surface exists for. */
  primary: 'rounded-md bg-accent text-accent-fg hover:bg-accent-hover',
  /** Outlined: a real action that is not the point of the surface. */
  secondary: 'rounded-md border border-border bg-bg text-fg hover:border-border-strong hover:bg-surface',
  /** No chrome until hover: toolbars, dense rows. */
  ghost: 'rounded-md text-secondary hover:bg-surface hover:text-fg-strong',
  /** Destructive, quiet at rest. */
  danger: 'rounded-md border border-border bg-bg text-danger hover:border-danger hover:bg-danger-soft',
  /** Legacy name for `secondary`, kept until its last caller is ported. */
  subtle: 'rounded-md border border-border bg-bg text-fg hover:border-border-strong hover:bg-surface'
} as const

export type ButtonVariant = keyof typeof buttonVariants

const buttonSizes = {
  xs: 'h-6 px-2 text-caption',
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-8 px-3 text-sm'
} as const

export type ButtonSize = keyof typeof buttonSizes

const iconSizes: Record<ButtonSize, number> = { xs: 13, sm: 14, md: 16 }

/**
 * The geometry every button had before sizes existed. A caller that passes no
 * `size` gets exactly this, so its own `min-h-*`/`px-*` classes keep working
 * until that surface is ported — `cn()` cannot override a size's `h-7`.
 */
const legacyGeometry =
  'min-h-[var(--vy-control-min-h)] gap-[var(--vy-control-gap)] px-[var(--vy-control-px)] text-sm'

const base =
  'inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium focus-visible:vy-focus-ring'

export function Button({
  variant = 'secondary',
  size,
  icon,
  trailingIcon,
  kbd,
  children,
  className = '',
  type = 'button',
  pending = false,
  disabled,
  ref,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  /** React 19 passes refs as a plain prop. */
  ref?: Ref<HTMLButtonElement>
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: IconName
  trailingIcon?: IconName
  /** Its shortcut, shown as keycaps after the label. Never on a primary button. */
  kbd?: string[]
  children?: ReactNode
  /** Disables the control and marks it busy for assistive tech. */
  pending?: boolean
}) {
  const isDisabled = Boolean(disabled || pending)
  const why = isDisabled && typeof props.title === 'string' ? props.title : ''
  const glyph = iconSizes[size ?? 'md']

  const button = (
    <button
      ref={ref}
      className={cn(
        base,
        size ? cn('gap-1.5', buttonSizes[size]) : legacyGeometry,
        buttonVariants[variant],
        interactive,
        className
      )}
      type={type}
      disabled={isDisabled}
      aria-busy={pending || undefined}
      aria-disabled={isDisabled || undefined}
      {...props}
      title={why ? undefined : props.title}
    >
      {icon ? <Icon name={icon} size={glyph} /> : null}
      {children}
      {trailingIcon ? <Icon name={trailingIcon} size={glyph - 2} className="opacity-70" /> : null}
      {kbd && variant !== 'primary' ? <Keys keys={kbd} className="ml-0.5" /> : null}
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
