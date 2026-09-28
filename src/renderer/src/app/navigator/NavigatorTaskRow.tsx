import { memo, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { IconButton, StatusGlyph, cn, type TaskState } from '@renderer/lib/ui'
import { ContextMenu, type ContextMenuAnchor, type ContextMenuItem } from '@renderer/lib/ui/ContextMenu'
import {
  markSessionDragEnd,
  markSessionDragStart,
  writeSessionDragPayload
} from '@renderer/lib/chat/chatPaneLayout'
import type { NavMeta, NavRow } from './navigatorModel'
import { TaskHoverCard, hoverCardAnchor, type TaskHoverCardAnchor } from './TaskHoverCard'

/** A resting pointer, not one passing through on its way down the list. */
const HOVER_CARD_DELAY_MS = 500

export type NavigatorRowActions = {
  onSelect: (workspacePath: string, runId: string) => void
  onRename: (workspacePath: string, runId: string, goal: string) => void
  onDelete: (workspacePath: string, runId: string) => void
  onExport?: (workspacePath: string, runId: string) => void
  onCopyLink?: (workspacePath: string, runId: string) => void
  /** Stop a live run. */
  onStop?: (workspacePath: string, runId: string) => void
  /** Continue a run the app left interrupted. */
  onResume?: (workspacePath: string, runId: string) => void
  /** Pause the standing goal — and stop the run it launched, if one is live. */
  onPauseGoal?: (workspacePath: string, runId: string, live: boolean) => void
  /** Disarm a scheduled loop. */
  onStopLoop?: (workspacePath: string, runId: string) => void
  onTogglePin?: (workspacePath: string, runId: string) => void
  /** Archive a settled task, or bring an archived one back. */
  onToggleArchive?: (workspacePath: string, runId: string) => void
}

/**
 * One task: the title on the navigator's one left edge, then on the right a
 * glyph and one meta cell. The glyph is left out while the row is in the state
 * its group's heading already says; it shows only for a row that ended some
 * other way, beside the number it qualifies. Everything else a row can do
 * (stop, resume, pause its goal, stop its loop, pin, archive, rename, export,
 * copy link, delete) is in its menu — right-click, Shift F10, or the ⋯ that
 * slides in after the meta on hover — so the resting row carries nothing it
 * does not need to say. A pointer that rests on the row gets its hover card.
 */
export const NavigatorTaskRow = memo(function NavigatorTaskRow({
  row,
  groupState,
  selected,
  open = false,
  actions,
  onNavKeyDown
}: {
  row: NavRow
  /** The state the group's heading says; a row in it shows no glyph of its own. */
  groupState?: TaskState
  /** In the focused pane. */
  selected: boolean
  /** Open in another pane (split view) but not the focused one. */
  open?: boolean
  actions: NavigatorRowActions
  onNavKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [menuAnchor, setMenuAnchor] = useState<ContextMenuAnchor | null>(null)
  const [dragging, setDragging] = useState(false)
  const [card, setCard] = useState<TaskHoverCardAnchor | null>(null)
  const cardTimer = useRef<number | null>(null)
  const rowRef = useRef<HTMLButtonElement>(null)
  const descriptionId = useId()
  const busyRef = useRef(false)
  busyRef.current = renaming || confirmingDelete

  const hideCard = (): void => {
    if (cardTimer.current != null) window.clearTimeout(cardTimer.current)
    cardTimer.current = null
    setCard(null)
  }
  useEffect(() => () => {
    if (cardTimer.current != null) window.clearTimeout(cardTimer.current)
  }, [])
  // The card never follows its row around: any scroll puts it away.
  useEffect(() => {
    if (!card) return
    const onScroll = (): void => setCard(null)
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [card])

  const { workspacePath, runId } = row
  const live = row.state === 'running' || row.state === 'needs'
  const interrupted = !live && row.stateLabel.startsWith('Interrupted')
  const goalActive = row.run.goalStatus === 'active'
  const loopArmed = row.run.loopArmed === true
  const menuItems = useMemo<ContextMenuItem[]>(() => {
    const items: ContextMenuItem[] = []
    const { onStop, onResume, onPauseGoal, onStopLoop, onTogglePin, onToggleArchive } = actions
    if (live && onStop) {
      items.push({ id: 'stop', label: 'Stop', onSelect: () => onStop(workspacePath, runId) })
    }
    if (interrupted && onResume) {
      items.push({ id: 'resume', label: 'Resume', onSelect: () => onResume(workspacePath, runId) })
    }
    if (goalActive && onPauseGoal) {
      items.push({ id: 'pause-goal', label: 'Pause goal', onSelect: () => onPauseGoal(workspacePath, runId, live) })
    }
    if (loopArmed && onStopLoop) {
      items.push({ id: 'stop-loop', label: 'Stop loop', onSelect: () => onStopLoop(workspacePath, runId) })
    }
    if (items.length > 0) items.push({ type: 'separator', id: 'sep-run' })
    // An archived task is out of the way already; pinning it would pull it back.
    if (onTogglePin && !row.archived) {
      items.push({
        id: 'pin',
        label: row.pinned ? 'Unpin' : 'Pin',
        onSelect: () => onTogglePin(workspacePath, runId)
      })
    }
    // A live task can't be put away: it still has something to say.
    if (onToggleArchive && (row.archived || !live)) {
      items.push({
        id: 'archive',
        label: row.archived ? 'Unarchive' : 'Archive',
        onSelect: () => onToggleArchive(workspacePath, runId)
      })
    }
    items.push({ id: 'rename', label: 'Rename', onSelect: () => setRenaming(true) })
    if (actions.onExport) {
      const onExport = actions.onExport
      items.push({
        id: 'export',
        label: 'Export as Markdown',
        onSelect: () => onExport(workspacePath, runId)
      })
    }
    if (actions.onCopyLink) {
      const onCopyLink = actions.onCopyLink
      items.push({ id: 'copy-link', label: 'Copy link', onSelect: () => onCopyLink(workspacePath, runId) })
    }
    items.push({ type: 'separator', id: 'sep-danger' })
    items.push({
      id: 'delete',
      label: 'Delete',
      danger: true,
      shortcut: 'Del',
      onSelect: () => setConfirmingDelete(true)
    })
    return items
  }, [actions, goalActive, interrupted, live, loopArmed, row.archived, row.pinned, runId, workspacePath])

  const dimmed = row.archived || row.state === 'done' || row.state === 'stopped'
  const showGlyph = row.state !== groupState
  // The name is the title alone, so the row is found by what it says; the
  // state, its one number and a foreign workspace are its description.
  const description = [
    row.stateLabel,
    metaLabel(row.meta),
    row.run.worktreeBranch ? `worktree ${row.run.worktreeBranch}` : null,
    row.foreign ? row.workspaceName : null,
    row.archived ? 'archived' : null
  ]
    .filter(Boolean)
    .join(', ')

  if (renaming) {
    return (
      <li>
        <RenameField
          initial={row.run.goal ?? row.title}
          onDone={(next) => {
            setRenaming(false)
            const goal = next?.trim()
            if (goal && goal !== (row.run.goal ?? '').trim()) actions.onRename(workspacePath, runId, goal)
            window.setTimeout(() => rowRef.current?.focus(), 0)
          }}
        />
      </li>
    )
  }

  return (
    <li className="group relative">
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
      <button
        ref={rowRef}
        type="button"
        data-nav-row
        data-run-id={runId}
        draggable={!confirmingDelete}
        aria-current={selected ? 'page' : undefined}
        aria-label={row.title}
        aria-describedby={descriptionId}
        data-session-open={selected || open ? '1' : '0'}
        data-session-focused={selected ? '1' : '0'}
        className={cn(
          'app-region-no-drag flex h-7 w-full items-center gap-2 rounded-md pl-2 text-left vy-transition focus-visible:vy-focus-ring',
          selected ? 'bg-surface-2' : 'hover:bg-surface',
          // Room for the ⋯ after the meta: while its menu is open, and on hover or focus.
          confirmingDelete ? 'pr-[108px]' : menuAnchor ? 'pr-7' : 'pr-2 group-hover:pr-7 group-focus-within:pr-7',
          dragging && 'opacity-50'
        )}
        onPointerEnter={(e) => {
          if (e.pointerType !== 'mouse' || menuAnchor || confirmingDelete || dragging) return
          const el = e.currentTarget
          hideCard()
          cardTimer.current = window.setTimeout(() => {
            cardTimer.current = null
            if (el.isConnected) setCard(hoverCardAnchor(el))
          }, HOVER_CARD_DELAY_MS)
        }}
        onPointerLeave={hideCard}
        onPointerDown={hideCard}
        onClick={() => actions.onSelect(workspacePath, runId)}
        onDoubleClick={(e) => {
          e.preventDefault()
          setRenaming(true)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          hideCard()
          setMenuAnchor({ x: e.clientX, y: e.clientY })
        }}
        onKeyDown={(e) => {
          if (e.key === 'Delete' && !confirmingDelete) {
            e.preventDefault()
            setConfirmingDelete(true)
            return
          }
          if (e.key === 'F2') {
            e.preventDefault()
            setRenaming(true)
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
        onDragStart={(e) => {
          hideCard()
          writeSessionDragPayload(e.dataTransfer, { workspacePath, runId })
          markSessionDragStart()
          setDragging(true)
        }}
        onDragEnd={() => {
          markSessionDragEnd()
          setDragging(false)
        }}
      >
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-sm',
            // Unread lifts to full strength, never bold: a weight change made a
            // column of mixed weights and re-cut every unread title shorter.
            selected || open || row.unread ? 'text-fg-strong' : dimmed ? 'text-muted' : 'text-fg'
          )}
        >
          {row.title}
        </span>
        {confirmingDelete ? null : (
          <>
            {showGlyph ? (
              <span className="inline-flex shrink-0" data-row-glyph>
                <StatusGlyph state={row.state} size={14} />
              </span>
            ) : null}
            <RowMeta row={row} />
          </>
        )}
      </button>

      {confirmingDelete ? (
        <DeleteConfirm
          title={row.title}
          onConfirm={() => {
            setConfirmingDelete(false)
            actions.onDelete(workspacePath, runId)
          }}
          onCancel={() => {
            setConfirmingDelete(false)
            rowRef.current?.focus()
          }}
        />
      ) : (
        <span
          className={cn(
            'absolute inset-y-0 right-1 items-center',
            menuAnchor ? 'flex' : 'hidden group-hover:flex group-focus-within:flex'
          )}
        >
          <IconButton
            icon="more"
            label={`Actions for ${row.title}`}
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
      )}

      {card && !menuAnchor && !confirmingDelete ? <TaskHoverCard row={row} anchor={card} /> : null}

      {menuAnchor ? (
        <ContextMenu
          anchor={menuAnchor}
          items={menuItems}
          onClose={() => setMenuAnchor(null)}
          returnFocusRef={rowRef}
          shouldRestoreFocus={() => !busyRef.current}
          aria-label={`Actions for ${row.title}`}
        />
      ) : null}
    </li>
  )
})

function RowMeta({ row }: { row: NavRow }) {
  const meta = row.meta
  if (meta.kind === 'steps') {
    return (
      <span className="shrink-0 font-mono text-caption text-tertiary tnum" title={`Step ${meta.current} of ${meta.total}`}>
        {meta.current}/{meta.total}
      </span>
    )
  }
  // Review rows all say one thing, the file count: exact line counts are not
  // always known (a binary or oversized file drops them), and a column that
  // switched between "+52 −4" and "3 files" read as two kinds of number.
  if (meta.kind === 'diff' || meta.kind === 'files') {
    return (
      <span className="shrink-0 text-caption text-tertiary">
        {meta.files} {meta.files === 1 ? 'file' : 'files'}
      </span>
    )
  }
  return (
    // min-w and right-aligned, so a glyph beside "2h" stands where it does beside "15h".
    <span className={cn('min-w-[3ch] shrink-0 text-right font-mono text-caption tnum', meta.accent ? 'text-accent' : 'text-tertiary')}>
      {meta.text}
    </span>
  )
}

function metaLabel(meta: NavMeta): string {
  switch (meta.kind) {
    case 'steps':
      return `step ${meta.current} of ${meta.total}`
    case 'diff':
      return `${meta.files} ${meta.files === 1 ? 'file' : 'files'} changed, ${meta.add} ${meta.add === 1 ? 'line' : 'lines'} added, ${meta.del} removed`
    case 'files':
      return `${meta.files} ${meta.files === 1 ? 'file' : 'files'} changed`
    case 'age':
      return meta.text
  }
}

function RenameField({ initial, onDone }: { initial: string; onDone: (next: string | null) => void }) {
  const [draft, setDraft] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  const settled = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (next: string | null): void => {
    if (settled.current) return
    settled.current = true
    onDone(next)
  }
  return (
    <input
      ref={ref}
      type="text"
      data-vy-text-entry
      aria-label="Rename task"
      value={draft}
      className="app-region-no-drag h-7 w-full rounded-md border border-border-strong bg-bg px-2 text-sm text-fg outline-none focus-visible:vy-focus-ring"
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(draft)
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          finish(null)
        }
      }}
      onBlur={() => finish(draft)}
    />
  )
}

function DeleteConfirm({
  title,
  onConfirm,
  onCancel
}: {
  title: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    onCancel()
  }
  return (
    <span
      data-inline-confirm
      role="group"
      aria-label={`Delete ${title}?`}
      className="absolute inset-y-0 right-1 flex items-center gap-1"
    >
      <span className="mr-1 text-caption text-danger">Delete?</span>
      <IconButton icon="check" label={`Delete ${title}`} size="xs" tone="muted" onClick={onConfirm} onKeyDown={onKeyDown} />
      <IconButton
        ref={cancelRef}
        icon="close"
        label="Keep it"
        size="xs"
        tone="muted"
        onClick={onCancel}
        onKeyDown={onKeyDown}
      />
    </span>
  )
}
