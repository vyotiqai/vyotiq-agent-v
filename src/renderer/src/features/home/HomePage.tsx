import { useMemo, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { AlertBlock, Button, PageHeader, cn, pushToast } from '@renderer/lib/ui'
import { useNotifications } from '@renderer/lib/hooks/useNotifications'
import type { WorkspaceSidebarRuns } from '@renderer/app/sidebar/types'
import { pinnedRunKey } from './pinnedRuns'
import { useRunStats } from './useRunStats'
import { useWorkspaceGitSummaries } from './useWorkspaceGitSummaries'
import { useHomeActivity, type ActivityWindowDays } from './useHomeActivity'
import { useMcpHealth } from './useMcpHealth'
import {
  attentionGroups,
  attentionHomeEntries,
  blockedKeysForEntries,
  blockedRunTargets,
  flattenHomeEntries,
  homeEntryKey,
  inFlightHomeEntries,
  isRunningEntry,
  pinnedHomeEntries,
  stateOfHomeEntry,
  type HomeEntry,
  type HomeEntryState
} from './homeEntries'
import { HomeCard, HomeSection } from './components/HomeSection'
import { AttentionLane } from './components/AttentionLane'
import { SessionLine, type SessionLineAction } from './components/SessionLine'
import { RepositoryLine } from './components/RepositoryLine'
import { ActivitySection } from './components/ActivitySection'
import { EnvironmentSection, type ProviderIssue } from './components/EnvironmentSection'

export type HomePageProps = {
  openWorkspaces: string[]
  /** Workspace whose MCP configuration the Environment section reports on. */
  activeWorkspace?: string | null
  runsByWorkspacePath: Record<string, WorkspaceSidebarRuns>
  activeRuns?: { runId: string; workspacePath: string }[]
  workspaceHasBackgroundRun?: (path: string) => boolean
  /** Set by the caller when the provider the next run would use has no key. */
  providerIssue?: ProviderIssue | null
  onNewSessionInWorkspace: (path: string, goal: string) => void
  onSelectRunInWorkspace: (path: string, runId: string) => void
  onSwitchWorkspace: (path: string) => void
  onAddWorkspace: () => void
  /** Environment section: jump to the provider settings that need a key. */
  onOpenProviderSettings?: () => void
  /** Environment section: open a specific MCP server's Marketplace entry. */
  onOpenMcpServer?: (serverId: string) => void
  onStopRunInWorkspace?: (path: string, runId: string) => Promise<void> | void
  /**
   * Continues a run the app left interrupted. Resuming needs the run's stream
   * controller, which only exists once the session is open, so the caller opens
   * it first — Home cannot resume on its own.
   */
  onResumeRunInWorkspace?: (path: string, runId: string) => Promise<void> | void
  onReviewChangesInWorkspace?: (path: string, runId?: string) => void
  onRefreshWorkspaceRuns?: (path: string) => Promise<void> | void
  isRunOpenInPane?: (path: string, runId: string) => boolean
  isRunFocusedInPane?: (path: string, runId: string) => boolean
  pinnedRunKeys: string[]
  onTogglePinnedRun: (key: string) => void
  refreshVersion?: number
}

/**
 * Home is a briefing, not a second session list: it answers what is blocked on
 * the user, what is still moving, what the repositories look like, what the
 * work cost, and what is misconfigured. Session navigation stays in the
 * sidebar, so no section here repeats it — and a run claimed by one section is
 * excluded from the ones below it.
 */
export function HomePage({
  openWorkspaces,
  activeWorkspace,
  runsByWorkspacePath,
  activeRuns,
  workspaceHasBackgroundRun,
  providerIssue,
  onNewSessionInWorkspace,
  onSelectRunInWorkspace,
  onSwitchWorkspace,
  onAddWorkspace,
  onOpenProviderSettings,
  onOpenMcpServer,
  onStopRunInWorkspace,
  onResumeRunInWorkspace,
  onReviewChangesInWorkspace,
  onRefreshWorkspaceRuns,
  isRunOpenInPane,
  isRunFocusedInPane,
  pinnedRunKeys,
  onTogglePinnedRun,
  refreshVersion = 0
}: HomePageProps) {
  const [windowDays, setWindowDays] = useState<ActivityWindowDays>(7)
  const [refreshing, setRefreshing] = useState(false)
  const [statusMessage, setStatusMessage] = useState('')
  const [busyTokens, setBusyTokens] = useState<ReadonlySet<string>>(new Set())

  const hasWorkspaces = openWorkspaces.length > 0
  const entries = useMemo(
    () => flattenHomeEntries(openWorkspaces, runsByWorkspacePath),
    [openWorkspaces, runsByWorkspacePath]
  )
  const activeKeys = useMemo(
    () => new Set((activeRuns ?? []).map((run) => pinnedRunKey(run.workspacePath, run.runId))),
    [activeRuns]
  )

  const { items: notifications } = useNotifications()
  const blockedTargets = useMemo(() => blockedRunTargets(notifications), [notifications])
  const blockedKeys = useMemo(
    () => blockedKeysForEntries(entries, blockedTargets),
    [blockedTargets, entries]
  )
  const stats = useRunStats(openWorkspaces, runsByWorkspacePath, refreshVersion)
  const git = useWorkspaceGitSummaries(openWorkspaces, hasWorkspaces, refreshVersion)
  const activity = useHomeActivity(openWorkspaces, windowDays, refreshVersion)
  const mcp = useMcpHealth(activeWorkspace ?? null, hasWorkspaces, refreshVersion)

  const attention = useMemo(
    () => attentionHomeEntries(entries, stats.data, activeKeys, blockedKeys),
    [activeKeys, blockedKeys, entries, stats.data]
  )
  const lanes = useMemo(() => attentionGroups(attention), [attention])

  const attentionKeys = useMemo(() => new Set(attention.map(homeEntryKey)), [attention])
  const inFlight = useMemo(
    () => inFlightHomeEntries(entries, activeKeys, attentionKeys),
    [activeKeys, attentionKeys, entries]
  )
  const shownKeys = useMemo(() => {
    const keys = new Set(attentionKeys)
    for (const entry of inFlight) keys.add(homeEntryKey(entry))
    return keys
  }, [attentionKeys, inFlight])
  const pinned = useMemo(
    () => pinnedHomeEntries(entries, pinnedRunKeys, shownKeys),
    [entries, pinnedRunKeys, shownKeys]
  )
  /** Whether the session half of the page has anything in it at all. */
  const hasSessionRows = lanes.length > 0 || inFlight.length > 0 || pinned.length > 0
  // Counted off the In flight rows so the header partitions the page: a run
  // awaiting an answer is counted once, under "needs you".
  const runningCount = useMemo(
    () => inFlight.filter((entry) => isRunningEntry(entry, activeKeys)).length,
    [activeKeys, inFlight]
  )
  const lastActivityByPath = useMemo(() => {
    const result: Record<string, string | undefined> = {}
    for (const path of openWorkspaces) {
      result[path] = runsByWorkspacePath[path]?.runs[0]?.updatedAt
    }
    return result
  }, [openWorkspaces, runsByWorkspacePath])

  const refreshAll = async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    setStatusMessage('Updating Home')
    try {
      await Promise.all(openWorkspaces.map((path) => onRefreshWorkspaceRuns?.(path)))
      stats.refresh()
      git.refresh()
      activity.refresh()
      mcp.refresh()
      setStatusMessage('Home updated')
    } finally {
      setRefreshing(false)
    }
  }

  const refreshDerived = (): void => {
    stats.refresh()
    git.refresh()
    activity.refresh()
  }

  /**
   * Runs one row action with that button pending.
   *
   * The token is per row *and* per action, because a single run can be running,
   * pursuing a goal and holding an armed loop at once — three buttons on one
   * row, each of which has to spin on its own.
   */
  const runRowAction = async (token: string, work: () => Promise<void>): Promise<void> => {
    if (busyTokens.has(token)) return
    setBusyTokens((current) => new Set(current).add(token))
    try {
      await work()
    } finally {
      setBusyTokens((current) => {
        const next = new Set(current)
        next.delete(token)
        return next
      })
    }
  }

  const stopRun = (entry: HomeEntry): Promise<void> =>
    runRowAction(`${homeEntryKey(entry)}#stop`, async () => {
      await onStopRunInWorkspace?.(entry.workspacePath, entry.run.runId)
      refreshDerived()
    })

  const resumeRun = (entry: HomeEntry): Promise<void> =>
    runRowAction(`${homeEntryKey(entry)}#resume`, async () => {
      await onResumeRunInWorkspace?.(entry.workspacePath, entry.run.runId)
      refreshDerived()
    })

  const pauseGoal = (entry: HomeEntry, live: boolean): Promise<void> =>
    runRowAction(`${homeEntryKey(entry)}#goal`, async () => {
      const res = await window.vyotiq?.setGoalStatus({
        workspacePath: entry.workspacePath,
        runId: entry.run.runId,
        action: 'pause'
      })
      if (!res) return
      if (!res.ok) {
        pushToast(res.error, 'error')
        return
      }
      // Same order as the goal banner in chat: pause the standing intent first,
      // then stop the run it launched. Pausing alone would leave the agent
      // working on a goal the row now says is paused.
      if (live) await onStopRunInWorkspace?.(entry.workspacePath, entry.run.runId)
      setStatusMessage('Goal paused')
      await onRefreshWorkspaceRuns?.(entry.workspacePath)
      refreshDerived()
    })

  const stopLoop = (entry: HomeEntry): Promise<void> =>
    runRowAction(`${homeEntryKey(entry)}#loop`, async () => {
      const res = await window.vyotiq?.setLoop({
        workspacePath: entry.workspacePath,
        runId: entry.run.runId,
        action: 'stop'
      })
      if (!res) return
      if (!res.ok) {
        pushToast(res.error, 'error')
        return
      }
      setStatusMessage('Loop stopped')
      await onRefreshWorkspaceRuns?.(entry.workspacePath)
    })

  if (!hasWorkspaces) {
    return (
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-5 py-10">
          <section
            aria-labelledby="home-empty-heading"
            className="rounded-lg border border-border bg-card/40 px-6 py-16 text-center"
          >
            <Icon name="folderPlus" size={26} className="mx-auto text-muted" aria-hidden="true" />
            <h1 id="home-empty-heading" className="mt-4 text-heading font-medium text-fg-strong">
              Open a workspace
            </h1>
            <p className="mx-auto mt-2 max-w-md text-xs text-muted">
              Pick a project folder. Agent V works inside that folder when you ask.
            </p>
            <Button className="mt-5" onClick={onAddWorkspace}>
              Add workspace
            </Button>
          </section>
        </div>
      </main>
    )
  }

  const renderLine = (
    entry: HomeEntry,
    state: HomeEntryState,
    actions?: readonly SessionLineAction[],
    showState = true
  ) => {
    const key = homeEntryKey(entry)
    return (
      <SessionLine
        key={key}
        entry={entry}
        state={state}
        stat={stats.data[key]}
        showWorkspace={openWorkspaces.length > 1}
        showState={showState}
        pinned={pinnedRunKeys.includes(key)}
        open={isRunOpenInPane?.(entry.workspacePath, entry.run.runId) ?? false}
        focused={isRunFocusedInPane?.(entry.workspacePath, entry.run.runId) ?? false}
        actions={actions}
        onOpen={() => onSelectRunInWorkspace(entry.workspacePath, entry.run.runId)}
        onTogglePin={() => onTogglePinnedRun(key)}
      />
    )
  }

  /**
   * What the user can do about a row that is waiting on them. `interrupted`
   * carries Resume because the lane header promises the run can be continued,
   * and opening it only continues it when auto-resume is switched on.
   */
  const attentionActions = (entry: HomeEntry, state: HomeEntryState): SessionLineAction[] => {
    const key = homeEntryKey(entry)
    if (state === 'unverified' && onReviewChangesInWorkspace) {
      return [
        {
          label: 'Review changes',
          onClick: () => onReviewChangesInWorkspace(entry.workspacePath, entry.run.runId)
        }
      ]
    }
    if (state === 'interrupted' && onResumeRunInWorkspace) {
      return [
        {
          label: 'Resume',
          pending: busyTokens.has(`${key}#resume`),
          onClick: () => void resumeRun(entry)
        }
      ]
    }
    return []
  }

  /**
   * A live run, a standing goal and an armed loop are three separate things to
   * call off, and until now every one of them could only be reached by opening
   * the session and finding its control.
   */
  const inFlightActions = (entry: HomeEntry, live: boolean): SessionLineAction[] => {
    const key = homeEntryKey(entry)
    const actions: SessionLineAction[] = []
    if (live && onStopRunInWorkspace) {
      actions.push({
        label: 'Stop',
        variant: 'danger',
        pending: busyTokens.has(`${key}#stop`),
        onClick: () => void stopRun(entry)
      })
    }
    if (entry.run.goalStatus === 'active') {
      actions.push({
        label: 'Pause goal',
        pending: busyTokens.has(`${key}#goal`),
        onClick: () => void pauseGoal(entry, live)
      })
    }
    if (entry.run.loopArmed) {
      actions.push({
        label: 'Stop loop',
        variant: 'ghost',
        pending: busyTokens.has(`${key}#loop`),
        onClick: () => void stopLoop(entry)
      })
    }
    return actions
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      {/* A query container, so the layout below responds to the width Home is
          actually given. Viewport breakpoints would not: the sidebar and any
          open chat pane take their share first, and a 1280px window can leave
          Home 900px. The cap is a dashboard measure rather than a prose one —
          wide enough for a status rail beside the session lists, bounded so the
          rows themselves never stretch past a readable line. */}
      <div className="@container mx-auto w-full max-w-[100rem] px-4 pb-16 pt-8 sm:px-6 sm:pt-10 xl:px-8">
        <PageHeader
          title="Home"
          // Only the live count: every other number in this line is repeated by
          // a section heading a few rows below it.
          description={runningCount > 0 ? `${runningCount} running` : undefined}
          trailing={
            <Button variant="subtle" pending={refreshing} onClick={() => void refreshAll()}>
              <Icon name="refresh" size={13} aria-hidden="true" /> Refresh
            </Button>
          }
        />
        <div role="status" className="sr-only">
          {statusMessage}
        </div>

        {stats.error ? (
          <AlertBlock className="mt-4 flex items-center justify-between gap-3">
            <span>Session details are unavailable. Sessions can still be opened.</span>
            <button
              type="button"
              className="shrink-0 underline underline-offset-2 focus-visible:vy-focus-ring"
              onClick={stats.refresh}
            >
              Retry
            </button>
          </AlertBlock>
        ) : null}

        <div className="mt-8 flex flex-col gap-7">
          {/* The briefing opens with what the work actually looked like: usage
              across the window, full width, before anything asks for a
              decision. */}
          <ActivitySection
            data={activity.data}
            loading={activity.loading}
            error={activity.error}
            windowDays={windowDays}
            onWindowChange={setWindowDays}
            onRetry={activity.refresh}
          />

          {/* Environment is a blocking condition, not a footnote: a provider
              with no key means no run can start at all. It used to render last,
              which put it below the fold on every window size — the one thing
              on the page you were guaranteed not to see. It stays above the
              session columns and spans both, because it is about the app, not
              a session — Activity leads the page ahead of it. */}
          <EnvironmentSection
            providerIssue={providerIssue ?? null}
            mcpIssues={mcp.issues}
            onOpenProviderSettings={onOpenProviderSettings}
            onOpenMcpServer={onOpenMcpServer}
            onRetryMcp={() => void mcp.retry()}
          />

          {/* Two columns once Home has the room: the session lists people act
              on, beside a rail of standing context they read. Stacking them was
              what pushed the page past a screen — the rail's height was being
              paid for twice over. Below the split the order is still the honest
              one, most urgent first. */}
          <div
            className={cn(
              'grid grid-cols-1 items-start gap-x-6 gap-y-7',
              // With nothing to act on there is no left column to sit beside,
              // so the rail takes the full width instead of leaving half the
              // page blank.
              hasSessionRows && '@5xl:grid-cols-[minmax(0,1.55fr)_minmax(19rem,1fr)]'
            )}
          >
            {hasSessionRows ? (
            <div className="min-w-0">
              {lanes.length > 0 ? (
                <HomeSection id="home-attention-heading" title="Needs you" count={attention.length}>
                  <div className="flex flex-col gap-2">
                    {lanes.map((lane) => (
                      <AttentionLane
                        key={lane.state}
                        state={lane.state}
                        entries={lane.entries}
                        renderRow={(entry) =>
                          renderLine(
                            entry,
                            entry.state,
                            attentionActions(entry, entry.state),
                            false
                          )
                        }
                      />
                    ))}
                  </div>
                </HomeSection>
              ) : null}

              {inFlight.length > 0 ? (
                <HomeSection id="home-inflight-heading" title="In flight" count={inFlight.length}>
                  <HomeCard role="list">
                    {inFlight.map((entry) => {
                      const live = isRunningEntry(entry, activeKeys)
                      return renderLine(
                        entry,
                        live ? 'running' : 'done',
                        inFlightActions(entry, live)
                      )
                    })}
                  </HomeCard>
                </HomeSection>
              ) : null}

              {pinned.length > 0 ? (
                <HomeSection id="home-pinned-heading" title="Pinned" count={pinned.length}>
                  <HomeCard role="list">
                    {pinned.map((entry) =>
                      renderLine(
                        entry,
                        stateOfHomeEntry(
                          entry,
                          stats.data[homeEntryKey(entry)],
                          activeKeys,
                          blockedKeys
                        )
                      )
                    )}
                  </HomeCard>
                </HomeSection>
              ) : null}
            </div>
            ) : null}

            <div className="min-w-0">
              <HomeSection
                id="home-repositories-heading"
                title="Repositories"
                count={openWorkspaces.length}
                trailing={
                  <Button variant="ghost" className="min-h-7 px-2 text-2xs" onClick={onAddWorkspace}>
                    <Icon name="plus" size={11} aria-hidden="true" /> Add workspace
                  </Button>
                }
              >
                <HomeCard role="list">
                  {openWorkspaces.map((path) => (
                    <RepositoryLine
                      key={path}
                      path={path}
                      summary={git.data[path]}
                      loading={git.loading}
                      error={git.errors[path]}
                      running={workspaceHasBackgroundRun?.(path) ?? false}
                      lastActivityAt={lastActivityByPath[path]}
                      onOpen={() => onSwitchWorkspace(path)}
                      onNewChat={() => onNewSessionInWorkspace(path, '')}
                      onReviewChanges={
                        onReviewChangesInWorkspace
                          ? () => onReviewChangesInWorkspace(path)
                          : undefined
                      }
                      onRevealFile={(file) =>
                        void window.vyotiq?.workspaceFileReveal({ workspacePath: path, path: file })
                      }
                      onRetryStatus={git.refresh}
                    />
                  ))}
                </HomeCard>
              </HomeSection>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
