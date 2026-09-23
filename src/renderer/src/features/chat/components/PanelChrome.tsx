import { useId, useRef, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@renderer/lib/icons'
import { useDropdownMenu } from '@renderer/lib/hooks/useDropdownMenu'
import { Tooltip, cn } from '@renderer/lib/ui'

/** Dock panel toolbar row — menus portaled; must not clip dropdowns. */
export const DOCK_PANEL_TOOLBAR =
  'relative z-dropdown flex min-h-8 min-w-0 shrink-0 flex-wrap items-center gap-1.5 overflow-visible border-b border-border/60 bg-bg px-2 py-0.5'

/** In-panel secondary tab row — matches {@link DockTabBar} pill tabs. */
export const PANEL_SUBTAB_BAR =
  'flex min-w-0 shrink-0 items-center gap-1 border-b border-border/60 px-2 py-0.5'

export function panelSubtabClass(selected: boolean): string {
  return cn(
    'inline-flex h-7 max-w-[12rem] shrink-0 items-center rounded-md px-2.5 text-xs leading-tight vy-transition focus-visible:vy-focus-ring',
    selected
      ? 'bg-surface font-medium text-fg shadow-sm'
      : 'bg-surface/25 text-secondary hover:bg-surface hover:text-fg'
  )
}

/** Open dock / editor tab pill shell — every open tab reads as a tab at rest. */
export function dockPanelTabShellClass(selected: boolean, closable: boolean): string {
  return cn(
    'group inline-flex h-7 max-w-[12rem] shrink-0 items-center gap-0.5 rounded-md vy-transition',
    selected ? 'bg-surface shadow-sm' : 'bg-surface/25 hover:bg-surface',
    closable ? 'pl-2.5 pr-1' : 'px-2.5'
  )
}

export function dockPanelTabButtonClass(selected: boolean): string {
  return cn(
    'inline-flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md text-xs leading-tight focus-visible:vy-focus-ring',
    selected ? 'font-medium text-fg' : 'text-secondary hover:text-fg'
  )
}

export function dockPanelTabCloseClass(selected: boolean): string {
  return cn(
    'inline-grid size-5 shrink-0 place-items-center rounded-md focus-visible:opacity-100 focus-visible:vy-focus-ring',
    selected
      ? 'opacity-70 hover:bg-surface-2 hover:opacity-100'
      : 'opacity-0 hover:bg-surface-2 group-hover:opacity-100 group-focus-within:opacity-100'
  )
}

/**
 * Middle-click close for tab shells — mousedown swallows Chromium autoscroll,
 * auxclick button 1 closes. Spread onto closable tab shells only.
 */
export function tabMiddleClickHandlers(onClose: () => void): {
  onMouseDown: (e: ReactMouseEvent) => void
  onAuxClick: (e: ReactMouseEvent) => void
} {
  return {
    onMouseDown: (e) => {
      if (e.button === 1) e.preventDefault()
    },
    onAuxClick: (e) => {
      if (e.button !== 1) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }
}

/** Portaled toolbar menu — escapes panel overflow and stacks above content. */
export function PanelToolbarDropdown({
  open,
  onOpenChange,
  trigger,
  children,
  placement = 'down',
  align = 'start',
  minWidthPx = 208,
  'aria-label': ariaLabel,
  panelClassName
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: (props: {
    ref: RefObject<HTMLButtonElement | null>
    'aria-expanded': boolean
    'aria-controls': string
    onClick: () => void
  }) => ReactNode
  children: ReactNode
  placement?: 'up' | 'down'
  align?: 'start' | 'end'
  minWidthPx?: number
  'aria-label'?: string
  panelClassName?: string
}) {
  const panelId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const { position } = useDropdownMenu({
    open,
    onOpenChange,
    triggerRef,
    panelRef,
    placement,
    align
  })

  const menu =
    open && position ? (
      <div
        ref={panelRef}
        id={panelId}
        role="menu"
        aria-label={ariaLabel}
        className={cn(
          'app-region-no-drag fixed z-dropdown overflow-visible rounded-md border border-border bg-card py-1 shadow-menu animate-menu-in',
          placement === 'up' ? 'origin-bottom' : 'origin-top',
          panelClassName
        )}
        style={{
          top: position.placement === 'up' ? undefined : position.top,
          bottom:
            position.placement === 'up'
              ? window.innerHeight - position.top
              : undefined,
          left: align === 'end' ? undefined : position.left,
          right: align === 'end' ? window.innerWidth - position.left : undefined,
          minWidth: Math.max(position.minWidth, minWidthPx)
        }}
      >
        {children}
      </div>
    ) : null

  return (
    <>
      {trigger({
        ref: triggerRef,
        'aria-expanded': open,
        'aria-controls': panelId,
        onClick: () => onOpenChange(!open)
      })}
      {menu ? createPortal(menu, document.body) : null}
    </>
  )
}

/** Icon-only dock launcher — compact at rest, subtle lift on hover. */
export const DOCK_QUICK_LAUNCH_BTN =
  'inline-grid size-7 shrink-0 place-items-center rounded-md text-secondary vy-transition focus-visible:vy-focus-ring hover:bg-surface hover:text-fg hover:shadow-sm motion-safe:transition-transform motion-safe:duration-150 motion-safe:hover:-translate-y-px motion-safe:hover:scale-105 active:translate-y-0 active:scale-100'

/** Shared hover lift for dock chrome icon buttons (expand/collapse). */
export const DOCK_CHROME_ICON_HOVER =
  'motion-safe:transition-transform motion-safe:duration-150 motion-safe:hover:-translate-y-px motion-safe:hover:scale-105 hover:bg-surface hover:text-fg hover:shadow-sm active:scale-100'

/** Compact dock toolbar control — avoids Button's min-h-8 base. */
export const DOCK_TOOLBAR_BTN =
  'inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-md border border-border bg-surface px-2 text-caption leading-none text-fg hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]'

export const DOCK_TOOLBAR_ICON_BTN =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-caption leading-none text-muted hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]'

/** Single-border split control so primary + chevron share one height box. */
export function DockSplitButton({
  className,
  primaryClassName,
  menuClassName,
  primaryLabel,
  primaryIcon,
  primaryDisabled,
  onPrimaryClick,
  menuOpen,
  onMenuToggle,
  menuAriaLabel,
  menu
}: {
  className?: string
  primaryClassName?: string
  menuClassName?: string
  primaryLabel: ReactNode
  primaryIcon?: ReactNode
  primaryDisabled?: boolean
  onPrimaryClick: () => void
  menuOpen: boolean
  onMenuToggle: () => void
  menuAriaLabel: string
  menu?: ReactNode
}) {
  return (
    <div className={cn('relative inline-flex shrink-0', className)}>
      <div className="inline-flex h-6 overflow-hidden rounded-md border border-border bg-surface">
        <button
          type="button"
          className={cn(
            'inline-flex h-full items-center gap-1 px-2 text-caption leading-none text-fg hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]',
            primaryClassName
          )}
          disabled={primaryDisabled}
          onClick={onPrimaryClick}
        >
          {primaryIcon}
          <span className="whitespace-nowrap">{primaryLabel}</span>
        </button>
        <Tooltip content={menuAriaLabel}>
          <button
            type="button"
            className={cn(
              'inline-flex h-full w-6 shrink-0 items-center justify-center border-l border-border text-muted hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]',
              menuClassName
            )}
            disabled={primaryDisabled}
            aria-label={menuAriaLabel}
            aria-expanded={menuOpen}
            onClick={onMenuToggle}
          >
            <Icon name="chevron" size={10} />
          </button>
        </Tooltip>
      </div>
      {menu}
    </div>
  )
}

export function EmptyPanel({
  icon,
  title,
  body,
  actions,
  centered = false
}: {
  icon: 'terminal' | 'file' | 'branch' | 'pullRequest' | 'stack' | 'listTodo' | 'doc'
  title: string
  body: string
  actions?: ReactNode
  /** Fill a flex parent and center vertically (use with `flex flex-col` on the parent). */
  centered?: boolean
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center px-6 text-center',
        centered ? 'min-h-0 flex-1' : 'h-full'
      )}
    >
      <Icon name={icon} size={28} className="mb-3 text-muted/70" />
      <p className="text-xs font-medium text-fg/80">{title}</p>
      <p className="mt-1 max-w-[16rem] text-caption leading-relaxed text-muted">{body}</p>
      {actions ? (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">{actions}</div>
      ) : null}
    </div>
  )
}
