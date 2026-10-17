import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ActiveRun, ToolApprovalDecision } from '@shared/ipc'
import type { TaskSchedule } from '@shared/ipc/schemas/schedules'
import type { HomeBackdrop as HomeBackdropKind } from '@shared/appearance'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { Icon } from '@renderer/lib/icons'
import { Button } from '@renderer/lib/ui'
import type { WorkspaceRuns } from '@renderer/app/navigator/types'
import { runTitle } from '@renderer/app/navigator/runTitle'
import type { NavRow } from '@renderer/app/navigator/navigatorModel'
import { useWorkspaceGitSummaries } from './useWorkspaceGitSummaries'
import { useHomeActivity } from './useHomeActivity'
import { useMcpHealth } from './useMcpHealth'
import { useIndexStatus } from './useIndexStatus'
import { usePendingAsks } from './usePendingAsks'
import { factKeys } from './daySentence'
import { homeDayModel } from './dayModel'
import { NeedsYouSection, type ProviderIssue, type WaitingTask } from './components/NeedsYouSection'
import { WorkspacesSection } from './components/WorkspacesSection'
import { ThisWeekSection } from './components/ThisWeekSection'
import { ComingUpSection } from './components/ComingUpSection'
import { ScreensSection } from './components/ScreensSection'
import { HomeBackdrop } from './components/HomeBackdrop'
import {
  DayHead,
  HOME_DETAIL_ID,
  HomeFootLine,
  REGION_OF,
  Sentence,
  TaskRowsSection,
  type HomeRegion
} from './components/DaySentence'
import type { PinnedScreen } from '@renderer/features/screens/screensStore'

export type { ProviderIssue } from './components/NeedsYouSection'

export type HomePageProps = {
  openWorkspaces: string[]
  /** The active workspace: whose MCP servers are checked. */
  activeWorkspace?: string | null
  runsByWorkspacePath: Record<string, WorkspaceRuns>
  activeRuns?: readonly ActiveRun[]
  /** Set by the caller when the provider the next task would use has no key. */
  providerIssue?: ProviderIssue | null
  /** Settings › Appearance › Your name: the greeting. Empty or absent: none. */
  userName?: string
  /** Settings › Appearance › Home backdrop. Absent: none. */
  backdrop?: { kind: HomeBackdropKind; imageStamp: string }
  /** The New task brief, under the sentence: the composer's own, built by the app. */
  brief?: ReactNode
  /** A workspace row's New task: the brief above starts there. */
  onNewTaskInWorkspace: (workspacePath: string) => void
  onOpenTask: (workspacePath: string, runId: string) => void
  /** A failed task's Retry, from its row under the sentence. */
  onRetryTask?: (workspacePath: string, runId: string) => void
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
  /** A view pinned from a task, opened on its saved layout. */
  onOpenScreen?: (pinned: PinnedScreen) => void
  refreshVersion?: number
}

/**
 * Now, moved on at each minute's turn: the day, "at 16:00" vs "tomorrow" and
 * the 24-hour failed window all read it, so Home never says "Saturday" past
 * midnight. (useSharedNow ticks at 1 Hz, which would re-render all of Home
 * every second for a value that changes once a minute.)
 */
function useMinuteNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let timer = 0
    const arm = (): void => {
      timer = window.setTimeout(
        () => {
          setNow(new Date())
          arm()
        },
        60_000 - (Date.now() % 60_000) + 50
      )
    }
    arm()
    return () => window.clearTimeout(timer)
  }, [])
  return now
}

/**
 * Home leads with the day and one sentence: what is waiting on you, what
 * runs, what is ready for review, what runs next on its own and what is
 * uncommitted. Each fact opens its rows in place under the sentence, one at
 * a time; the first that wants you starts open. Under that, New task: the
 * brief, so what is going on and what to start next read as one page. The
 * workspaces and the week sit on one quiet line at the foot, opening the
 * same way, so every section Home had stays one click away. Pinned views
 * stay on the page.
 */
