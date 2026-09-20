import { useEffect, useState } from 'react'
import { Avatar, Badge, Button, EmptyState, SearchInput, cn } from '@renderer/lib/ui'
import { useRovingTabIndex } from '@renderer/lib/a11y/useRovingTabIndex'
import type { AgentProfile } from '@shared/ipc'
import { isProfileUsableIn, profileScopeLabel } from './teammatePresentation'

/**
 * The roster list: every teammate, with enough on each row to choose between
 * them — avatar, name, whether it is limited to one workspace, and whether it
 * can be used where you are standing right now.
 */
export function TeammateRoster({
  profiles,
  ready,
  selectedId,
  query,
  onQuery,
  onSelect,
  onCreate,
  activeWorkspacePath
}: {
  profiles: AgentProfile[]
  ready: boolean
  selectedId: string | null
  query: string
  onQuery: (next: string) => void
  onSelect: (id: string) => void
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

  // Nothing to search and nothing typed: the field and the New button beside
  // it are two dead controls stacked above the empty state's call to action,
  // which is the only one of the three that does anything. Hide them and let
  // the empty state be the way in.
  const searchable = profiles.length > 0 || query.trim().length > 0

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {searchable ? (
        <div className="flex items-center gap-2">
          <SearchInput
            className="min-w-0 flex-1"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onClear={() => onQuery('')}
            placeholder="Search teammates"
            aria-label="Search teammates"
            tone="quiet"
          />
          <Button onClick={onCreate} title="Create a teammate">
            New
          </Button>
        </div>
      ) : null}

      {profiles.length === 0 ? (
        query.trim() ? (
          <EmptyState compact title="No teammate matches that" />
        ) : (
          <EmptyState
            icon="bot"
            title={ready ? 'No teammates yet' : 'Loading teammates…'}
            description={
              ready
                ? 'A teammate keeps its own memory per project, can pin a model, and takes tasks you hand it.'
                : undefined
            }
            action={
              ready ? <Button onClick={onCreate}>Create your first teammate</Button> : undefined
            }
          />
        )
      ) : (
        <div
          className="flex flex-col gap-0.5"
          role="listbox"
          aria-label="Teammates"
          tabIndex={-1}
          onKeyDown={onContainerKeyDown}
        >
          {profiles.map((profile, index) => {
            const selected = profile.id === selectedId
            const scope = profileScopeLabel(profile)
            const usable = isProfileUsableIn(profile, activeWorkspacePath)
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
                  selected
                    ? 'bg-surface text-fg-strong ring-1 ring-inset ring-border/50'
                    : 'hover:bg-surface/40'
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
                  {profile.persona ? (
                    <span className="truncate text-2xs text-muted">{profile.persona}</span>
                  ) : null}
                </span>
                {scope ? (
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
  )
}
