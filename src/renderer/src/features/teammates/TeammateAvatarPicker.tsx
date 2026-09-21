import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Avatar, cn } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import { useDropdownMenu } from '@renderer/lib/hooks/useDropdownMenu'
import { TEAMMATE_AVATARS } from './teammatePresentation'

/**
 * The avatar, picked from the name field rather than beside it.
 *
 * Laid out inline, the picker is twenty-one identical squares across two rows —
 * the largest and loudest control in the form, for the field that matters
 * least. Behind the chip it becomes what it is: an attribute of the name.
 */
export function TeammateAvatarPicker({
  name,
  value,
  onChange,
  disabled
}: {
  /** Drives the initial shown when no icon is chosen. */
  name: string
  value: string | undefined
  onChange: (next: string | undefined) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const { position, close } = useDropdownMenu({
    open,
    onOpenChange: setOpen,
    triggerRef,
    panelRef,
    placement: 'down',
    align: 'start',
    disabled,
    trapFocus: true,
    autoFocusFirst: true
  })

  const pick = (next: string | undefined): void => {
    onChange(next)
    close(true)
  }

  const cell = (active: boolean): string =>
    cn(
      'grid size-8 place-items-center rounded-md border text-2xs font-semibold vy-transition',
      'focus-visible:vy-focus-ring',
      active
        ? 'border-accent bg-accent/10 text-accent'
        : 'border-transparent text-muted hover:bg-surface-2 hover:text-fg'
    )

  const panel =
    open && position ? (
      <div
        ref={panelRef}
        className="fixed z-dropdown rounded-lg border border-border bg-card p-2 shadow-menu animate-menu-in"
        style={{
          top: position.placement === 'up' ? undefined : position.top,
          bottom: position.placement === 'up' ? window.innerHeight - position.top : undefined,
          left: position.left
        }}
      >
        <div className="grid grid-cols-7 gap-1" role="group" aria-label="Avatar">
          <button
            type="button"
            aria-label="No avatar"
            aria-pressed={!value}
            className={cell(!value)}
            onClick={() => pick(undefined)}
          >
            {(name.trim().slice(0, 1) || '?').toUpperCase()}
          </button>
          {TEAMMATE_AVATARS.map((icon) => (
            <button
              key={icon}
              type="button"
              aria-label={icon}
              aria-pressed={value === icon}
              className={cell(value === icon)}
              onClick={() => pick(icon)}
            >
              <Icon name={icon} size={16} />
            </button>
          ))}
        </div>
      </div>
    ) : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Change avatar"
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Change avatar"
        disabled={disabled}
        className={cn(
          'inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-surface p-1 pr-1',
          'hover:border-border-strong hover:bg-surface-2 focus-visible:vy-focus-ring',
          'disabled:vy-disabled-state vy-transition'
        )}
        onClick={() => setOpen(!open)}
      >
        <Avatar name={name} icon={value} size="md" />
        <Icon name="chevron" size={12} className="text-muted" />
      </button>
      {panel ? createPortal(panel, document.body) : null}
    </>
  )
}
