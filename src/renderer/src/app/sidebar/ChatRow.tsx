import { memo, useEffect, useRef, useState, type KeyboardEvent, type RefCallback } from 'react'
import { Icon } from '@renderer/lib/icons'
import { IconButton, Tooltip, cn } from '@renderer/lib/ui'
import {
  SIDEBAR_ROW,
  SIDEBAR_ROW_FOCUSED,
  SIDEBAR_ROW_HOVER,
  SIDEBAR_ROW_OPEN
} from '@renderer/lib/utils/layout'
import type { RunSummary } from '@shared/ipc'
import { isResumableInterruptedRun } from '@shared/runInterrupt'
import {
  markSessionDragEnd,
  markSessionDragStart,
  writeSessionDragPayload
} from '@renderer/lib/chat/chatPaneLayout'
import { InlineConfirmActions } from './InlineConfirmActions'
import { runTitle, runTooltip } from './runTitle'

function RunStatusDot({ run }: { run: RunSummary }) {
  // Shape carries the state, not hue alone: a spinner vs a warning vs an X.
  // Color is a redundant cue; the button aria-label already names the state for AT.
  if (run.status === 'running') {
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
  tabIndex,
  rowRef,
  onNavKeyDown
}: {
  run: RunSummary
  workspacePath: string
  active: boolean
  focused?: boolean
  /** Denser chrome for nested inline instances. */
  nested?: boolean
  /** Precomputed label (sibling-disambiguated instance titles). */
  titleOverride?: string
  onSelectRun: (workspacePath: string, runId: string) => void
  onRenameRun: (workspacePath: string, runId: string, goal: string) => void
  onDeleteRun: (workspacePath: string, runId: string) => void
  onExportRun?: (workspacePath: string, runId: string) => void
  tabIndex?: number
  rowRef?: RefCallback<HTMLElement>
  onNavKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [draft, setDraft] = useState(run.goal ?? '')
  const inputRef = useRef<HTMLInputElement>(null)
  const renameCancelledRef = useRef(false)

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

  const runStatusLabel = ((): string | null => {
    if (run.status === 'running') return 'Running'
    if (isResumableInterruptedRun(run)) return 'Interrupted'
    if (run.status === 'error') return 'Error'
    return null
  })()
  const sessionAriaLabel = ((): string => {
    const parts = [title]
    if (runStatusLabel) parts.push(runStatusLabel)
    if (run.goalStatus === 'active') parts.push('active goal')
    if (run.goalStatus === 'paused') parts.push('paused goal')
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
    <div
      role="listitem"
      className={cn('group relative min-w-0', active ? 'text-fg-strong' : '')}
    >
      <Tooltip content={runTooltip(run)}>
        <button
          type="button"
          ref={rowRef}
          tabIndex={tabIndex}
          data-session-row
        draggable={!nested && !renaming && !confirmingDelete}
        className={cn(
          'app-region-no-drag flex w-full min-w-0 items-center gap-1.5 pr-2 text-left vy-transition',
          'group-hover:pr-10 group-focus-within:pr-10 [@media(hover:none)]:pr-10',
          nested
            ? 'rounded-md px-1.5 py-1 text-xs leading-snug border-l-2 border-l-transparent'
            : SIDEBAR_ROW,
          active
            ? focused
              ? SIDEBAR_ROW_FOCUSED
              : SIDEBAR_ROW_OPEN
            : SIDEBAR_ROW_HOVER,
          !active && (nested ? 'text-muted' : 'text-fg/85'),
          dragging && 'opacity-50'
        )}
        aria-current={focused ? 'page' : undefined}
        aria-label={sessionAriaLabel}
        data-session-open={active ? '1' : '0'}
        data-session-focused={focused ? '1' : '0'}
        onClick={onSelect}
        onKeyDown={(e) => {
          // Same Delete-to-close pattern as dock/session tab strips; Esc cancels
          // inside InlineConfirmActions.
          if (e.key === 'Delete' && !renaming && !confirmingDelete) {
            e.preventDefault()
            setConfirmingDelete(true)
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
          if (nested || renaming || confirmingDelete) {
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
        <RunStatusDot run={run} />
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
        </button>
      </Tooltip>

      <div
        className={cn(
          'app-region-no-drag absolute inset-y-0 right-0 z-sticky flex items-center gap-px vy-transition pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100',
          '[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100',
          confirmingDelete && 'pointer-events-auto opacity-100'
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
              icon="edit"
              label={`Rename ${fullLabel}`}
              size="xs"
              variant="bare"
              className="text-muted hover:text-fg"
              onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
              onClick={(e) => {
                e.stopPropagation()
                setConfirmingDelete(false)
                setRenaming(true)
              }}
            />
            {onExportRun ? (
              <IconButton
                icon="download"
                label={`Export ${fullLabel} as Markdown`}
                size="xs"
                variant="bare"
                className="text-muted hover:text-fg"
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  onExportRun(workspacePath, run.runId)
                }}
              />
            ) : null}
            <IconButton
              icon="trash"
              label={`Delete ${fullLabel}`}
              size="xs"
              variant="bare"
              className="text-muted hover:text-danger"
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
    </div>
  )
})
