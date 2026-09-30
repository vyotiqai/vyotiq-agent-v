import { memo, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { ToolApprovalDecision } from '@shared/ipc'
import { approvalAsk, questionAsk } from '@shared/needsYouText'
import { Icon } from '@renderer/lib/icons'
import { Button, CheckMark, DiffStat, IconButton, StatusGlyph, cn, type TaskState } from '@renderer/lib/ui'
import { ContextMenu, type ContextMenuAnchor, type ContextMenuItem } from '@renderer/lib/ui/ContextMenu'
import { BORDER_DIVIDER, ROW_HOVER } from '@renderer/lib/utils/layout'
import {
  markSessionDragEnd,
  markSessionDragStart,
  writeSessionDragPayload
} from '@renderer/lib/chat/chatPaneLayout'
import type { PendingAsk } from '@renderer/features/home/usePendingAsks'
import { ageFromNow, type NavInstance, type NavMeta, type NavRow } from './navigatorModel'
import { TaskHoverCard, hoverCardAnchor, type TaskHoverCardAnchor } from './TaskHoverCard'
import { WHERE_WORDS, highlightMatch, type RowSnippet } from './searchSnippet'

export type { RowSnippet }

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
  /** Carry a failed task on, as its record's Retry does. */
  onRetry?: (workspacePath: string, runId: string) => void
  /** The task header's Fork: the task's conversation as a new task. */
  onFork?: (workspacePath: string, runId: string) => void
  /** Pause the standing goal — and stop the run it launched, if one is live. */
  onPauseGoal?: (workspacePath: string, runId: string, live: boolean) => void
  /** Disarm a scheduled loop. */
  onStopLoop?: (workspacePath: string, runId: string) => void
  onTogglePin?: (workspacePath: string, runId: string) => void
  /** Archive a settled task, or bring an archived one back. */
  onToggleArchive?: (workspacePath: string, runId: string) => void
  /** Allow once or Deny a waiting approval from the row, through the task's own controller. */
  onRespondApproval?: (workspacePath: string, runId: string, requestId: string, decision: ToolApprovalDecision) => Promise<void>
}

/**
 * One task: the title on the navigator's one left edge, then on the right a
 * glyph and one meta cell. The glyph is left out while the row is in the state
 * its group's heading already says; it shows only for a row that ended some
 * other way, beside the number it qualifies. Everything else a row can do
 * (stop, resume, retry, pause its goal, stop its loop, pin, archive, rename,
 * export, fork, copy link, delete) is in its menu — right-click, Shift F10, or the ⋯ that
 * slides in after the meta on hover — so the resting row carries nothing it
 * does not need to say. A pointer that rests on the row gets its hover card.
 *
 * An active row says what it is doing now on a second line: the step a running
 * task is on, what a waiting one asks (an approval takes Allow once or Deny
 * right there), what a task in review changed and how its checks stand. A live
 * task's instances fold under it.
 */
