import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { TaskDraft } from '@shared/ipc'
import { draftTitle } from '@renderer/lib/drafts/taskDraftStore'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { IconButton, cn } from '@renderer/lib/ui'
import { ContextMenu, type ContextMenuAnchor, type ContextMenuItem } from '@renderer/lib/ui/ContextMenu'
import { ageFromNow } from './navigatorModel'

export type NavigatorDraftActions = {
  onOpen: (workspacePath: string, draft: TaskDraft) => void
  onDelete: (workspacePath: string, draft: TaskDraft) => void
}

/**
 * A brief put aside: its title and when it was last saved. The Drafts heading
 * wears the hollow "not started" glyph once, so the row wears none. Its
 * workspace is the heading above it. Open continues it on New task; its menu
 * deletes it.
 */
export function NavigatorDraftRow({
  workspacePath,
  draft,
  selected = false,
  actions,
  onNavKeyDown
}: {
  workspacePath: string
  draft: TaskDraft
  /** Being continued on New task, which is on screen. */
  selected?: boolean
  actions: NavigatorDraftActions
  onNavKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void
}) {
  const [menuAnchor, setMenuAnchor] = useState<ContextMenuAnchor | null>(null)
  const rowRef = useRef<HTMLButtonElement>(null)
  const descriptionId = useId()
  const title = draftTitle(draft)
  const age = ageFromNow(draft.updatedAt)
  const menuItems = useMemo<ContextMenuItem[]>(
    () => [
      { id: 'open', label: 'Continue on New task', onSelect: () => actions.onOpen(workspacePath, draft) },
      { type: 'separator', id: 'sep' },
      { id: 'delete', label: 'Delete draft', danger: true, shortcut: 'Del', onSelect: () => actions.onDelete(workspacePath, draft) }
    ],
    [actions, draft, workspacePath]
  )
  return (
    <li className="group relative">
      <span id={descriptionId} className="sr-only">
        {`Draft, saved ${age === 'now' ? 'just now' : `${age} ago`}, ${formatWorkspaceName(workspacePath)}`}
      </span>
      <button
        ref={rowRef}
        type="button"
        data-nav-row
        data-draft-id={draft.id}
        aria-label={title}
        aria-describedby={descriptionId}
        aria-current={selected ? 'page' : undefined}
        title={draft.brief.trim() || title}
        className={cn(
          'app-region-no-drag flex h-7 w-full items-center gap-2 rounded-md pl-2 text-left vy-transition focus-visible:vy-focus-ring',
          selected ? 'bg-surface-2' : 'hover:bg-surface',
          // Room for the ⋯ after the meta: while its menu is open, and on hover or focus.
          menuAnchor ? 'pr-7' : 'pr-2 group-hover:pr-7 group-focus-within:pr-7'
        )}
        onClick={() => actions.onOpen(workspacePath, draft)}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenuAnchor({ x: e.clientX, y: e.clientY })
        }}
        onKeyDown={(e) => {
          if (e.key === 'Delete') {
            e.preventDefault()
            actions.onDelete(workspacePath, draft)
            return
          }
          if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
            e.preventDefault()
            const rect = e.currentTarget.getBoundingClientRect()
            setMenuAnchor({ x: rect.left, y: rect.bottom })
            return
          }
          onNavKeyDown?.(e)
        }}
      >
        <span className={cn('min-w-0 flex-1 truncate text-sm', selected ? 'text-fg-strong' : 'text-fg')}>{title}</span>
        <span className="min-w-[3ch] shrink-0 text-right font-mono text-caption text-tertiary tnum">{age}</span>
      </button>
      <span
        className={cn('absolute inset-y-0 right-1 items-center', menuAnchor ? 'flex' : 'hidden group-hover:flex group-focus-within:flex')}
      >
        <IconButton
          icon="more"
          label={`Actions for ${title}`}
          size="xs"
          tone="muted"
          aria-haspopup="menu"
          aria-expanded={menuAnchor != null}
          onClick={(e) => {
            if (menuAnchor) {
              setMenuAnchor(null)
              return
            }
            const rect = e.currentTarget.getBoundingClientRect()
            setMenuAnchor({ x: rect.left, y: rect.bottom + 4 })
          }}
        />
      </span>
      {menuAnchor ? (
        <ContextMenu
          anchor={menuAnchor}
          items={menuItems}
          onClose={() => setMenuAnchor(null)}
          returnFocusRef={rowRef}
          aria-label={`Actions for ${title}`}
        />
      ) : null}
    </li>
  )
}
