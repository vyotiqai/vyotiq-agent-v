import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react'
import { useRovingTabIndex } from '@renderer/lib/a11y'
import { SearchInput } from '@renderer/lib/ui'
import type { SettingsSection } from '../types'
import { SECTION_LABELS } from '../constants'
import {
  filterSettingsSearch,
  scrollToSettingsField,
  type SettingsSearchEntry
} from '../settingsSearchIndex'

export function SettingsSearch({
  section,
  onSectionChange,
  onRevealField,
  onClose
}: {
  section: SettingsSection
  onSectionChange: (section: SettingsSection) => void
  /** Expand a nested control (e.g. provider accordion) before scrolling to it. */
  onRevealField?: (fieldId: string) => void
  onClose?: () => void
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
    <div className="relative min-w-0 w-full max-w-xl">
      <SearchInput
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
          className="absolute z-dropdown m-0 mt-1 max-h-56 w-full list-none overflow-auto rounded-md border border-border bg-card p-1 shadow-menu animate-menu-in origin-top"
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
                className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-fg hover:bg-surface-2"
                onClick={() => goTo(entry)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className="min-w-0 truncate">{entry.title}</span>
                <span className="shrink-0 text-muted">{SECTION_LABELS[entry.section].title}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {query.trim() && matches.length === 0 ? (
        <p
          className="absolute z-dropdown m-0 mt-1 w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs text-muted shadow-menu"
          role="status"
        >
          No matching settings.
        </p>
      ) : null}
    </div>
  )
}
