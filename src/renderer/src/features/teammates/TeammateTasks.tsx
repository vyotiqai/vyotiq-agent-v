import { useMemo, useState } from 'react'
import { Button, EmptyState } from '@renderer/lib/ui'
import type { AgentProfile, DelegatedTask } from '@shared/ipc'
import { TaskRow } from './TaskRow'
import { compareTasksForDisplay, isTaskActive } from './taskPresentation'

/** How much history a teammate shows before asking to see the rest. */
const HISTORY_PREVIEW = 5

/**
 * One teammate's queue and its history.
 *
 * The sidebar showed active work plus the two most recent finished tasks and
 * nothing else, so the record of what a teammate had actually done was
 * unreachable. Everything is here, behind one expand.
 *
 * No header of its own any more: the detail pane's own header carries the name
 * and the Assign button, and a second "Tasks" heading directly beneath it was
 * a title for a panel you had already chosen.
 */
export function TeammateTasks({
  profile,
  tasks,
  canAssign,
  assignHint,
  openWorkspaces,
  onAssign,
  onOpenRun,
  onRetry,
  onCancel
}: {
  profile: AgentProfile
  /** Every task belonging to this teammate, across open workspaces. */
  tasks: DelegatedTask[]
  canAssign: boolean
  /** Why assigning is unavailable, when it is — shown on the disabled button. */
  assignHint: string
  /** Retry re-enqueues, which main refuses for a workspace that is not open. */
  openWorkspaces?: readonly string[]
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

  if (active.length === 0 && history.length === 0) {
    return (
      <EmptyState
        icon="listTodo"
        title="No tasks yet"
        description={`Hand ${profile.name} a brief and it runs on its own, now or at a time you choose.`}
        action={
          <Button
            variant="subtle"
            onClick={onAssign}
            disabled={!canAssign}
            title={canAssign ? undefined : assignHint}
          >
            Assign a task
          </Button>
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {active.length ? (
        <section aria-label="Active tasks" className="flex flex-col gap-1">
          <h3 className="m-0 px-0.5 text-xs font-normal tracking-[var(--vy-tracking)] text-muted">
            Active
            <span className="ml-1.5 tabular-nums text-tertiary">{active.length}</span>
          </h3>
          <div className="flex flex-col divide-y divide-border/60 rounded-xl bg-surface">
            {active.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                showWorkspace
                openWorkspaces={openWorkspaces}
                onOpenRun={onOpenRun}
                onRetry={onRetry}
                onCancel={onCancel}
              />
            ))}
          </div>
        </section>
      ) : null}

      {history.length ? (
        <section aria-label="Finished tasks" className="flex flex-col gap-1">
          <h3 className="m-0 px-0.5 text-xs font-normal tracking-[var(--vy-tracking)] text-muted">
            Finished
            <span className="ml-1.5 tabular-nums text-tertiary">{history.length}</span>
          </h3>
          <div className="flex flex-col divide-y divide-border/60 rounded-xl bg-surface">
            {shown.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                showWorkspace
                openWorkspaces={openWorkspaces}
                onOpenRun={onOpenRun}
                onRetry={onRetry}
                onCancel={onCancel}
              />
            ))}
          </div>
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
      ) : null}
    </div>
  )
}
