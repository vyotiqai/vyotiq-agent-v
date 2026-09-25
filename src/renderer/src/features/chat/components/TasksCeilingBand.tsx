import { useEffect, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import { useRunSession } from '../RunSessionContext'
import { useRunTodos } from '../hooks/useRunTodos'
import { pickCurrentTask } from '../toolUi/parsers/todo'
import { TodoChecklist, TodoStatusIcon } from './TodoChecklist'

/** Progress bar shared by the expanded band and the Plan Tasks section. */
export function TodoProgressBar({
  done,
  total,
  className
}: {
  done: number
  total: number
  className?: string
}) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <div
      className={cn('h-1 w-full overflow-hidden rounded-full bg-surface-2', className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={`Tasks ${done} of ${total} complete`}
    >
      <div
        className="h-full rounded-full bg-accent vy-transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

/**
 * One-liner task strip directly under the task-owning user prompt. Expands in
 * place; same ~840px column, no blank card chrome. Shows resolved status
 * counts (cancelled excluded from the fraction, still listed) and a progress
 * bar when expanded.
 */
export function TasksCeilingBand({
  workspacePath: workspacePathProp,
  runId: runIdProp,
  running = false,
  className
}: {
  workspacePath?: string | null
  runId?: string | null
  running?: boolean
  className?: string
}) {
  const session = useRunSession()
  const workspacePath =
    workspacePathProp !== undefined ? workspacePathProp : session.workspacePath
  const runId = runIdProp !== undefined ? runIdProp : session.runId
  const { data } = useRunTodos({
    workspacePath,
    runId,
    running,
    active: true
  })
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    setExpanded(false)
  }, [runId])

  const items = data?.items ?? []
  if (items.length === 0) return null

  const current = pickCurrentTask(items)
  if (!current) return null

  const done = data?.done ?? 0
  const total = data?.total ?? items.length
  const cancelled = items.filter((item) => item.status === 'cancelled').length
  const label = `${done}/${total}`

  return (
    <div className={cn('w-full min-w-0', className)} data-tasks-ceiling>
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 py-1.5 text-left"
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse tasks' : `Expand tasks: ${current.content}`}
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Expanded, the checklist below carries every task in plan order, so
            the header drops to the same uppercase section label the Plan panel
            uses. Naming the current task here too printed it twice, stacked —
            and dropping it from the checklist instead would hoist a mid-plan
            task above the ones it follows. */}
        {expanded ? (
          <Icon name="listTodo" size={14} className="shrink-0 text-muted" />
        ) : (
          <TodoStatusIcon status={current.status} size={14} />
        )}
        <span
          className={cn(
            'min-w-0 flex-1 truncate',
            expanded
              ? 'text-2xs font-medium uppercase tracking-[var(--vy-tracking-caps)] text-muted'
              : 'text-caption font-medium text-fg'
          )}
        >
          {expanded ? 'Tasks' : current.content}
        </span>
        {cancelled > 0 ? (
          <span
            className="shrink-0 tabular-nums text-2xs text-muted"
            title={`${cancelled} cancelled`}
          >
            {cancelled} skipped
          </span>
        ) : null}
        <span className="shrink-0 tabular-nums text-caption text-muted">{label}</span>
        <Icon
          name="chevron"
          size={14}
          className={cn(
            'shrink-0 text-muted transition-transform',
            expanded && 'rotate-180'
          )}
        />
      </button>
      {expanded ? (
        <div className="pb-2" data-tasks-ceiling-progress>
          <TodoProgressBar done={done} total={total} />
          <TodoChecklist items={items} className="mt-1.5" />
        </div>
      ) : null}
    </div>
  )
}
