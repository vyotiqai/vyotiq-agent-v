import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefCallback
} from 'react'
import { Icon } from '@renderer/lib/icons'
import { IconButton, Tooltip, cn } from '@renderer/lib/ui'
import {
  ContextMenu,
  type ContextMenuAnchor,
  type ContextMenuItem
} from '@renderer/lib/ui/ContextMenu'
import {
  SIDEBAR_ROW,
  SIDEBAR_ROW_ACTIONS_RESERVE,
  SIDEBAR_ROW_FOCUSED,
  SIDEBAR_ROW_HOVER,
  SIDEBAR_ROW_OPEN
} from '@renderer/lib/utils/layout'
import type { RunSummary } from '@shared/ipc'
import { isResumableInterruptedRun } from '@shared/runInterrupt'
import { runCostDisplay } from '@shared/utils/costDisplay'
import {
  markSessionDragEnd,
  markSessionDragStart,
  writeSessionDragPayload
} from '@renderer/lib/chat/chatPaneLayout'
import { InlineConfirmActions } from './InlineConfirmActions'
import { runTitle, runTooltip } from './runTitle'

function RunStatusDot({ run, live }: { run: RunSummary; live?: boolean }) {
  // Shape carries the state, not hue alone: a spinner vs a warning vs an X.
  // Color is a redundant cue; the button aria-label already names the state for AT.
  //
  // `status` is a snapshot on disk, not a live fact: main drops a run from its
  // active registry before the terminal status.json write has flushed, and the
  // renderer refreshes the run list exactly once on that transition, so a
  // refresh that loses the race leaves `running` pinned forever and the row
  // spins for a chat that finished. `live` is the authoritative answer polled
  // from main — when it says the run is gone, the snapshot is stale, not the
  // truth. `undefined` means nobody asked, so the snapshot stands.
  if (run.status === 'running' && live !== false) {
    return (
      <span className="inline-flex shrink-0" title="Running">
        <Icon name="loader" size={12} className="animate-spin text-fg" />
      </span>
    )
  }
  if (isResumableInterruptedRun(run)) {
    return (
      <span className="inline-flex shrink-0" title="Interrupted — click to continue">
        <Icon name="warning" size={12} className="text-warning" />
      </span>
    )
  }
  if (run.status === 'error') {
    return (
      <span className="inline-flex shrink-0" title="Run ended with errors">
        <Icon name="close" size={12} className="text-danger" />
      </span>
    )
  }
  return null
}

