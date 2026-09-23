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
import { MENU_ROW, MENU_ROW_ACTIVE, MENU_ROW_IDLE, MENU_ROW_TEXT, MENU_SEPARATOR, MENU_SURFACE } from './menuStyles'

export type ActionMenuItem = {
  id: string
  label: string
  icon?: IconName
  /**
   * Render as a checkable toggle: reserves the check column, shows a check
   * glyph when true, and exposes role/aria-checked. Omit for plain actions.
   */
  checked?: boolean
  /** Draw a rule above this item — to set apart an action from a list of choices. */
  separatorBefore?: boolean
  onSelect: () => void
}

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
          'app-region-no-drag fixed m-0 list-none p-1',
          MENU_SURFACE,
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
            {item.separatorBefore ? <div role="separator" className={MENU_SEPARATOR} /> : null}
            <button
              type="button"
              role={item.checked != null ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={item.checked != null ? item.checked : undefined}
              className={cn(MENU_ROW, MENU_ROW_TEXT, index === activeIndex ? MENU_ROW_ACTIVE : MENU_ROW_IDLE)}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => {
                item.onSelect()
                close(true)
              }}
            >
              {item.checked != null ? (
                item.checked ? (
                  <Icon name="check" size={15} className="shrink-0 text-accent" />
                ) : (
                  <span className="inline-block w-[15px] shrink-0" aria-hidden />
                )
              ) : item.icon ? (
                <Icon name={item.icon} size={15} className="text-muted" />
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
