import { Avatar, Badge, IconButton, cn } from '@renderer/lib/ui'
import { workspaceLabel } from './teammatePresentation'
import {
  TASK_STATUS_LABEL,
  TASK_STATUS_TONE,
  taskControls,
  taskHeadline,
  taskTiming
} from './taskPresentation'
import type { DelegatedTask } from '@shared/ipc'

/**
 * One delegated task, everywhere tasks are listed.
 *
 * Shows what the record has always held and no surface ever rendered: when a
 * scheduled task fires, how long a finished one took, why a failed one failed,
 * and whether this attempt replaced an earlier one.
 */
export function TaskRow({
  task,
  teammateName,
  teammateAvatar,
  showWorkspace = false,
  onOpenRun,
  onRetry,
  onCancel
}: {
  task: DelegatedTask
  /** Shown in the inbox, where rows from several teammates are mixed. */
  teammateName?: string
  teammateAvatar?: string
  showWorkspace?: boolean
  onOpenRun?: (workspacePath: string, runId: string) => void
  onRetry?: (task: DelegatedTask) => void
  onCancel?: (task: DelegatedTask) => void
}) {
  const headline = taskHeadline(task)
  const timing = taskTiming(task)
  const controls = taskControls(task)
  const openable = Boolean(task.runId && onOpenRun)

  return (
    <div
      className="group flex items-start gap-2 rounded-lg px-2 py-2 vy-transition hover:bg-surface/40"
      data-delegated-task={task.status}
    >
      {teammateName ? (
        <Avatar name={teammateName} icon={teammateAvatar} size="sm" className="mt-0.5" />
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <Badge tone={TASK_STATUS_TONE[task.status]} dot={task.status === 'running'}>
            {TASK_STATUS_LABEL[task.status]}
          </Badge>
          {openable ? (
            <button
              type="button"
              className="min-w-0 flex-1 truncate rounded text-left text-sm text-fg vy-transition hover:text-fg-strong focus-visible:vy-focus-ring"
              title={`Open session — ${task.prompt}`}
              data-testid="delegated-task-open"
              onClick={() => onOpenRun?.(task.workspacePath, task.runId as string)}
            >
              {headline}
            </button>
          ) : (
            <span className="min-w-0 flex-1 truncate text-sm text-fg" title={task.prompt}>
              {headline}
            </span>
          )}
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted">
          {teammateName ? <span className="truncate">{teammateName}</span> : null}
          {showWorkspace ? <span className="truncate">{workspaceLabel(task.workspacePath)}</span> : null}
          {timing ? <span>{timing}</span> : null}
          {/* Provenance was written and never shown, so a second attempt read
              exactly like a first one. */}
          {task.retryOf ? <span>Retry of an earlier attempt</span> : null}
        </div>

        {task.error ? (
          <p
            className={cn(
              'm-0 line-clamp-2 text-2xs [overflow-wrap:anywhere]',
              task.status === 'failed' ? 'text-danger' : 'text-muted'
            )}
            title={task.error}
            data-testid="delegated-task-error"
          >
            {task.error}
          </p>
        ) : null}
      </div>

      <span className="flex shrink-0 items-center gap-0.5 opacity-0 vy-transition group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
        {controls.retry && onRetry ? (
          <IconButton
            icon="refresh"
            size="xs"
            label={task.status === 'done' ? `Run again: ${headline}` : `Retry task: ${headline}`}
            title={task.status === 'done' ? 'Run this task again' : 'Retry this task'}
            data-testid="delegated-task-retry"
            onClick={() => onRetry(task)}
          />
        ) : null}
        {controls.cancel && onCancel ? (
          <IconButton
            icon="close"
            size="xs"
            label={`Cancel task: ${headline}`}
            title="Stop this task"
            onClick={() => onCancel(task)}
          />
        ) : null}
      </span>
    </div>
  )
}
