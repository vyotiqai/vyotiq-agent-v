import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '../icons'
import { prefersReducedMotion } from '../utils/motion'
import { useDropdownMenu } from '../hooks/useDropdownMenu'
import { SearchInput } from './SearchInput'
import { cn } from './cn'
import {
  MENU_LABEL,
  MENU_ROW,
  MENU_ROW_ACTIVE,
  MENU_ROW_DISABLED,
  MENU_ROW_IDLE,
  MENU_ROW_SELECTED,
  MENU_ROW_TEXT,
  MENU_SURFACE,
  selectTriggerClass
} from './menuStyles'

export type MenuOption = {
  value: string
  label: string
  group?: string
  disabled?: boolean
}


export function Menu({
  value,
  options,
  onChange,
  'aria-label': ariaLabel,
  className = '',
  triggerClassName,
  disabled,
  searchable,
  searchPlaceholder = 'Search',
  placement = 'up',
  bare = false,
  quiet = false,
  mono = false,
  icon,
  title
}: {
  value: string
  options: MenuOption[]
  onChange: (value: string) => void
  'aria-label'?: string
  className?: string
  triggerClassName?: string
  disabled?: boolean
  searchable?: boolean
  searchPlaceholder?: string
  placement?: 'up' | 'down'
  /** No outline until hover — toolbars and inline sentences. */
  bare?: boolean
  /** The value is the default: readable, but not asking to be read. */
  quiet?: boolean
  mono?: boolean
  icon?: IconName
  /** Hover text for the trigger, when its value can truncate (a long model id). */
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<Array<HTMLElement | null>>([])
  const listId = useId()
  const selected = options.find((o) => o.value === value)
  const label = selected?.label ?? value
  const showSearch = searchable ?? options.length > 6

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false)
    setQuery('')
    setActiveIndex(-1)
    if (restoreFocus) {
      window.setTimeout(() => triggerRef.current?.focus(), 0)
    }
  }, [])

  const { position } = useDropdownMenu({
    open,
    onOpenChange: (next) => {
      if (!next) closeMenu(false)
      else setOpen(true)
    },
    triggerRef,
    panelRef,
    placement,
    align: 'end',
    disabled,
    trapFocus: true
  })

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) || (o.group?.toLowerCase().includes(q) ?? false)
    )
  }, [options, query])

  const groups = useMemo(() => {
    const map = new Map<string | undefined, MenuOption[]>()
    for (const opt of filtered) {
      const list = map.get(opt.group) ?? []
      list.push(opt)
      map.set(opt.group, list)
    }
    return map
  }, [filtered])

  const pick = useCallback(
    (next: string) => {
      const opt = options.find((o) => o.value === next)
      if (opt?.disabled) return
      onChange(next)
      closeMenu(true)
    },
    [onChange, closeMenu, options]
  )

  useEffect(() => {
    if (!open) return
    if (filtered.length === 0) {
      setActiveIndex(-1)
      return
    }
    setActiveIndex((i) => {
      if (i < 0) {
        const selectedIdx = filtered.findIndex((o) => o.value === value)
        return selectedIdx >= 0 ? selectedIdx : 0
      }
      if (i >= filtered.length) return filtered.length - 1
      return i
    })
  }, [filtered, open, value])

  useEffect(() => {
    if (!open) {
      setQuery('')
      setActiveIndex(-1)
      return
    }
    const t = window.setTimeout(() => {
      if (showSearch) searchRef.current?.focus()
      else listRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(t)
  }, [open, showSearch])

  useEffect(() => {
    if (!open || activeIndex < 0) return
    const el = optionRefs.current[activeIndex]
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    }
  }, [activeIndex, open])

  const moveActive = useCallback(
    (delta: number) => {
      if (filtered.length === 0) return
      setActiveIndex((i) => {
        const base = i < 0 ? (delta > 0 ? -1 : 0) : i
        return (base + delta + filtered.length) % filtered.length
      })
    },
    [filtered.length]
  )

  const onListKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveActive(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveActive(-1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      if (filtered.length) setActiveIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      if (filtered.length) setActiveIndex(filtered.length - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const opt = filtered[activeIndex]
      if (opt) pick(opt.value)
    } else if (e.key === ' ') {
      if (e.target === searchRef.current) return
      e.preventDefault()
      const opt = filtered[activeIndex]
      if (opt) pick(opt.value)
    }
  }

  let flatIndex = -1

  const dropdown =
    open && position ? (
      <div
        ref={panelRef}
        className={cn('fixed', MENU_SURFACE, placement === 'up' ? 'origin-bottom' : 'origin-top')}
        style={{
          top: position.placement === 'up' ? undefined : position.top,
          bottom:
            position.placement === 'up'
              ? window.innerHeight - position.top
              : undefined,
          left: undefined,
          right: window.innerWidth - position.left,
          width: position.width
        }}
        role="presentation"
        onKeyDown={onListKeyDown}
      >
          {showSearch ? (
            <div className="border-b border-border p-1.5">
              <SearchInput
                ref={searchRef}
                inputClassName="min-h-7 text-xs"
                placeholder={searchPlaceholder}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setActiveIndex(0)
                }}
                onKeyDown={onListKeyDown}
                aria-label={searchPlaceholder}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={
                  activeIndex >= 0 && filtered[activeIndex]
                    ? `${listId}-opt-${filtered[activeIndex].value}`
                    : undefined
                }
              />
            </div>
          ) : null}
          <ul
            ref={listRef}
            id={listId}
            className="m-0 max-h-[280px] list-none overflow-auto p-1"
            role="listbox"
            aria-label={ariaLabel}
            tabIndex={showSearch ? -1 : 0}
            aria-activedescendant={
              !showSearch && activeIndex >= 0 && filtered[activeIndex]
                ? `${listId}-opt-${filtered[activeIndex].value}`
                : undefined
            }
            onKeyDown={onListKeyDown}
          >
            {filtered.length === 0 ? (
              <li className="px-2 py-2 text-xs text-muted" role="presentation">
                No matches
              </li>
            ) : (
              [...groups.entries()].flatMap(([group, opts]) => {
                const groupId = group ? `${listId}-group-${group}` : undefined
                const nodes: ReactNode[] = []
                if (group) {
                  nodes.push(
                    <li key={`${group}-label`} role="presentation">
                      <div id={groupId} className={MENU_LABEL}>
                        {group}
                      </div>
                    </li>
                  )
                }
                for (const opt of opts) {
                  flatIndex += 1
                  const index = flatIndex
                  const isSelected = opt.value === value
                  const isActive = index === activeIndex
                  nodes.push(
                    <li
                      key={opt.value}
                      id={`${listId}-opt-${opt.value}`}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={opt.disabled || undefined}
                      tabIndex={-1}
                      ref={(el) => {
                        optionRefs.current[index] = el
                      }}
                      className={cn(
                        MENU_ROW,
                        isActive ? MENU_ROW_ACTIVE : MENU_ROW_IDLE,
                        isSelected ? MENU_ROW_SELECTED : MENU_ROW_TEXT,
                        opt.disabled && MENU_ROW_DISABLED
                      )}
                      onClick={() => {
                        if (!opt.disabled) pick(opt.value)
                      }}
                      onMouseEnter={() => setActiveIndex(index)}
                      onKeyDown={(e) => {
                        if (opt.disabled) return
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          pick(opt.value)
                        }
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                      {isSelected ? (
                        <Icon name="check" size={14} className="shrink-0 text-accent" />
                      ) : (
                        <span className="inline-block size-3.5 shrink-0" aria-hidden />
                      )}
                    </li>
                  )
                }
                return nodes
              })
            )}
          </ul>
        </div>
    ) : null

  return (
    <div className={cn('relative min-w-0', className)} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName ?? selectTriggerClass({ bare, quiet, mono })}
        aria-label={ariaLabel}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            if (!open) {
              e.preventDefault()
              setOpen(true)
            }
          }
        }}
      >
        {icon ? <Icon name={icon} size={14} className="text-muted" /> : null}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <Icon name="chevron" size={12} className="text-tertiary" />
      </button>
      {dropdown ? createPortal(dropdown, document.body) : null}
    </div>
  )
}
