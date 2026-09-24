import { useEffect, useId, useMemo, useState, type KeyboardEvent, type Ref } from 'react'
import { useRovingTabIndex } from '@renderer/lib/a11y'
import {
  MENU_ROW,
  MENU_ROW_ACTIVE,
  MENU_ROW_IDLE,
  MENU_ROW_TEXT,
  MENU_SURFACE,
  SearchInput,
  cn
} from '@renderer/lib/ui'
import type { SettingsSection } from '../types'
import { SECTION_LABELS } from '../constants'
import {
  filterSettingsSearch,
  scrollToSettingsField,
  type SettingsSearchEntry
} from '../settingsSearchIndex'

/**
 * "Search settings" at the top of the index. `/` focuses it (see
 * SettingsView); the results drop over the section list, and picking one
 * opens its section and flashes the row.
 */
export function SettingsSearch({
  section,
  onSectionChange,
  onRevealField,
  onClose,
  inputRef
}: {
  section: SettingsSection
  onSectionChange: (section: SettingsSection) => void
  /** Expand a nested control (e.g. provider accordion) before scrolling to it. */
  onRevealField?: (fieldId: string) => void
  onClose?: () => void
  inputRef?: Ref<HTMLInputElement>
}) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const listId = useId()
  const matches = useMemo(() => filterSettingsSearch(query), [query])
  const visibleMatches = matches.slice(0, 12)

  useEffect(() => {
    setActiveIndex(visibleMatches.length > 0 ? 0 : -1)
  }, [query, visibleMatches.length])

  const { tabIndexFor, setOptionRef, onContainerKeyDown } = useRovingTabIndex({
    count: visibleMatches.length,
    activeIndex,
    onActiveIndexChange: setActiveIndex,
    orientation: 'vertical',
    loop: true
  })

  const goTo = (entry: SettingsSearchEntry): void => {
    onRevealField?.(entry.id)
    if (entry.section !== section) {
      onSectionChange(entry.section)
      window.setTimeout(() => scrollToSettingsField(entry.id), 100)
    } else {
      scrollToSettingsField(entry.id)
    }
    setQuery('')
  }

  const onSearchKeyDown = (e: KeyboardEvent): void => {
    if (visibleMatches.length > 0 && e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(visibleMatches.length - 1, (i < 0 ? -1 : i) + 1))
      return
    }
    if (visibleMatches.length > 0 && e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, (i < 0 ? 0 : i) - 1))
      return
    }
    if (e.key === 'Enter' && visibleMatches[activeIndex]) {
      e.preventDefault()
      goTo(visibleMatches[activeIndex]!)
      return
    }
    if (e.key === 'Escape') {
      if (query) {
        e.preventDefault()
        setQuery('')
        return
      }
      if (onClose) {
        e.preventDefault()
        onClose()
      }
    }
  }

  return (
    <div className="relative w-full min-w-0">
      <SearchInput
        ref={inputRef}
        size="sm"
        keys={['/']}
        aria-label="Search settings"
        placeholder="Search settings"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onClear={() => setQuery('')}
        aria-controls={query.trim() && visibleMatches.length > 0 ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={
          query.trim() && activeIndex >= 0 && visibleMatches[activeIndex]
            ? `${listId}-opt-${visibleMatches[activeIndex]!.id}`
            : undefined
        }
        onKeyDown={onSearchKeyDown}
      />
      {query.trim() && visibleMatches.length > 0 ? (
        <ul
          id={listId}
          className={cn(MENU_SURFACE, 'absolute inset-x-0 m-0 mt-1 max-h-72 origin-top list-none overflow-auto p-1')}
          role="listbox"
          aria-label="Settings search results"
          onKeyDown={onContainerKeyDown}
        >
          {visibleMatches.map((entry, index) => (
            <li key={entry.id} role="presentation">
              <button
                type="button"
                id={`${listId}-opt-${entry.id}`}
                role="option"
                aria-selected={index === activeIndex}
                ref={setOptionRef(index)}
                tabIndex={tabIndexFor(index)}
                // Focus stays in the search box while arrows move the active
                // option, so the option has to show it itself — the way Menu
                // marks its active row.
                className={cn(MENU_ROW, MENU_ROW_TEXT, index === activeIndex ? MENU_ROW_ACTIVE : MENU_ROW_IDLE)}
                onClick={() => goTo(entry)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className="min-w-0 flex-1 truncate text-xs">{entry.title}</span>
                <span className="shrink-0 text-caption text-tertiary">{SECTION_LABELS[entry.section]}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {query.trim() && matches.length === 0 ? (
        <p className={cn(MENU_SURFACE, 'absolute inset-x-0 m-0 mt-1 px-2 py-1.5 text-xs text-muted')} role="status">
          No matching settings.
        </p>
      ) : null}
    </div>
  )
}