export function HomePage({
  openWorkspaces,
  activeWorkspace,
  runsByWorkspacePath,
  activeRuns,
  providerIssue,
  userName = '',
  backdrop,
  brief,
  onNewTaskInWorkspace,
  onOpenTask,
  onRetryTask,
  onOpenWorkspace,
  onAddWorkspace,
  onRespondApproval,
  onOpenProviderSettings,
  onOpenMcpServer,
  onReviewChangesInWorkspace,
  onOpenUsage,
  onOpenScreen,
  refreshVersion = 0
}: HomePageProps) {
  const hasWorkspaces = openWorkspaces.length > 0
  const git = useWorkspaceGitSummaries(openWorkspaces, hasWorkspaces, refreshVersion)
  const activity = useHomeActivity(openWorkspaces, 7, refreshVersion)
  const mcp = useMcpHealth(activeWorkspace ?? null, hasWorkspaces, refreshVersion)
  const index = useIndexStatus(hasWorkspaces)
  const now = useMinuteNow()

  const [schedules, setSchedules] = useState<TaskSchedule[]>([])
  useEffect(() => {
    let cancelled = false
    void window.vyotiq?.listSchedules?.().then((res) => {
      if (!cancelled && res?.ok) setSchedules(res.data.schedules)
    })
    return () => {
      cancelled = true
    }
  }, [refreshVersion])

  const ownPath = (path: string): string | undefined => openWorkspaces.find((open) => workspacePathsEqual(open, path))

  // The same model the agent's read_home reads: what the sentence says is what it would say.
  const changedFiles = useMemo(
    () => Object.fromEntries(Object.entries(git.data).map(([path, s]) => [path, s.changedFiles])),
    [git.data]
  )
  const model = useMemo(
    () =>
      homeDayModel({
        openWorkspaces,
        activeWorkspace: activeWorkspace ?? null,
        runsByWorkspacePath,
        activeRuns,
        providerIssue: Boolean(providerIssue),
        mcpIssues: mcp.issues.length,
        schedules,
        changedFiles,
        doneThisWeek: activity.data?.outcomes.done ?? null,
        userName,
        now
      }),
    [
      openWorkspaces,
      activeWorkspace,
      runsByWorkspacePath,
      activeRuns,
      providerIssue,
      mcp.issues.length,
      schedules,
      changedFiles,
      activity.data,
      userName,
      now
    ]
  )
  const { waiting, running, review, failed, issues, segments } = model
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

  // The first fact that wants you starts open; a quiet day starts closed. A
  // region whose fact has left the sentence (its task answered) can't stay
  // open over nothing: the choice falls back. The foot's two stay openable.
  const regions = new Set<HomeRegion>([...factKeys(segments).map((k) => REGION_OF[k]), 'workspaces', 'week'])
  const firstWant = factKeys(segments).find((k) => k === 'needs' || k === 'failed' || k === 'review') ?? null
  const [chosen, setChosen] = useState<{ region: HomeRegion | null } | null>(null)
  const open: HomeRegion | null =
    chosen && (chosen.region === null || regions.has(chosen.region)) ? chosen.region : firstWant ? REGION_OF[firstWant] : null
  const toggle = (region: HomeRegion): void => setChosen({ region: open === region ? null : region })

  const indexingPath =
    index?.phase === 'syncing' && index.workspacePath ? (ownPath(index.workspacePath) ?? null) : null

  const openRow = (row: NavRow): void => onOpenTask(row.workspacePath, row.runId)

  const detail = (region: HomeRegion): ReactNode => {
    switch (region) {
      case 'needs':
        return (
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
        )
      case 'failed':
        return (
          <TaskRowsSection
            id="home-failed"
            label="Failed"
            rows={failed}
            onOpen={openRow}
            {...(onRetryTask ? { onRetry: (row: NavRow) => onRetryTask(row.workspacePath, row.runId) } : {})}
          />
        )
      case 'running':
        return <TaskRowsSection id="home-running" label="Running" rows={running} onOpen={openRow} />
      case 'review':
        return <TaskRowsSection id="home-review" label="Ready for review" rows={review} onOpen={openRow} />
      case 'schedule':
        return <ComingUpSection openWorkspaces={openWorkspaces} refreshVersion={refreshVersion} />
      case 'workspaces':
        return (
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
        )
      case 'week':
        return (
          <ThisWeekSection
            data={activity.data}
            loading={activity.loading}
            error={activity.error}
            onRetry={activity.refresh}
            onOpenUsage={onOpenUsage}
          />
        )
    }
  }

  return (
    <div className="scroll-thin relative min-h-0 flex-1 overflow-y-auto" data-home>
      {hasWorkspaces && backdrop && backdrop.kind !== 'none' ? (
        <HomeBackdrop kind={backdrop.kind} imageStamp={backdrop.imageStamp} />
      ) : null}
      {/* 844 = the record's 780 measure + the gutters: the brief here is as wide as the steps it becomes. */}
      <div className="@container relative mx-auto w-full max-w-[844px] px-8 pb-12 pt-14">
        {hasWorkspaces ? (
          <>
            <DayHead now={now} wants={waiting.length + issues > 0} />
            <Sentence segments={segments} open={open} onToggle={toggle} />
            {/* One region at a time, under the sentence: what every fact and foot item names in aria-controls. */}
            <div id={HOME_DETAIL_ID} className={open ? 'mt-8' : undefined} data-home-detail={open ?? ''}>
              {open ? detail(open) : null}
            </div>
            {brief ? <div className="mt-12">{brief}</div> : null}
            {/* Pinned views stay on the page: glances the person chose, not a fact. Nothing renders without a pin. */}
            {onOpenScreen ? <ScreensSection openWorkspaces={openWorkspaces} onOpenScreen={onOpenScreen} /> : null}
            <HomeFootLine
              workspaces={openWorkspaces.length}
              activity={activity.data}
              open={open}
              onToggle={toggle}
              onOpenUsage={onOpenUsage}
            />
          </>
        ) : (
          <>
            <DayHead now={now} wants={false} />
            <div className="mt-10 flex flex-col items-center justify-center px-8 py-14 text-center">
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
          </>
        )}
      </div>
    </div>
  )
}
