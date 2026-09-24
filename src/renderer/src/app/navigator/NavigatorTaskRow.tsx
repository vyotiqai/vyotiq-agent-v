import { memo, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { DiffStat, IconButton, StatusGlyph, cn } from '@renderer/lib/ui'
import { ContextMenu, type ContextMenuAnchor, type ContextMenuItem } from '@renderer/lib/ui/ContextMenu'
import {
  markSessionDragEnd,
  markSessionDragStart,
  writeSessionDragPayload
} from '@renderer/lib/chat/chatPaneLayout'
import type { NavMeta, NavRow } from './navigatorModel'

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
}

/**
 * One task: status glyph, title, one meta cell. Everything else a row can do
 * (stop, resume, pause its goal, stop its loop, pin, rename, export, copy
 * link, delete) is in its menu — right-click, Shift F10, or the ⋯ that takes
 * the meta cell's place on hover — so the resting row carries nothing it does
 * not need to say.
 */
export const NavigatorTaskRow = memo(function NavigatorTaskRow({
  row,
  selected,
  open = false,
  actions,
  onNavKeyDown
}: {
  row: NavRow
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
  const rowRef = useRef<HTMLButtonElement>(null)
  const descriptionId = useId()
  const busyRef = useRef(false)
  busyRef.current = renaming || confirmingDelete

  const { workspacePath, runId } = row
  const live = row.state === 'running' || row.state === 'needs'
  const interrupted = !live && row.stateLabel.startsWith('Interrupted')
  const goalActive = row.run.goalStatus === 'active'
  const loopArmed = row.run.loopArmed === true
  const menuItems = useMemo<ContextMenuItem[]>(() => {
    const items: ContextMenuItem[] = []
    const { onStop, onResume, onPauseGoal, onStopLoop, onTogglePin } = actions
    if (live && onStop) {
      items.push({ id: 'stop', label: 'Stop', icon: 'stop', onSelect: () => onStop(workspacePath, runId) })
    }
    if (interrupted && onResume) {
      items.push({ id: 'resume', label: 'Resume', icon: 'play', onSelect: () => onResume(workspacePath, runId) })
    }
    if (goalActive && onPauseGoal) {
      items.push({ id: 'pause-goal', label: 'Pause goal', icon: 'pause', onSelect: () => onPauseGoal(workspacePath, runId, live) })
    }
    if (loopArmed && onStopLoop) {
      items.push({ id: 'stop-loop', label: 'Stop loop', icon: 'repeat', onSelect: () => onStopLoop(workspacePath, runId) })
    }
    if (items.length > 0) items.push({ type: 'separator', id: 'sep-run' })
    if (onTogglePin) {
      items.push({
        id: 'pin',
        label: row.pinned ? 'Unpin' : 'Pin',
        icon: 'pin',
        onSelect: () => onTogglePin(workspacePath, runId)
      })
    }
    items.push({ id: 'rename', label: 'Rename', icon: 'edit', onSelect: () => setRenaming(true) })
    if (actions.onExport) {
      const onExport = actions.onExport
      items.push({
        id: 'export',
        label: 'Export as Markdown',
        icon: 'download',
        onSelect: () => onExport(workspacePath, runId)
      })
    }
    if (actions.onCopyLink) {
      const onCopyLink = actions.onCopyLink
      items.push({ id: 'copy-link', label: 'Copy link', icon: 'copy', onSelect: () => onCopyLink(workspacePath, runId) })
    }
    items.push({ type: 'separator', id: 'sep-danger' })
    items.push({
      id: 'delete',
      label: 'Delete',
      icon: 'trash',
      danger: true,
      shortcut: 'Del',
      onSelect: () => setConfirmingDelete(true)
    })
    return items
  }, [actions, goalActive, interrupted, live, loopArmed, row.pinned, runId, workspacePath])

  const dimmed = row.state === 'done' || row.state === 'stopped'
  // The name is the title alone, so the row is found by what it says; the
  // state, its one number and a foreign workspace are its description.
  const description = [row.stateLabel, metaLabel(row.meta), row.foreign ? row.workspaceName : null]
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
        title={row.foreign ? `${row.tooltip} — ${row.workspaceName}` : row.tooltip}
        className={cn(
          'app-region-no-drag flex h-7 w-full items-center gap-2 rounded-md pl-2 text-left vy-transition focus-visible:vy-focus-ring',
          selected ? 'bg-surface-2' : 'hover:bg-surface',
          confirmingDelete ? 'pr-[108px]' : 'pr-2',
          dragging && 'opacity-50'
        )}
        onClick={() => actions.onSelect(workspacePath, runId)}
        onDoubleClick={(e) => {
          e.preventDefault()
          setRenaming(true)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
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
          writeSessionDragPayload(e.dataTransfer, { workspacePath, runId })
          markSessionDragStart()
          setDragging(true)
        }}
        onDragEnd={() => {
          markSessionDragEnd()
          setDragging(false)
        }}
      >
        <span title={row.stateLabel} className="inline-flex shrink-0">
          <StatusGlyph state={row.state} size={14} />
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-sm',
            selected || open ? 'text-fg-strong' : dimmed ? 'text-muted' : 'text-fg',
            row.unread && 'font-semibold'
          )}
        >
          {row.title}
        </span>
        {confirmingDelete ? null : (
          <span className={menuAnchor ? 'hidden' : 'contents group-hover:hidden group-focus-within:hidden'}>
            <RowMeta row={row} />
          </span>
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
  if (meta.kind === 'diff') {
    return <DiffStat add={meta.add} del={meta.del} className="shrink-0" />
  }
  if (meta.kind === 'files') {
    return (
      <span className="shrink-0 text-caption text-tertiary">
        {meta.files} {meta.files === 1 ? 'file' : 'files'}
      </span>
    )
  }
  return (
    <span className={cn('shrink-0 font-mono text-caption tnum', meta.accent ? 'text-accent' : 'text-tertiary')}>
      {row.foreign ? <span className="font-sans">{row.workspaceName} · </span> : null}
      {meta.text}
    </span>
  )
}

function metaLabel(meta: NavMeta): string {
  switch (meta.kind) {
    case 'steps':
      return `step ${meta.current} of ${meta.total}`
    case 'diff':
      return `${meta.add} added, ${meta.del} removed`
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
      className="absolute inset-y-0 right-1 flex items-center gap-0.5"
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
