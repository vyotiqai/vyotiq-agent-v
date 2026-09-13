import { type ReactNode, type Ref } from 'react'
import { Icon, type IconName } from '../icons'
import { SIDEBAR_NAV_ACTIVE } from '@renderer/lib/utils/layout'
import { cn } from './cn'
import { Tooltip } from './Tooltip'

export function NavItem({
  label,
  icon,
  active,
  onClick,
  current,
  pressed,
  disabled,
  title,
  variant = 'sidebar',
  className = '',
  trailing,
  dense,
  buttonRef,
  'aria-expanded': ariaExpanded,
  'aria-haspopup': ariaHasPopup,
  'aria-controls': ariaControls,
  'aria-label': ariaLabel
}: {
  label: string
  icon?: IconName
  active?: boolean
  onClick: () => void
  current?: boolean
  pressed?: boolean
  disabled?: boolean
  title?: string
  variant?: 'sidebar' | 'settings' | 'icon'
  className?: string
  trailing?: ReactNode
  /** Slightly tighter padding for dense lists. */
  dense?: boolean
  buttonRef?: Ref<HTMLButtonElement>
  'aria-expanded'?: boolean
  'aria-haspopup'?: 'menu' | 'dialog' | boolean
  'aria-controls'?: string
  'aria-label'?: string
}) {
  const isActive = active ?? current

  if (variant === 'icon') {
    const button = (
      <button
        ref={buttonRef}
        type="button"
        className={cn(
          'app-region-no-drag relative inline-grid size-8 place-items-center rounded-lg vy-transition focus-visible:vy-focus-ring',
          'disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]',
          isActive ? SIDEBAR_NAV_ACTIVE : 'text-secondary hover:bg-surface/60 hover:text-fg active:bg-surface',
          className
        )}
        aria-label={ariaLabel ?? label}
        aria-current={isActive ? 'page' : undefined}
        aria-pressed={pressed}
        aria-expanded={ariaExpanded}
        aria-haspopup={ariaHasPopup}
        aria-controls={ariaControls}
        disabled={disabled}
        onClick={onClick}
      >
        {icon ? <Icon name={icon} size={18} weight={isActive ? 'fill' : 'bold'} /> : null}
        {trailing}
      </button>
    )
    // Disabled buttons ignore pointer events — wrap so hover still shows why.
    if (disabled) {
      return (
        <Tooltip content={title ?? label}>
          <span className="inline-grid cursor-not-allowed" aria-disabled="true">
            {button}
          </span>
        </Tooltip>
      )
    }
    return <Tooltip content={title ?? label}>{button}</Tooltip>
  }

  const button = (
    <button
      ref={buttonRef}
      type="button"
      className={cn(
        'app-region-no-drag rounded-lg text-left text-sm tracking-[var(--vy-tracking-tight)] vy-transition focus-visible:vy-focus-ring',
        'disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)] disabled:hover:bg-transparent disabled:hover:text-secondary',
        dense ? 'px-2 py-1.5' : 'px-2.5 py-2',
        variant === 'sidebar'
          ? 'flex w-full items-center gap-2'
          : variant === 'settings'
            ? 'inline-flex shrink-0 items-center gap-2 sm:flex sm:w-full'
            : 'shrink-0 sm:w-full',
        isActive ? SIDEBAR_NAV_ACTIVE : 'text-secondary hover:bg-surface/50 hover:text-fg active:bg-surface',
        className
      )}
      aria-label={ariaLabel}
      aria-current={isActive ? 'page' : undefined}
      aria-pressed={pressed}
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaHasPopup}
      aria-controls={ariaControls}
      disabled={disabled}
      onClick={onClick}
    >
      {icon ? (
        <Icon
          name={icon}
          size={18}
          weight={isActive ? 'fill' : 'bold'}
          className="shrink-0"
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  )
  // Disabled buttons ignore pointer events — wrap so hover still shows why.
  if (disabled) {
    return (
      <Tooltip content={title ?? label}>
        <span className="inline-flex cursor-not-allowed" aria-disabled="true">
          {button}
        </span>
      </Tooltip>
    )
  }
  return <Tooltip content={title ?? label}>{button}</Tooltip>
}
