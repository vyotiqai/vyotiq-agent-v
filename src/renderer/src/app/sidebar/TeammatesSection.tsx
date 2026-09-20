import { useMemo, useState } from 'react'
import { Avatar, Badge, IconButton, cn, pushToast } from '@renderer/lib/ui'
import {
  SIDEBAR_INDENT,
  SIDEBAR_ROW_HOVER,
  SIDEBAR_SECTION_LABEL
} from '@renderer/lib/utils/layout'
import { useAgentProfiles } from '@renderer/lib/hooks/useAgentProfiles'
import { useDelegatedTasks } from '@renderer/lib/hooks/useDelegatedTasks'
import { AssignTaskDialog } from '@renderer/features/teammates/AssignTaskDialog'
import {
  TASK_STATUS_LABEL,
  TASK_STATUS_TONE,
  taskControls,
  taskHeadline
} from '@renderer/features/teammates/taskPresentation'
import {
  isProfileUsableIn,
  unusableReason
} from '@renderer/features/teammates/teammatePresentation'
import { isTerminalDelegatedTaskStatus, type AgentProfile, type DelegatedTask } from '@shared/ipc'

/**
 * Sidebar teammate roster — the ambient view.
 *
 * This used to be the whole feature: create, edit, delete, assign, and the
 * task list, all inside a 248px column. Everything that needs room now lives
 * in the Teammates pane, and what stays here is what a sidebar is for — who
 * exists, who is working, and one click to start.
 *
 * Tasks shown are the ones that are running or want attention. Finished work
 * is history and belongs in the pane; leaving it here meant the sidebar showed
 * an arbitrary two of it and hid the rest.
 */

