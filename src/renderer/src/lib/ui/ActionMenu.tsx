import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '../icons'
import { prefersReducedMotion } from '../utils/motion'
import { useDropdownMenu } from '../hooks/useDropdownMenu'
import { cn } from './cn'

export type ActionMenuItem = {
  id: string
  label: string
  icon?: IconName
  /**
   * Render as a checkable toggle: reserves the check column, shows a check
   * glyph when true, and exposes role/aria-checked. Omit for plain actions.
   */
  checked?: boolean
  onSelect: () => void
}

const optionClass = cn(
  'flex w-full cursor-pointer items-center gap-2 rounded-md bg-transparent px-2.5 py-1.5 text-left text-sm text-fg',
  'hover:bg-surface active:bg-surface-2 vy-transition'
)

export function ActionMenu({
  trigger,
  items,
  open,
  onOpenChange,
  placement = 'up',
  align = 'start',
  'aria-label': ariaLabel
}: {
  trigger: (props: {
    ref: React.RefObject<HTMLButtonElement | null>
    'aria-expanded': boolean
    'aria-controls': string
    'aria-haspopup': 'menu'
    onClick: () => void
  }) => ReactNode
  items: ActionMenuItem[]
  open: boolean
  onOpenChange: (open: boolean) => void
  placement?: 'up' | 'down'
  align?: 'start' | 'end'
  'aria-label'?: string
}) {
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [activeIndex, setActiveIndex] = useState(-1)

  const { position, close } = useDropdownMenu({
    open,
    onOpenChange,
    triggerRef,
    panelRef: listRef,
    placement,
    align,
    trapFocus: true
  })

  useEffect(() => {
    if (!open) return
    setActiveIndex(items.length ? 0 : -1)
    const t = window.setTimeout(() => listRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open, items.length])

  useEffect(() => {
    if (!open || activeIndex < 0) return
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined
    el?.scrollIntoView?.({
      block: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth'
    })
  }, [activeIndex, open])

  const onListKeyDown = (e: ReactKeyboardEvent): void => {
    if (items.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % items.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (i - 1 + items.length) % items.length)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActiveIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActiveIndex(items.length - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const item = items[activeIndex]
      if (item) {
        item.onSelect()
        close(true)
      }
    }
  }

  const menu =
    open && position ? (
      <ul
        ref={listRef}
        id={menuId}
        role="menu"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={cn(
          'app-region-no-drag fixed z-dropdown m-0 list-none overflow-hidden rounded-md border border-border bg-card p-1 shadow-menu animate-menu-in',
          placement === 'up' ? 'origin-bottom' : 'origin-top'
        )}
        style={{
          top: position.placement === 'up' ? undefined : position.top,
          bottom:
            position.placement === 'up'
              ? window.innerHeight - position.top
              : undefined,
          // End-align via `right` only — do not also translateX(-100%), which
          // double-shifts the panel.
          left: align === 'end' ? undefined : position.left,
          right: align === 'end' ? window.innerWidth - position.left : undefined,
          minWidth: position.minWidth
        }}
        onKeyDown={onListKeyDown}
      >
        {items.map((item, index) => (
          <li key={item.id} role="none">
            <button
              type="button"
              role={item.checked != null ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={item.checked != null ? item.checked : undefined}
              className={cn(optionClass, index === activeIndex && 'bg-surface')}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => {
                item.onSelect()
                close(true)
              }}
            >
              {item.checked != null ? (
                item.checked ? (
                  <Icon name="check" size={16} className="shrink-0" />
                ) : (
                  <span className="inline-block w-4 shrink-0" aria-hidden />
                )
              ) : item.icon ? (
                <Icon name={item.icon} size={16} />
              ) : null}
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    ) : null

  return (
    <>
      {trigger({
        ref: triggerRef,
        'aria-expanded': open,
        'aria-controls': menuId,
        'aria-haspopup': 'menu',
        onClick: () => onOpenChange(!open)
      })}
      {menu ? createPortal(menu, document.body) : null}
    </>
  )
}
