import { useEffect, useMemo, useState } from 'react'
import { Avatar, Badge, SearchInput, cn } from '@renderer/lib/ui'
import { useRovingTabIndex } from '@renderer/lib/a11y/useRovingTabIndex'
import { Icon } from '@renderer/lib/icons'
import { SIDEBAR_NAV_ACTIVE, TEAMMATES_RAIL_WIDTH } from '@renderer/lib/utils/layout'
import type { AgentProfile, DelegatedTask } from '@shared/ipc'
import { activeWorkSummary } from './taskPresentation'
import { isProfileUsableIn, profileScopeLabel } from './teammatePresentation'

/**
 * The one navigation this pane has.
 *
 * Teammates used to carry two: a Roster/Tasks tab pair in the page header, and
 * a Tasks section inside the roster's detail. Neither was authoritative and the
 * queue was reachable from both. The rail replaces both — the task inbox is a
 * row above the roster, a teammate is a row in it, and whatever is selected
 * fills the detail pane beside it.
 *
 * It does not scroll with the detail, so the teammate being edited and the one
 * about to be switched to are on screen at the same time.
 */
export function TeammateRail({
  profiles,
  tasks,
  ready,
  selectedId,
  rosterActive,
  inboxActive,
  query,
  onQuery,
  onSelect,
  onOpenInbox,
  onCreate,
  activeWorkspacePath
}: {
  /** Already filtered by `query` — the rail renders what it is given. */
  profiles: AgentProfile[]
  /** Every task across open workspaces, for the inbox badge and row counts. */
  tasks: DelegatedTask[]
  ready: boolean
  selectedId: string | null
  /** A teammate is what the detail pane is showing (rather than the inbox). */
  rosterActive: boolean
  inboxActive: boolean
  query: string
  onQuery: (next: string) => void
  onSelect: (id: string) => void
  onOpenInbox: () => void
  onCreate: () => void
  activeWorkspacePath: string | null
}) {
  const selectedIndex = Math.max(
    0,
    profiles.findIndex((p) => p.id === selectedId)
  )
  const [activeIndex, setActiveIndex] = useState(selectedIndex)
  // Selection can move without the keyboard — a create, a delete, or another
  // surface pushing a roster change — so the roving focus follows it.
  useEffect(() => setActiveIndex(selectedIndex), [selectedIndex])

  const { tabIndexFor, setOptionRef, onContainerKeyDown } = useRovingTabIndex({
    count: profiles.length,
    activeIndex,
    onActiveIndexChange: setActiveIndex,
    // A listbox selects as it moves, so arrowing through the roster shows each
    // teammate rather than needing a second keypress to open it.
    onSelect: (index) => {
      const next = profiles[index]
      if (next) onSelect(next.id)
    }
  })

  // One pass over the queue rather than a filter per row: the inbox badge and
  // every roster row read from the same grouping.
  const byProfile = useMemo(() => {
    const map = new Map<string, DelegatedTask[]>()
    for (const task of tasks) {
      const bucket = map.get(task.profileId)
      if (bucket) bucket.push(task)
      else map.set(task.profileId, [task])
    }
    return map
  }, [tasks])

  const inbox = activeWorkSummary(tasks)

  // Nothing to search and nothing typed: the field is a dead control above an
  // empty list, and the detail pane carries the call to action that works.
  const searchable = profiles.length > 0 || query.trim().length > 0

  return (
    <nav
      className={cn('flex shrink-0 flex-col border-r border-border/60', TEAMMATES_RAIL_WIDTH)}
      aria-label="Teammates"
      data-teammates-rail
    >
      <div className="flex shrink-0 flex-col gap-1.5 px-3 pb-2 pt-3">
        {searchable ? (
          <SearchInput
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onClear={() => onQuery('')}
            placeholder="Search teammates"
            aria-label="Search teammates"
            tone="quiet"
          />
        ) : null}

        <button
          type="button"
          aria-label="All tasks"
          aria-current={inboxActive ? 'page' : undefined}
          className={cn(
            'flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm vy-transition',
            'focus-visible:vy-focus-ring',
            inboxActive ? SIDEBAR_NAV_ACTIVE : 'text-secondary hover:bg-surface hover:text-fg'
          )}
          onClick={onOpenInbox}
        >
          <Icon name="listTodo" size={16} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">All tasks</span>
          {inbox.active ? (
            <Badge tone="accent" dot={inbox.running > 0} title={inbox.label ?? undefined}>
              {inbox.active}
            </Badge>
          ) : null}
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
        <div className="flex shrink-0 items-center justify-between gap-2 px-2 pb-1 pt-1">
          <span className="text-2xs font-medium uppercase tracking-[var(--vy-tracking-caps)] text-tertiary">
            Teammates
          </span>
          <button
            type="button"
            aria-label="New teammate"
            title="Create a teammate"
            className="-mr-1 inline-grid size-5 place-items-center rounded text-muted vy-transition hover:bg-surface hover:text-fg focus-visible:vy-focus-ring"
            onClick={onCreate}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>

        {profiles.length === 0 ? (
          <p className="m-0 px-2 py-3 text-2xs leading-snug text-muted">
            {!ready ? 'Loading…' : query.trim() ? 'No teammate matches that.' : 'No teammates yet.'}
          </p>
        ) : (
          <div
            className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto"
            role="listbox"
            aria-label="Teammates"
            tabIndex={-1}
            onKeyDown={onContainerKeyDown}
          >
            {profiles.map((profile, index) => {
              const selected = profile.id === selectedId
              const showing = selected && rosterActive
              const scope = profileScopeLabel(profile)
              const usable = isProfileUsableIn(profile, activeWorkspacePath)
              const work = activeWorkSummary(byProfile.get(profile.id) ?? [])
              // One line under the name, and live work outranks a description
              // that never changes.
              const subtitle = work.label ?? profile.persona ?? null
              return (
                <button
                  key={profile.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  ref={setOptionRef(index)}
                  tabIndex={tabIndexFor(index)}
                  className={cn(
                    'flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left vy-transition',
                    'focus-visible:vy-focus-ring',
                    showing
                      ? SIDEBAR_NAV_ACTIVE
                      : selected
                        ? 'bg-surface/40 text-fg'
                        : 'hover:bg-surface/30'
                  )}
                  onClick={() => onSelect(profile.id)}
                >
                  <Avatar
                    name={profile.name}
                    icon={profile.avatar}
                    size="md"
                    tone={usable ? 'accent' : 'muted'}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm text-fg">{profile.name}</span>
                    {subtitle ? (
                      <span
                        className={cn('truncate text-2xs', work.label ? 'text-accent' : 'text-muted')}
                      >
                        {subtitle}
                      </span>
                    ) : null}
                  </span>
                  {work.active ? (
                    <span
                      className={cn(
                        'size-1.5 shrink-0 rounded-full',
                        work.running ? 'bg-accent' : 'bg-muted'
                      )}
                      aria-hidden
                    />
                  ) : scope ? (
                    <Badge
                      tone={usable ? 'neutral' : 'warning'}
                      title={
                        usable
                          ? `Only available in ${scope}`
                          : `Belongs to ${scope} — cannot run in the workspace you have open`
                      }
                    >
                      {scope}
                    </Badge>
                  ) : null}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </nav>
  )
}
