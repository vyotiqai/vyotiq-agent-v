import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { TaskDraft } from '@shared/ipc'
import { draftTitle } from '@renderer/lib/drafts/taskDraftStore'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { IconButton, StatusGlyph, cn } from '@renderer/lib/ui'
import { ContextMenu, type ContextMenuAnchor, type ContextMenuItem } from '@renderer/lib/ui/ContextMenu'
import { ageFromNow } from './navigatorModel'

export type NavigatorDraftActions = {
  onOpen: (workspacePath: string, draft: TaskDraft) => void
  onDelete: (workspacePath: string, draft: TaskDraft) => void
}

/**
 * A brief put aside: not started, so the hollow glyph a queued check wears;
 * its title; when it was last saved. Open continues it on New task; its menu
 * deletes it.
 */
export function NavigatorDraftRow({
  workspacePath,
  draft,
  foreign,
  selected = false,
  actions,
  onNavKeyDown
}: {
  workspacePath: string
  draft: TaskDraft
  /** From a workspace other than the one in front: name it. */
  foreign: boolean
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
      { id: 'open', label: 'Continue on New task', icon: 'edit', onSelect: () => actions.onOpen(workspacePath, draft) },
      { type: 'separator', id: 'sep' },
      { id: 'delete', label: 'Delete draft', icon: 'trash', danger: true, shortcut: 'Del', onSelect: () => actions.onDelete(workspacePath, draft) }
    ],
    [actions, draft, workspacePath]
  )
  return (
    <li className="group relative">
      <span id={descriptionId} className="sr-only">
        {`Draft, saved ${age === 'now' ? 'just now' : `${age} ago`}${foreign ? `, ${formatWorkspaceName(workspacePath)}` : ''}`}
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
          'app-region-no-drag flex h-7 w-full items-center gap-2 rounded-md pl-2 pr-2 text-left vy-transition focus-visible:vy-focus-ring',
          selected ? 'bg-surface-2' : 'hover:bg-surface'
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
        <span title="Not started" className="inline-flex shrink-0">
          <StatusGlyph state="queued" size={14} />
        </span>
        <span className={cn('min-w-0 flex-1 truncate text-sm', selected ? 'text-fg-strong' : 'text-fg')}>{title}</span>
        <span className={menuAnchor ? 'hidden' : 'contents group-hover:hidden group-focus-within:hidden'}>
          <span className="shrink-0 font-mono text-caption text-tertiary tnum">
            {foreign ? <span className="font-sans">{formatWorkspaceName(workspacePath)} · </span> : null}
            {age}
          </span>
        </span>
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
