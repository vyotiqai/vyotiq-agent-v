import type { RefObject } from 'react'
import { SearchInput, cn } from '@renderer/lib/ui'
import { shortcutLabel } from '@renderer/lib/shortcuts'

export function SidebarSearchChrome({
  searchRef,
  sessionQuery,
  workspaceReady,
  onSessionQuery
}: {
  searchRef: RefObject<HTMLInputElement | null>
  sessionQuery: string
  workspaceReady: boolean
  onSessionQuery: (q: string) => void
}) {
  const showShortcut = workspaceReady && !sessionQuery

  return (
    <SearchInput
      ref={searchRef}
      disabled={!workspaceReady}
      tone="quiet"
      className={cn(
        'h-8 min-h-0 w-full gap-1.5 rounded-none border-0 bg-transparent px-1',
        'min-h-0 focus-within:bg-transparent'
      )}
      inputClassName="h-8 min-h-0 py-0 text-sm"
      placeholder={workspaceReady ? 'Search chats' : 'Open workspace'}
      aria-label="Search chats"
      aria-keyshortcuts="Meta+K Control+K"
      value={sessionQuery}
      onChange={(e) => onSessionQuery(e.target.value)}
      onClear={sessionQuery ? () => onSessionQuery('') : undefined}
      trailing={
        showShortcut ? (
          <kbd className="hidden shrink-0 px-1 py-px text-3xs font-medium text-muted @min-[13rem]/sidebar:inline">
            {shortcutLabel('search')}
          </kbd>
        ) : undefined
      }
    />
  )
}
