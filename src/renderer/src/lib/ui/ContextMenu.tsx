import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '../icons'
import { cn } from './cn'

export type ContextMenuItem =
  | {
      type?: 'item'
      id: string
      label: string
      icon?: IconName
      shortcut?: string
      disabled?: boolean
      disabledReason?: string
      danger?: boolean
      checked?: boolean
      onSelect: () => void
    }
  | {
      type: 'separator'
      id: string
    }

export type ContextMenuAnchor = {
  x: number
  y: number
}

const VIEWPORT_PADDING = 8
const FALLBACK_WIDTH = 220
const FALLBACK_HEIGHT = 240

function isSelectable(item: ContextMenuItem): item is Exclude<ContextMenuItem, { type: 'separator' }> {
  return item.type !== 'separator' && !item.disabled
}

export function ContextMenu({
  anchor,
  items,
  onClose,
  returnFocusRef,
  shouldRestoreFocus,
  'aria-label': ariaLabel = 'Context menu'
}: {
  anchor: ContextMenuAnchor | null
  items: ContextMenuItem[]
  onClose: () => void
  returnFocusRef?: RefObject<HTMLElement | null>
  shouldRestoreFocus?: () => boolean
  'aria-label'?: string
}) {
  const menuRef = useRef<HTMLUListElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const activeIndexRef = useRef(-1)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [position, setPosition] = useState<ContextMenuAnchor | null>(null)

  const selectableIndices = useMemo(
    () => items.flatMap((item, index) => (isSelectable(item) ? [index] : [])),
    [items]
  )
  activeIndexRef.current = activeIndex

  const close = useCallback((): void => {
    onClose()
    window.setTimeout(() => {
      const target = returnFocusRef?.current
      if (
        !target ||
        !target.isConnected ||
        target.getAttribute('aria-hidden') === 'true' ||
        shouldRestoreFocus?.() === false
      ) {
        return
      }
      target.focus()
    }, 0)
  }, [onClose, returnFocusRef, shouldRestoreFocus])

  const focusIndex = useCallback((index: number): void => {
    setActiveIndex(index)
    window.setTimeout(() => itemRefs.current[index]?.focus(), 0)
  }, [])

  useLayoutEffect(() => {
    if (!anchor) {
      setPosition(null)
      return
    }
    setPosition(anchor)
    const frame = window.requestAnimationFrame(() => {
      const menu = menuRef.current
      if (!menu) return
      const width = menu.offsetWidth || FALLBACK_WIDTH
      const height = menu.offsetHeight || FALLBACK_HEIGHT
      setPosition({
        x: Math.min(
          Math.max(VIEWPORT_PADDING, anchor.x),
          Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING)
        ),
        y: Math.min(
          Math.max(VIEWPORT_PADDING, anchor.y),
          Math.max(VIEWPORT_PADDING, window.innerHeight - height - VIEWPORT_PADDING)
        )
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [anchor, items.length])

  useEffect(() => {
    if (!anchor) return
    const first = selectableIndices[0] ?? -1
    setActiveIndex(first)
    const timer = window.setTimeout(() => {
      if (first >= 0) itemRefs.current[first]?.focus()
      else menuRef.current?.focus()
    }, 0)
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && !menuRef.current?.contains(target)) close()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (selectableIndices.length === 0) return
      const current = Math.max(0, selectableIndices.indexOf(activeIndexRef.current))
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        const next = selectableIndices[(current + delta + selectableIndices.length) % selectableIndices.length]
        if (next != null) focusIndex(next)
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        focusIndex(
          event.key === 'Home'
            ? selectableIndices[0]!
            : selectableIndices[selectableIndices.length - 1]!
        )
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        const item = items[activeIndexRef.current]
        if (isSelectable(item)) {
          item.onSelect()
          close()
        }
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [anchor, close, focusIndex, items, selectableIndices])

  if (!anchor || !position) return null

  return createPortal(
    <ul
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      className="app-region-no-drag fixed z-dropdown m-0 min-w-[12rem] max-w-[min(20rem,calc(100vw-1rem))] list-none overflow-auto rounded-md border border-border bg-card p-1 shadow-menu animate-menu-in origin-top"
      style={{
        left: position.x,
        top: position.y,
        maxHeight: 'calc(100vh - 1rem)'
      }}
    >
      {items.map((item, index) =>
        item.type === 'separator' ? (
          <li key={item.id} role="separator" className="my-1 border-t border-border/60" />
        ) : (
          <li key={item.id} role="none">
            <button
              ref={(element) => {
                itemRefs.current[index] = element
              }}
              type="button"
              role={item.checked == null ? 'menuitem' : 'menuitemcheckbox'}
              aria-label={item.label}
              aria-disabled={item.disabled || undefined}
              aria-checked={item.checked == null ? undefined : item.checked}
              aria-describedby={
                item.disabled && item.disabledReason
                  ? `context-menu-reason-${item.id}`
                  : undefined
              }
              title={item.disabled ? item.disabledReason : undefined}
              className={cn(
                'flex min-h-8 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs leading-5 outline-none focus-visible:vy-focus-ring vy-transition',
                item.disabled
                  ? 'cursor-not-allowed text-muted/60'
                  : item.danger
                    ? 'text-danger hover:bg-danger/10'
                    : 'text-fg hover:bg-surface',
                index === activeIndex && !item.disabled && 'bg-surface'
              )}
              disabled={item.disabled}
              onMouseEnter={() => {
                if (!item.disabled) setActiveIndex(index)
              }}
              onClick={() => {
                if (item.disabled) return
                item.onSelect()
                close()
              }}
            >
              {item.icon ? <Icon name={item.icon} size={16} className="shrink-0" /> : null}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.checked ? <Icon name="check" size={16} className="shrink-0" /> : null}
              {item.shortcut ? (
                <span className="shrink-0 text-caption text-muted">{item.shortcut}</span>
              ) : null}
              {item.disabled && item.disabledReason ? (
                <span id={`context-menu-reason-${item.id}`} className="sr-only">
                  Unavailable: {item.disabledReason}
                </span>
              ) : null}
            </button>
          </li>
        )
      )}
    </ul>,
    document.body
  )
}