export const ChatRow = memo(function ChatRow({
  run,
  workspacePath,
  active,
  focused,
  nested = false,
  titleOverride,
  onSelectRun,
  onRenameRun,
  onDeleteRun,
  onExportRun,
  onCopyRunLink,
  onForkRun,
  live,
  tabIndex,
  rowRef,
  onNavKeyDown
}: {
  run: RunSummary
  workspacePath: string
  active: boolean
  focused?: boolean
  /** Main still lists this run as active. `undefined` when unknown. */
  live?: boolean
  /** Denser chrome for nested inline instances. */
  nested?: boolean
  /** Precomputed label (sibling-disambiguated instance titles). */
  titleOverride?: string
  onSelectRun: (workspacePath: string, runId: string) => void
  onRenameRun: (workspacePath: string, runId: string, goal: string) => void
  onDeleteRun: (workspacePath: string, runId: string) => void
  onExportRun?: (workspacePath: string, runId: string) => void
  onCopyRunLink?: (workspacePath: string, runId: string) => void
  onForkRun?: (workspacePath: string, runId: string) => void
  tabIndex?: number
  rowRef?: RefCallback<HTMLElement>
  onNavKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [menuAnchor, setMenuAnchor] = useState<ContextMenuAnchor | null>(null)
  const [dragging, setDragging] = useState(false)
  const [draft, setDraft] = useState(run.goal ?? '')
  const inputRef = useRef<HTMLInputElement>(null)
  const rowButtonRef = useRef<HTMLButtonElement | null>(null)
  const renameCancelledRef = useRef(false)

  // Live mirrors for the menu's focus-return check, which runs on a timer after
  // the item has already flipped the row into rename / confirm-delete. Without
  // them the menu would pull focus back off the input or the Cancel button.
  const confirmingDeleteRef = useRef(confirmingDelete)
  confirmingDeleteRef.current = confirmingDelete
  const renamingRef = useRef(renaming)
  renamingRef.current = renaming

  useEffect(() => {
    if (!renaming) return
    renameCancelledRef.current = false
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [renaming])

  useEffect(() => {
    if (!renaming) setDraft(run.goal ?? '')
  }, [run.goal, renaming])

  // Stable per-row closures live here so parents can pass memo-safe handler refs.
  const onSelect = (): void => onSelectRun(workspacePath, run.runId)
  const onRename = (goal: string): void => onRenameRun(workspacePath, run.runId, goal)
  const onDelete = (): void => onDeleteRun(workspacePath, run.runId)

  const commitRename = (): void => {
    if (renameCancelledRef.current) {
      renameCancelledRef.current = false
      return
    }
    const next = draft.trim()
    setRenaming(false)
    if (next && next !== (run.goal ?? '').trim()) onRename(next)
  }

  const title = titleOverride ?? runTitle(run)
  const fullLabel = runTooltip(run)
  const cost = runCostDisplay(run)

  // Tooltip composes refs, so the row can keep its own handle for menu focus
  // return while the roving-tabindex parent keeps its callback ref.
  const setRowRef = useCallback(
    (node: HTMLButtonElement | null): void => {
      rowButtonRef.current = node
      rowRef?.(node)
    },
    [rowRef]
  )

  const closeMenu = useCallback((): void => setMenuAnchor(null), [])

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    const items: ContextMenuItem[] = [
      {
        id: 'rename',
        label: 'Rename',
        icon: 'edit',
        onSelect: () => {
          setConfirmingDelete(false)
          setRenaming(true)
        }
      }
    ]
    if (onForkRun) {
      items.push({
        id: 'fork',
        label: 'Fork chat',
        icon: 'branch',
        onSelect: () => onForkRun(workspacePath, run.runId)
      })
    }
    if (onExportRun) {
      items.push({
        id: 'export',
        label: 'Export as Markdown',
        icon: 'download',
        onSelect: () => onExportRun(workspacePath, run.runId)
      })
    }
    if (onCopyRunLink) {
      items.push({
        id: 'copy-link',
        label: 'Copy link',
        icon: 'copy',
        onSelect: () => onCopyRunLink(workspacePath, run.runId)
      })
    }
    items.push({ type: 'separator', id: 'sep-danger' })
    items.push({
      id: 'delete',
      label: 'Delete',
      icon: 'trash',
      danger: true,
      shortcut: 'Del',
      onSelect: () => {
        setRenaming(false)
        setConfirmingDelete(true)
      }
    })
    return items
  }, [onCopyRunLink, onExportRun, onForkRun, run.runId, workspacePath])

  const runStatusLabel = ((): string | null => {
    if (run.status === 'running' && live !== false) return 'Running'
    if (isResumableInterruptedRun(run)) return 'Interrupted'
    if (run.status === 'error') return 'Error'
    return null
  })()
  const sessionAriaLabel = ((): string => {
    const parts = [title]
    if (runStatusLabel) parts.push(runStatusLabel)
    if (run.goalStatus === 'active') parts.push('active goal')
    if (run.goalStatus === 'paused') parts.push('paused goal')
    if (cost) parts.push(cost.text)
    return parts.join(', ')
  })()

  if (renaming) {
    return (
      <div role="listitem" className={nested ? 'px-1 py-0.5' : 'px-1.5 py-0.5'}>
        <input
          ref={inputRef}
          type="text"
          data-vy-text-entry
          className={cn(
            'app-region-no-drag w-full rounded-lg border border-border/50 bg-surface/60 text-fg outline-none focus:border-border-strong focus:bg-surface focus:vy-focus-ring',
            nested ? 'px-1.5 py-1 text-xs' : 'px-2 py-1.5 text-sm'
          )}
          value={draft}
          aria-label="Rename chat"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              renameCancelledRef.current = true
              setRenaming(false)
              setDraft(run.goal ?? '')
            }
          }}
          onBlur={commitRename}
        />
      </div>
    )
  }

  return (
    <div role="listitem" className={cn('group relative min-w-0', active ? 'text-fg-strong' : '')}>
      <Tooltip content={fullLabel}>
        <button
          type="button"
          ref={setRowRef}
          tabIndex={tabIndex}
          data-session-row
          draggable={!renaming && !confirmingDelete}
          className={cn(
            'app-region-no-drag flex w-full min-w-0 items-center gap-1.5 pr-2 text-left vy-transition',
            SIDEBAR_ROW_ACTIONS_RESERVE,
            nested
              ? 'rounded-md px-1.5 py-1 text-xs leading-snug border-l-2 border-l-transparent'
              : SIDEBAR_ROW,
            active ? (focused ? SIDEBAR_ROW_FOCUSED : SIDEBAR_ROW_OPEN) : SIDEBAR_ROW_HOVER,
            !active && (nested ? 'text-muted' : 'text-fg/85'),
            dragging && 'opacity-50'
          )}
          aria-current={focused ? 'page' : undefined}
          aria-label={sessionAriaLabel}
          data-session-open={active ? '1' : '0'}
          data-session-focused={focused ? '1' : '0'}
          onClick={onSelect}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setMenuAnchor({ x: e.clientX, y: e.clientY })
          }}
          onKeyDown={(e) => {
            // Same Delete-to-close pattern as dock/session tab strips; Esc cancels
            // inside InlineConfirmActions.
            if (e.key === 'Delete' && !renaming && !confirmingDelete) {
              e.preventDefault()
              setConfirmingDelete(true)
              return
            }
            // Keyboard route to the same menu the ⋯ button and right-click open.
            if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
              e.preventDefault()
              const rect = e.currentTarget.getBoundingClientRect()
              setMenuAnchor({ x: rect.left, y: rect.bottom })
              return
            }
            onNavKeyDown?.(e)
          }}
          onDoubleClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setConfirmingDelete(false)
            setRenaming(true)
          }}
          onDragStart={(e) => {
            if (renaming || confirmingDelete) {
              e.preventDefault()
              return
            }
            writeSessionDragPayload(e.dataTransfer, {
              workspacePath,
              runId: run.runId
            })
            markSessionDragStart()
            setDragging(true)
          }}
          onDragEnd={() => {
            markSessionDragEnd()
            setDragging(false)
          }}
        >
          <RunStatusDot run={run} live={live} />
          {run.goalStatus === 'active' || run.goalStatus === 'paused' ? (
            <span
              className="inline-flex shrink-0"
              title={run.goalStatus === 'paused' ? 'Goal paused' : 'Active goal'}
              aria-hidden="true"
            >
              <Icon
                name="flag"
                size={12}
                className={run.goalStatus === 'paused' ? 'text-muted' : 'text-fg'}
              />
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {cost ? (
            <span
              className="shrink-0 text-3xs tabular-nums text-muted group-hover:hidden [@media(hover:none)]:hidden"
              title={cost.title}
            >
              {cost.text}
            </span>
          ) : null}
        </button>
      </Tooltip>

      {/*
        Two buttons wide at most — the overflow actions live in the menu rather
        than in a strip that would out-measure the reserve and sit on the label.
        Stays mounted while the menu is open so the ⋯ trigger keeps its hover
        state under the portal.

        Pointer events sit on the controls, not this container, so the gaps
        fall through to the row. Gating them on group-hover instead would
        make the strip unclickable: reaching it requires a hit test that the
        row button underneath would win while the hover is still off.

        The two states are a ternary, not a base plus an override: `cn` only
        joins strings, and Tailwind emits `pointer-events-none` after
        `pointer-events-auto` at equal specificity, so appending the latter
        never won and the confirm buttons sat under a dead container.
      */}
      <div
        className={cn(
          'app-region-no-drag absolute inset-y-0 right-0 z-sticky flex items-center gap-px vy-transition',
          confirmingDelete || menuAnchor
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'
        )}
      >
        {confirmingDelete ? (
          <InlineConfirmActions
            confirmLabel={`Confirm delete ${fullLabel}`}
            cancelLabel={`Cancel delete ${fullLabel}`}
            onConfirm={() => {
              setConfirmingDelete(false)
              onDelete()
            }}
            onCancel={() => setConfirmingDelete(false)}
          />
        ) : (
          <>
            <IconButton
              icon="more"
              label={`More actions for ${fullLabel}`}
              size="xs"
              variant="bare"
              className="pointer-events-auto text-muted hover:text-fg"
              aria-haspopup="menu"
              aria-expanded={menuAnchor != null}
              onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
              onClick={(e) => {
                e.stopPropagation()
                if (menuAnchor) {
                  setMenuAnchor(null)
                  return
                }
                const rect = e.currentTarget.getBoundingClientRect()
                setMenuAnchor({ x: rect.left, y: rect.bottom + 4 })
              }}
            />
            <IconButton
              icon="trash"
              label={`Delete ${fullLabel}`}
              size="xs"
              variant="bare"
              className="pointer-events-auto text-muted hover:text-danger"
              onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
              onClick={(e) => {
                e.stopPropagation()
                setConfirmingDelete(true)
              }}
            />
          </>
        )}
      </div>

      {menuAnchor ? (
        <ContextMenu
          anchor={menuAnchor}
          items={menuItems}
          onClose={closeMenu}
          returnFocusRef={rowButtonRef}
          shouldRestoreFocus={() => !confirmingDeleteRef.current && !renamingRef.current}
          aria-label={`Actions for ${fullLabel}`}
        />
      ) : null}
    </div>
  )
})