export const NavigatorTaskRow = memo(function NavigatorTaskRow({
  row,
  groupState,
  selected,
  open = false,
  actions,
  onNavKeyDown,
  checked = false,
  onMultiSelect,
  snippet,
  query = '',
  ask = null
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
  /** In the navigator's selection (Ctrl-click, Ctrl Space). */
  checked?: boolean
  /** Add or remove this task from the selection; `range` extends it (Shift). */
  onMultiSelect?: (row: NavRow, range: boolean) => void
  /** The line a search matched, when it wasn't the title. */
  snippet?: RowSnippet
  query?: string
  /** What a waiting task waits on, once main has said. */
  ask?: PendingAsk | null
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
  // Retry only where the task view offers it: a failure Retry can get past.
  const retryable = row.state === 'failed' && row.run.retryable === true
  const goalActive = row.run.goalStatus === 'active'
  const loopArmed = row.run.loopArmed === true
  const menuItems = useMemo<ContextMenuItem[]>(() => {
    const items: ContextMenuItem[] = []
    const { onStop, onResume, onRetry, onPauseGoal, onStopLoop, onTogglePin, onToggleArchive } = actions
    if (live && onStop) {
      items.push({ id: 'stop', label: 'Stop', onSelect: () => onStop(workspacePath, runId) })
    }
    if (interrupted && onResume) {
      items.push({ id: 'resume', label: 'Resume', onSelect: () => onResume(workspacePath, runId) })
    }
    if (retryable && onRetry) {
      items.push({ id: 'retry', label: 'Retry', onSelect: () => onRetry(workspacePath, runId) })
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
    // As in the task header: main forks only a task that has stopped.
    if (actions.onFork && !live) {
      const onFork = actions.onFork
      items.push({ id: 'fork', label: 'Fork', onSelect: () => onFork(workspacePath, runId) })
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
  }, [actions, retryable, goalActive, interrupted, live, loopArmed, row.archived, row.pinned, runId, workspacePath])

  const dimmed = row.archived || row.state === 'done' || row.state === 'stopped'
  const showGlyph = row.state !== groupState
  const note = row.state === 'needs' ? askNote(row, ask) : null
  const second = secondLine(row, ask, note)
  // What the hover card says, for assistive tech: checks in review and while it works.
  const checks = row.run.review || live ? row.run.checks : undefined
  const respond = actions.onRespondApproval
  // The name is the title alone, so the row is found by what it says; the
  // state, its one number and a foreign workspace are its description.
  const description = [
    row.stateLabel,
    metaLabel(row.meta),
    row.state === 'running' ? row.activity : null,
    note,
    checks ? `${checks.met} of ${checks.total} checks met` : null,
    row.run.worktreeBranch ? `worktree ${row.run.worktreeBranch}` : null,
    row.foreign ? row.workspaceName : null,
    row.archived ? 'archived' : null,
    checked ? 'selected' : null,
    snippet && snippet.where !== 'title' ? `found: ${snippet.text}` : null
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
        data-nav-checked={checked ? '1' : undefined}
        className={cn(
          'app-region-no-drag flex w-full flex-col rounded-md pl-2 text-left vy-transition focus-visible:vy-focus-ring',
          second ? 'pb-1.5' : null,
          checked ? 'bg-accent-soft' : selected ? 'bg-surface-2' : 'hover:bg-surface',
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
        onClick={(e) => {
          if (onMultiSelect && (e.ctrlKey || e.metaKey || e.shiftKey)) {
            e.preventDefault()
            onMultiSelect(row, e.shiftKey)
            return
          }
          actions.onSelect(workspacePath, runId)
        }}
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
          if (e.key === ' ' && onMultiSelect && (e.ctrlKey || e.metaKey || e.shiftKey)) {
            e.preventDefault()
            onMultiSelect(row, e.shiftKey)
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
        <span className="flex h-7 w-full min-w-0 items-center gap-2">
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
              {checked ? (
                // The fill is not the only sign: selected rows are ticked.
                <CheckMark on className="shrink-0" />
              ) : showGlyph ? (
                <span className="inline-flex shrink-0" data-row-glyph>
                  <StatusGlyph state={row.state} size={14} />
                </span>
              ) : null}
              <RowMeta row={row} />
            </>
          )}
        </span>
        {second}
      </button>

      {note && ask?.kind === 'approval' && respond ? (
        <RowDecision
          // One per request: the next ask gets its buttons back.
          key={ask.request.requestId}
          title={row.title}
          onDecide={(decision) => respond(workspacePath, runId, ask.request.requestId, decision)}
        />
      ) : null}
      {row.instances ? (
        <RowInstances
          instances={row.instances}
          onOpen={(instanceRunId) => actions.onSelect(workspacePath, instanceRunId)}
        />
      ) : null}

      {snippet && snippet.where !== 'title' ? (
        <p className="m-0 truncate pb-0.5 pl-2 pr-2 text-caption text-muted" data-nav-snippet aria-hidden="true">
          <span className="text-tertiary">{WHERE_WORDS[snippet.where]}: </span>
          {highlightMatch(snippet.text, snippet.start, snippet.length, query)}
        </p>
      ) : null}
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
            'absolute right-1 top-0 h-7 items-center',
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

/** What a waiting task asks, in words: the approval or question main holds, or the state until it has said. */
function askNote(row: NavRow, ask: PendingAsk | null): string {
  if (ask?.kind === 'approval') return approvalAsk(ask.request)
  if (ask?.kind === 'question') return questionAsk(ask.request)
  return row.stateLabel
}

/** The command a terminal approval would run, as the agent wrote it. */
export function commandOf(ask: PendingAsk | null): string | null {
  if (ask?.kind !== 'approval' || ask.request.name !== 'terminal') return null
  try {
    const args = JSON.parse(ask.request.argsPreview) as { command?: unknown }
    return typeof args.command === 'string' && args.command.trim() ? args.command.replace(/\s+/g, ' ').trim() : null
  } catch {
    return null
  }
}

/**
 * The row's second line, inside its button: what a running task is doing, what
 * a waiting one asks (a command as the command), what a task in review changed
 * and how its checks stand. Nothing for a row with nothing to add.
 */
function secondLine(row: NavRow, ask: PendingAsk | null, note: string | null): ReactNode {
  if (row.state === 'running' && row.activity) {
    return (
      <span className="-mt-1 block min-w-0 truncate text-xs vy-text-live" data-nav-activity>
        {row.activity}
      </span>
    )
  }
  if (note) {
    const command = commandOf(ask)
    return command ? (
      <span
        className="-mt-0.5 flex min-w-0 items-center gap-1.5 rounded-sm bg-sunken px-1.5 py-0.5 font-mono text-caption text-fg"
        data-nav-ask
      >
        <span className="text-tertiary" aria-hidden>
          $
        </span>
        <span className="min-w-0 truncate">{command}</span>
      </span>
    ) : (
      <span className="-mt-1 block min-w-0 truncate text-xs text-accent" data-nav-ask>
        {note}
      </span>
    )
  }
  const review = row.run.review
  if (review && (row.meta.kind === 'diff' || row.meta.kind === 'files')) {
    const checks = row.run.checks
    return (
      <span className="-mt-1 flex min-w-0 items-center gap-2 text-xs text-muted" data-nav-review>
        {review.add !== undefined && review.del !== undefined ? (
          <DiffStat add={review.add} del={review.del} />
        ) : (
          <span>
            {review.files} {review.files === 1 ? 'file' : 'files'}
          </span>
        )}
        {checks ? (
          <span className={checks.met < checks.total ? 'text-warning' : 'text-muted'}>
            <span aria-hidden>· </span>
            {checks.met}/{checks.total} checks
          </span>
        ) : null}
      </span>
    )
  }
  return null
}

/** Allow once or Deny, under the ask they answer; the task's own card clears with them. */
export function RowDecision({
  title,
  onDecide,
  className = 'pb-1.5 pl-2 pr-2'
}: {
  title: string
  onDecide: (decision: ToolApprovalDecision) => Promise<void>
  /** Its padding, to sit on the text edge of what it answers. */
  className?: string
}) {
  const [pending, setPending] = useState<ToolApprovalDecision | null>(null)
  const [error, setError] = useState<string | null>(null)
  const decide = (decision: ToolApprovalDecision): void => {
    if (pending) return
    setPending(decision)
    setError(null)
    onDecide(decision).catch((err: unknown) => {
      setPending(null)
      setError(err instanceof Error ? err.message : 'Could not send your decision.')
    })
  }
  return (
    <div role="group" aria-label={`Answer ${title}`} className={cn('flex min-w-0 items-center gap-1', className)} data-nav-decision>
      <Button size="xs" variant="primary" disabled={pending != null} onClick={() => decide('once')}>
        {pending === 'once' ? 'Sending…' : 'Allow once'}
      </Button>
      <Button size="xs" variant="ghost" disabled={pending != null} onClick={() => decide('deny')}>
        {pending === 'deny' ? 'Sending…' : 'Deny'}
      </Button>
      {error ? (
        <span role="alert" className="min-w-0 truncate text-caption text-danger" title={error}>
          {error}
        </span>
      ) : null}
    </div>
  )
}

/** A live task's instances, one line each under a fold that counts the ones still going. */
function RowInstances({ instances, onOpen }: { instances: readonly NavInstance[]; onOpen: (runId: string) => void }) {
  const [open, setOpen] = useState(true)
  const going = instances.filter((i) => i.state === 'running' || i.state === 'needs').length
  const label = `${instances.length} ${instances.length === 1 ? 'instance' : 'instances'}`
  return (
    <div className="pb-1 pl-2 pr-2" data-nav-instances>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-6 w-full min-w-0 items-center gap-1 rounded-sm text-left text-caption text-muted vy-transition hover:text-fg focus-visible:vy-focus-ring"
      >
        <Icon name={open ? 'chevron' : 'chevronRight'} size={10} className="shrink-0 text-tertiary" />
        <span className="min-w-0 truncate">
          {label}
          {going > 0 ? <span className="text-tertiary"> · {going} going</span> : null}
        </span>
      </button>
      {open ? (
        <ul className={cn('ml-[4px] border-l pl-2', BORDER_DIVIDER)}>
          {instances.map((i) => (
            <li key={i.runId}>
              <button
                type="button"
                title={i.title}
                onClick={() => onOpen(i.runId)}
                className={cn(
                  'flex h-6 w-full min-w-0 items-center gap-2 rounded-sm px-1 text-left text-caption vy-transition focus-visible:vy-focus-ring',
                  ROW_HOVER
                )}
              >
                <StatusGlyph state={i.state} size={12} label />
                <span className="shrink-0 text-secondary">{i.title}</span>
                {i.activity ? <span className="min-w-0 truncate vy-text-live">{i.activity}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function RowMeta({ row }: { row: NavRow }) {
  const meta = row.meta
  if (meta.kind === 'steps') {
    return (
      <span className="shrink-0 font-mono text-caption text-tertiary tnum" title={`Step ${meta.current} of ${meta.total}`}>
        {meta.current}/{meta.total}
      </span>
    )
  }
  // What a task in review changed is its second line; the column keeps to
  // one kind of number, how long ago it moved.
  if (meta.kind === 'diff' || meta.kind === 'files') {
    return (
      <span className="min-w-[3ch] shrink-0 text-right font-mono text-caption text-tertiary tnum">
        {ageFromNow(row.run.updatedAt)}
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
      className="absolute right-1 top-0 flex h-7 items-center gap-1"
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
