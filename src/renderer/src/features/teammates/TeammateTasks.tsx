import { useMemo, useState } from 'react'
import { Button, EmptyState, Tooltip, cn } from '@renderer/lib/ui'
import type { AgentProfile, DelegatedTask } from '@shared/ipc'
import { TaskRow } from './TaskRow'
import { compareTasksForDisplay, isTaskActive } from './taskPresentation'
import { isProfileUsableIn, unusableReason } from './teammatePresentation'

/** How much history a teammate shows before asking to see the rest. */
const HISTORY_PREVIEW = 5

/**
 * One teammate's queue and its history.
 *
 * The sidebar showed active work plus the two most recent finished tasks and
 * nothing else, so the record of what a teammate had actually done was
 * unreachable. Everything is here, behind one expand.
 */
export function TeammateTasks({
  profile,
  tasks,
  activeWorkspacePath,
  onAssign,
  onOpenRun,
  onRetry,
  onCancel
}: {
  profile: AgentProfile
  /** Every task belonging to this teammate, across open workspaces. */
  tasks: DelegatedTask[]
  activeWorkspacePath: string | null
  onAssign: () => void
  onOpenRun?: (workspacePath: string, runId: string) => void
  onRetry: (task: DelegatedTask) => void
  onCancel: (task: DelegatedTask) => void
}) {
  const [showAll, setShowAll] = useState(false)

  const { active, history } = useMemo(() => {
    const own = [...tasks].sort(compareTasksForDisplay)
    return {
      active: own.filter(isTaskActive),
      history: own.filter((t) => !isTaskActive(t))
    }
  }, [tasks])

  const shown = showAll ? history : history.slice(0, HISTORY_PREVIEW)
  const blocked = unusableReason(profile, activeWorkspacePath)
  const canAssign = Boolean(activeWorkspacePath) && isProfileUsableIn(profile, activeWorkspacePath)
  const assignHint = !activeWorkspacePath
    ? 'Open a workspace to assign work.'
    : (blocked ?? `Assign a task to ${profile.name}`)

  return (
    <section className="flex flex-col gap-2" aria-label={`Tasks for ${profile.name}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-xs font-normal tracking-[var(--vy-tracking)] text-muted">
          Tasks
          {active.length ? (
            <span className="ml-1.5 tabular-nums text-tertiary">{active.length} active</span>
          ) : null}
        </h3>
        <Tooltip content={assignHint}>
          <span className={canAssign ? 'inline-flex' : 'inline-flex cursor-not-allowed'}>
            <Button
              variant="subtle"
              onClick={onAssign}
              disabled={!canAssign}
              title={canAssign ? undefined : assignHint}
            >
              Assign task
            </Button>
          </span>
        </Tooltip>
      </div>

      {active.length === 0 && history.length === 0 ? (
        <EmptyState
          compact
          icon="listTodo"
          title="No tasks yet"
          description={`Hand ${profile.name} a brief and it runs on its own, now or at a time you choose.`}
        />
      ) : (
        <div className={cn('flex flex-col rounded-xl bg-surface', 'divide-y divide-border/40')}>
          {active.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              showWorkspace
              onOpenRun={onOpenRun}
              onRetry={onRetry}
              onCancel={onCancel}
            />
          ))}
          {shown.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              showWorkspace
              onOpenRun={onOpenRun}
              onRetry={onRetry}
              onCancel={onCancel}
            />
          ))}
        </div>
      )}

      {history.length > HISTORY_PREVIEW ? (
        <Button
          variant="ghost"
          className="self-start"
          onClick={() => setShowAll((prev) => !prev)}
          aria-expanded={showAll}
        >
          {showAll ? 'Show less' : `Show all ${history.length} finished tasks`}
        </Button>
      ) : null}
    </section>
  )
}