function sidebarTasksFor(
  tasks: DelegatedTask[],
  profileId: string,
  workspacePath: string | null
): DelegatedTask[] {
  return tasks
    .filter((t) => t.profileId === profileId)
    .filter((t) => !workspacePath || t.workspacePath === workspacePath)
    .filter((t) => !isTerminalDelegatedTaskStatus(t.status) || t.status === 'failed')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function TeammatesSection({
  onStartTeammateChat,
  onOpenTaskRun,
  onOpenTeammates,
  activeWorkspacePath = null
}: {
  /** Start a new chat in the active workspace bound to this teammate. */
  onStartTeammateChat?: (profileId: string) => void
  /** Open a task's session (run transcript) — the row is clickable when set. */
  onOpenTaskRun?: (workspacePath: string, runId: string) => void
  /** Open the Teammates pane, where everything else lives. */
  onOpenTeammates?: () => void
  /** Workspace new delegated tasks run against (the active one). */
  activeWorkspacePath?: string | null
}) {
  const { profiles, ready, error, clearError } = useAgentProfiles()
  const { tasks, error: taskError, enqueueTask, cancelTask, retryTask, clearError: clearTaskError } =
    useDelegatedTasks()
  const [assignTo, setAssignTo] = useState<AgentProfile | null>(null)

  const tasksByProfile = useMemo(() => {
    const out = new Map<string, DelegatedTask[]>()
    for (const profile of profiles) {
      out.set(profile.id, sidebarTasksFor(tasks, profile.id, activeWorkspacePath))
    }
    return out
  }, [profiles, tasks, activeWorkspacePath])

  const retry = async (task: DelegatedTask, profileName: string): Promise<void> => {
    const result = await retryTask(task.id)
    if (result.ok) pushToast(`Task reassigned to ${profileName}`)
    else pushToast(`Could not retry task — ${result.error}`, 'error')
  }

  return (
    <div className="mt-1" data-teammates-section>
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <p className={SIDEBAR_SECTION_LABEL}>Teammates</p>
        {onOpenTeammates ? (
          <IconButton
            icon="panels"
            size="xs"
            label="Open teammates"
            title="Manage teammates"
            className="app-region-no-drag"
            onClick={onOpenTeammates}
          />
        ) : null}
      </div>

      {/* Deleting a teammate can half-succeed — an override file that would
          not unlink, a run that refused to stop. The row vanishes either way,
          so without this the user is never told what was left behind. */}
      {error || taskError ? (
        <div
          role="alert"
          className={cn(
            SIDEBAR_INDENT,
            'mb-1 flex items-start gap-1 rounded-md bg-danger/10 py-1 pr-1'
          )}
        >
          <p className="m-0 min-w-0 flex-1 whitespace-pre-line text-2xs text-danger [overflow-wrap:anywhere]">
            {error ?? taskError}
          </p>
          <IconButton
            icon="close"
            size="xs"
            label="Dismiss teammate warning"
            onClick={() => {
              clearError()
              clearTaskError()
            }}
          />
        </div>
      ) : null}

      {profiles.length === 0 ? (
        <p className={cn(SIDEBAR_INDENT, 'm-0 pb-2 text-xs text-muted')}>
          {ready
            ? 'No teammates yet — persistent agents with their own memory.'
            : 'Loading teammates…'}
        </p>
      ) : (
        <div className="flex flex-col gap-0.5 pb-2">
          {profiles.map((profile) => {
            const own = tasksByProfile.get(profile.id) ?? []
            const usable = isProfileUsableIn(profile, activeWorkspacePath)
            const blocked = unusableReason(profile, activeWorkspacePath)
            return (
              <div key={profile.id}>
                <div
                  className={cn(
                    SIDEBAR_INDENT,
                    'group flex items-center gap-1.5 rounded-md pr-1 vy-transition',
                    SIDEBAR_ROW_HOVER
                  )}
                >
                  <button
                    type="button"
                    className="app-region-no-drag flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 text-left focus-visible:vy-focus-ring"
                    onClick={() => onStartTeammateChat?.(profile.id)}
                    disabled={!usable}
                    title={blocked ?? (onStartTeammateChat ? `New chat with ${profile.name}` : profile.name)}
                  >
                    <Avatar
                      name={profile.name}
                      icon={profile.avatar}
                      size="xs"
                      tone={usable ? 'accent' : 'muted'}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-fg">{profile.name}</span>
                  </button>
                  {/* Hidden actions reveal on hover, on keyboard focus, and on
                      touch. `opacity-0` alone leaves a button focusable but
                      invisible, and a touch device never reveals it at all. */}
                  <span className="flex shrink-0 items-center gap-0.5 opacity-0 vy-transition group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                    <IconButton
                      icon="plus"
                      size="xs"
                      label={`Assign task to ${profile.name}`}
                      title={
                        !activeWorkspacePath
                          ? 'Open a workspace to assign work.'
                          : (blocked ?? `Assign task to ${profile.name}`)
                      }
                      className="app-region-no-drag"
                      disabled={!activeWorkspacePath || !usable}
                      onClick={() => setAssignTo(profile)}
                    />
                    {onOpenTeammates ? (
                      <IconButton
                        icon="sliders"
                        size="xs"
                        label={`Open ${profile.name} in teammates`}
                        className="app-region-no-drag"
                        onClick={onOpenTeammates}
                      />
                    ) : null}
                  </span>
                </div>

                {own.map((task) => {
                  const controls = taskControls(task)
                  const headline = taskHeadline(task)
                  return (
                    <div
                      key={task.id}
                      className={cn(SIDEBAR_INDENT, 'group/task rounded-md py-0.5 pr-1')}
                      data-delegated-task={task.status}
                    >
                      <div className="flex items-center gap-1.5">
                        <Badge tone={TASK_STATUS_TONE[task.status]}>
                          {TASK_STATUS_LABEL[task.status]}
                        </Badge>
                        {task.runId && onOpenTaskRun ? (
                          <button
                            type="button"
                            className="app-region-no-drag min-w-0 flex-1 truncate rounded text-left text-xs text-muted vy-transition hover:text-fg focus-visible:vy-focus-ring"
                            title={`Open session — ${task.prompt}`}
                            data-testid="delegated-task-open"
                            onClick={() => onOpenTaskRun(task.workspacePath, task.runId as string)}
                          >
                            {headline}
                          </button>
                        ) : (
                          <span
                            className="min-w-0 flex-1 truncate text-xs text-muted"
                            title={task.prompt}
                          >
                            {headline}
                          </span>
                        )}
                        {controls.retry ? (
                          <IconButton
                            icon="refresh"
                            size="xs"
                            label={`Retry task: ${headline}`}
                            title="Retry this task"
                            data-testid="delegated-task-retry"
                            className="app-region-no-drag"
                            onClick={() => void retry(task, profile.name)}
                          />
                        ) : controls.cancel ? (
                          <IconButton
                            icon="close"
                            size="xs"
                            label={`Cancel task: ${headline}`}
                            title="Stop this task"
                            className="app-region-no-drag"
                            onClick={() => void cancelTask(task.id)}
                          />
                        ) : null}
                      </div>
                      {/* Why it failed. The record carried this all along and
                          the row never showed it, so a red "Failed" was the
                          whole story a user got. */}
                      {task.error ? (
                        <p
                          className={cn(
                            'm-0 line-clamp-2 pl-0.5 text-2xs [overflow-wrap:anywhere]',
                            task.status === 'failed' ? 'text-danger' : 'text-muted'
                          )}
                          title={task.error}
                          data-testid="delegated-task-error"
                        >
                          {task.error}
                        </p>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}

      <AssignTaskDialog
        profile={assignTo}
        workspacePath={activeWorkspacePath}
        onClose={() => setAssignTo(null)}
        onAssign={enqueueTask}
      />
    </div>
  )
}
