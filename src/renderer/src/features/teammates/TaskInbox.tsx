import { useMemo, useState, type ReactElement } from 'react'
import { EmptyState, Menu, SearchInput, cn } from '@renderer/lib/ui'
import { TEAMMATES_DETAIL_COLUMN } from '@renderer/lib/utils/layout'
import type { AgentProfile, DelegatedTask } from '@shared/ipc'
import { TaskRow } from './TaskRow'
import { activeWorkSummary, compareTasksForDisplay, isTaskActive } from './taskPresentation'
import { workspaceLabel } from './teammatePresentation'

const ALL = '__all__'

/**
 * Every teammate's work in one list.
 *
 * `tasksList` and the tasks push have always returned the full aggregated
 * queue; the sidebar filtered it down to one teammate in one workspace and
 * discarded the rest, so work running in another project was invisible.
 *
 * Scope note: main's cache holds the workspaces this session has opened, so
 * this is "across your open workspaces" — not every queue that exists on disk.
 * The subtitle says so rather than implying coverage it does not have.
 */
export function TaskInbox({
  tasks,
  profiles,
  ready,
  openWorkspaces,
  onOpenRun,
  onRetry,
  onCancel
}: {
  tasks: DelegatedTask[]
  profiles: AgentProfile[]
  ready: boolean
  /** Retry re-enqueues, which main refuses for a workspace that is not open. */
  openWorkspaces?: readonly string[]
  onOpenRun?: (workspacePath: string, runId: string) => void
  onRetry: (task: DelegatedTask) => void
  onCancel: (task: DelegatedTask) => void
}) {
  const [query, setQuery] = useState('')
  const [teammate, setTeammate] = useState(ALL)

  const byId = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return tasks
      .filter((task) => {
        if (teammate !== ALL && task.profileId !== teammate) return false
        if (!q) return true
        const name = byId.get(task.profileId)?.name ?? ''
        return (
          task.prompt.toLowerCase().includes(q) ||
          name.toLowerCase().includes(q) ||
          workspaceLabel(task.workspacePath).toLowerCase().includes(q)
        )
      })
      .sort(compareTasksForDisplay)
  }, [tasks, teammate, query, byId])

  const active = filtered.filter(isTaskActive)
  const recent = filtered.filter((t) => !isTaskActive(t))
  const overall = activeWorkSummary(tasks)
  const filtering = Boolean(query.trim()) || teammate !== ALL

  const row = (task: DelegatedTask): ReactElement => {
    const profile = byId.get(task.profileId)
    return (
      <TaskRow
        key={task.id}
        task={task}
        // A deleted teammate's finished tasks stay in history, so the name can
        // genuinely be gone. Say so rather than rendering a blank avatar.
        teammateName={profile?.name ?? 'Deleted teammate'}
        teammateAvatar={profile?.avatar}
        showWorkspace
        openWorkspaces={openWorkspaces}
        onOpenRun={onOpenRun}
        onRetry={onRetry}
        onCancel={onCancel}
      />
    )
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-task-inbox>
      <header className="shrink-0 border-b border-border/60 px-5 pb-3 pt-4">
        <div className={TEAMMATES_DETAIL_COLUMN}>
          <h2 className="m-0 text-heading font-medium tracking-[var(--vy-tracking)] text-fg-strong">
            All tasks
          </h2>
          <p className="m-0 mt-0.5 text-2xs text-muted">
            {overall.label
              ? `${overall.label} across your open workspaces`
              : 'Across your open workspaces'}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <SearchInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onClear={() => setQuery('')}
              placeholder="Search tasks"
              aria-label="Search tasks"
              className="min-w-[12rem] flex-1"
            />
            <Menu
              value={teammate}
              options={[
                { value: ALL, label: 'All teammates' },
                ...profiles.map((p) => ({ value: p.id, label: p.name }))
              ]}
              aria-label="Filter by teammate"
              placement="down"
              onChange={setTeammate}
            />
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className={cn(TEAMMATES_DETAIL_COLUMN, 'flex flex-col gap-4')}>
          {filtered.length === 0 ? (
            <EmptyState
              icon="listTodo"
              title={
                ready ? (filtering ? 'No task matches that' : 'No tasks yet') : 'Loading tasks…'
              }
              description={
                ready && !filtering
                  ? 'Pick a teammate on the left and hand it a brief — it runs on its own, now or at a time you choose.'
                  : undefined
              }
            />
          ) : (
            <>
              {active.length ? (
                <section aria-label="Active tasks" className="flex flex-col gap-1">
                  <h3 className="m-0 px-0.5 text-xs font-normal tracking-[var(--vy-tracking)] text-muted">
                    Active
                    <span className="ml-1.5 tabular-nums text-tertiary">{active.length}</span>
                  </h3>
                  <div className="flex flex-col divide-y divide-border/60 rounded-xl bg-surface">
                    {active.map(row)}
                  </div>
                </section>
              ) : null}

              {recent.length ? (
                <section aria-label="Finished tasks" className="flex flex-col gap-1">
                  <h3 className="m-0 px-0.5 text-xs font-normal tracking-[var(--vy-tracking)] text-muted">
                    Finished
                    <span className="ml-1.5 tabular-nums text-tertiary">{recent.length}</span>
                  </h3>
                  <div className="flex flex-col divide-y divide-border/60 rounded-xl bg-surface">
                    {recent.map(row)}
                  </div>
                </section>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
