import { useMemo } from 'react'
import type { ActiveRun, ToolApprovalDecision } from '@shared/ipc'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { Icon } from '@renderer/lib/icons'
import { Button } from '@renderer/lib/ui'
import { PAGE_TITLE } from '@renderer/lib/utils/layout'
import type { WorkspaceRuns } from '@renderer/app/navigator/types'
import { runTitle } from '@renderer/app/navigator/runTitle'
import { useWorkspaceGitSummaries } from './useWorkspaceGitSummaries'
import { useHomeActivity } from './useHomeActivity'
import { useMcpHealth } from './useMcpHealth'
import { useIndexStatus } from './useIndexStatus'
import { usePendingAsks } from './usePendingAsks'
import { HomeTaskField } from './components/HomeTaskField'
import { NeedsYouSection, type ProviderIssue, type WaitingTask } from './components/NeedsYouSection'
import { WorkspacesSection } from './components/WorkspacesSection'
import { ThisWeekSection } from './components/ThisWeekSection'

export type { ProviderIssue } from './components/NeedsYouSection'

export type HomePageProps = {
  openWorkspaces: string[]
  /** The active workspace: the field's default target, and whose MCP servers are checked. */
  activeWorkspace?: string | null
  runsByWorkspacePath: Record<string, WorkspaceRuns>
  activeRuns?: readonly ActiveRun[]
  /** Set by the caller when the provider the next task would use has no key. */
  providerIssue?: ProviderIssue | null
  onStartTask: (workspacePath: string, brief: string) => void
  onNewTaskInWorkspace: (workspacePath: string) => void
  onOpenTask: (workspacePath: string, runId: string) => void
  onOpenWorkspace: (workspacePath: string) => void
  onAddWorkspace: () => void
  onRespondApproval: (
    workspacePath: string,
    runId: string,
    requestId: string,
    decision: ToolApprovalDecision
  ) => Promise<void>
  onOpenProviderSettings?: () => void
  onOpenMcpServer?: (serverId: string) => void
  onReviewChangesInWorkspace?: (workspacePath: string) => void
  onOpenUsage: () => void
  refreshVersion?: number
}

/**
 * Home is where work starts. It does not repeat the navigator — running,
 * ready and done tasks are listed there, grouped the same way — so it holds
 * only what the navigator can't: a field to start a task, what is waiting on
 * you with its answer in place, the workspaces, and the week.
 */
export function HomePage({
  openWorkspaces,
  activeWorkspace,
  runsByWorkspacePath,
  activeRuns,
  providerIssue,
  onStartTask,
  onNewTaskInWorkspace,
  onOpenTask,
  onOpenWorkspace,
  onAddWorkspace,
  onRespondApproval,
  onOpenProviderSettings,
  onOpenMcpServer,
  onReviewChangesInWorkspace,
  onOpenUsage,
  refreshVersion = 0
}: HomePageProps) {
  const hasWorkspaces = openWorkspaces.length > 0
  const git = useWorkspaceGitSummaries(openWorkspaces, hasWorkspaces, refreshVersion)
  const activity = useHomeActivity(openWorkspaces, 7, refreshVersion)
  const mcp = useMcpHealth(activeWorkspace ?? null, hasWorkspaces, refreshVersion)
  const index = useIndexStatus(hasWorkspaces)

  const ownPath = (path: string): string | undefined => openWorkspaces.find((open) => workspacePathsEqual(open, path))

  // Longest wait first, as the navigator orders them: that one holds work up.
  const waiting = useMemo(
    () =>
      (activeRuns ?? [])
        .filter((run) => run.waiting && openWorkspaces.some((path) => workspacePathsEqual(path, run.workspacePath)))
        .sort((a, b) => Date.parse(a.waiting!.since) - Date.parse(b.waiting!.since)),
    [activeRuns, openWorkspaces]
  )
  const asks = usePendingAsks(waiting)
  const tasks: WaitingTask[] = waiting.map((run) => {
    const path = ownPath(run.workspacePath) ?? run.workspacePath
    const summary = runsByWorkspacePath[path]?.runs.find((r) => r.runId === run.runId)
    return { run, title: summary ? runTitle(summary) : 'Untitled task' }
  })

  // Running means working: a run parked on you is counted under Needs you.
  const runningByPath = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const run of activeRuns ?? []) {
      if (run.waiting) continue
      const path = openWorkspaces.find((open) => workspacePathsEqual(open, run.workspacePath))
      if (path) counts[path] = (counts[path] ?? 0) + 1
    }
    return counts
  }, [activeRuns, openWorkspaces])

  const indexingPath =
    index?.phase === 'syncing' && index.workspacePath ? (ownPath(index.workspacePath) ?? null) : null

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto" data-home>
      <div className="@container mx-auto w-full max-w-[880px] px-8 pb-12 pt-14">
        <h1 className={PAGE_TITLE}>What should the agent do?</h1>
        {hasWorkspaces ? (
          <>
            <HomeTaskField workspaces={openWorkspaces} defaultPath={activeWorkspace ?? null} onStart={onStartTask} />
            <NeedsYouSection
              tasks={tasks}
              asks={asks}
              providerIssue={providerIssue ?? null}
              mcpIssues={mcp.issues}
              serverNames={mcp.names}
              onDecide={(run, requestId, decision) =>
                onRespondApproval(ownPath(run.workspacePath) ?? run.workspacePath, run.runId, requestId, decision)
              }
              onOpenTask={(run) => onOpenTask(ownPath(run.workspacePath) ?? run.workspacePath, run.runId)}
              onOpenProviderSettings={onOpenProviderSettings}
              onOpenMcpServer={onOpenMcpServer}
              onRetryMcp={() => void mcp.retry()}
            />
            <div className="mt-10 grid gap-12 @3xl:grid-cols-[minmax(0,1fr)_280px]">
              <WorkspacesSection
                paths={openWorkspaces}
                git={git.data}
                gitLoading={git.loading}
                gitErrors={git.errors}
                runningByPath={runningByPath}
                indexingPath={indexingPath}
                onAdd={onAddWorkspace}
                onNewTask={onNewTaskInWorkspace}
                onOpenWorkspace={onOpenWorkspace}
                onReviewChanges={onReviewChangesInWorkspace}
                onRetryStatus={git.refresh}
              />
              <ThisWeekSection
                data={activity.data}
                loading={activity.loading}
                error={activity.error}
                onRetry={activity.refresh}
                onOpenUsage={onOpenUsage}
              />
            </div>
          </>
        ) : (
          <div className="mt-10 flex flex-col items-center justify-center rounded-lg border border-border px-8 py-14 text-center">
            <span className="grid size-10 place-items-center rounded-lg bg-surface text-muted">
              <Icon name="workspace" size={18} />
            </span>
            <div className="mt-3 text-sm font-medium text-fg-strong">No workspace yet</div>
            <p className="mt-1 max-w-[300px] text-xs leading-[18px] text-muted">
              Tasks run inside a folder you open. The agent never reaches outside it.
            </p>
            <Button variant="primary" size="sm" icon="folderOpen" className="mt-3" onClick={onAddWorkspace}>
              Open a workspace…
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
