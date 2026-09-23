import type { ActiveRun, RunSummary } from '@shared/ipc'
import type { TurnOutcome } from '@shared/transcript'
import { isResumableInterruptedRun } from '@shared/runInterrupt'
import { relativeTime } from '@shared/utils/timeFormat'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import type { TaskState } from '@renderer/lib/ui'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { runTitle, runTooltip } from './runTitle'

/**
 * The navigator: tasks grouped by what they want from you.
 *
 *   Needs you → Running → Ready for review → Done
 *
 * Every state is read from real data:
 * - needs     a live run with an approval or question pending (`ActiveRun.waiting`)
 * - running   a live run; a run whose loop is armed waits here as `queued`
 * - review    a finished run whose edits still wait on Keep or Undo (`RunSummary.review`)
 * - done      everything else: done, failed, stopped, interrupted, goal paused
 */
export type NavSectionKey = 'needs' | 'running' | 'review' | 'done'

export type NavMeta =
  /** "4/5": the step in progress of the todo list. */
  | { kind: 'steps'; current: number; total: number }
  | { kind: 'diff'; add: number; del: number; files: number }
  /** Edits that could not be counted exactly: the file count only. */
  | { kind: 'files'; files: number }
  /** "3m", or "in 2h" for a scheduled loop. `accent` when it is waiting on you. */
  | { kind: 'age'; text: string; accent?: boolean }

export type NavRow = {
  runId: string
  workspacePath: string
  workspaceName: string
  title: string
  tooltip: string
  state: TaskState
  /** The word for the glyph when the state alone would mislead ("Interrupted"). */
  stateLabel: string
  meta: NavMeta
  /** From a workspace other than the active one: the meta names it. */
  foreign: boolean
  /** Finished since you last looked (an unread run notification). */
  unread: boolean
  run: RunSummary
}

export type NavSection = { key: NavSectionKey; label: string; rows: NavRow[] }

export const NAV_SECTION_LABEL: Record<NavSectionKey, string> = {
  needs: 'Needs you',
  running: 'Running',
  review: 'Ready for review',
  done: 'Done'
}

const ORDER: NavSectionKey[] = ['needs', 'running', 'review', 'done']

export type NavigatorInput = {
  runsByWorkspacePath: Readonly<Record<string, { runs: readonly RunSummary[] }>>
  /** Open workspaces, in slot order. */
  openPaths: readonly string[]
  activePath: string | null
  activeRuns: readonly ActiveRun[]
  /** Until main answers once, an empty `activeRuns` means "unknown". */
  activeRunsLoaded: boolean
  /** `null` = all workspaces. */
  scopePath: string | null
  unreadRunIds?: ReadonlySet<string>
  now?: number
}

export function buildNavigatorSections(input: NavigatorInput): NavSection[] {
  const now = input.now ?? Date.now()
  const buckets: Record<NavSectionKey, NavRow[]> = { needs: [], running: [], review: [], done: [] }
  const waitingSince = new Map<string, number>()

  for (const path of input.openPaths) {
    if (input.scopePath && !workspacePathsEqual(path, input.scopePath)) continue
    const runs = input.runsByWorkspacePath[path]?.runs ?? []
    const foreign = input.activePath ? !workspacePathsEqual(path, input.activePath) : false
    for (const run of runs) {
      if (run.inlineInstance) continue
      const live = input.activeRuns.find(
        (a) => a.runId === run.runId && workspacePathsEqual(a.workspacePath, path)
      )
      const placed = place(run, live, input.activeRunsLoaded, now)
      if (live?.waiting) waitingSince.set(run.runId, Date.parse(live.waiting.since))
      buckets[placed.section].push({
        runId: run.runId,
        workspacePath: path,
        workspaceName: formatWorkspaceName(path),
        title: runTitle(run),
        tooltip: runTooltip(run),
        state: placed.state,
        stateLabel: placed.label,
        meta: placed.meta,
        foreign,
        unread: input.unreadRunIds?.has(run.runId) ?? false,
        run
      })
    }
  }

  const byRecency = (a: NavRow, b: NavRow): number => b.run.updatedAt.localeCompare(a.run.updatedAt)
  // Longest wait first: that is the one holding work up.
  buckets.needs.sort(
    (a, b) => (waitingSince.get(a.runId) ?? 0) - (waitingSince.get(b.runId) ?? 0) || byRecency(a, b)
  )
  buckets.running.sort((a, b) => Number(a.state === 'queued') - Number(b.state === 'queued') || byRecency(a, b))
  buckets.review.sort(byRecency)
  buckets.done.sort(byRecency)

  return ORDER.filter((key) => buckets[key].length > 0).map((key) => ({
    key,
    label: NAV_SECTION_LABEL[key],
    rows: buckets[key]
  }))
}

type Placement = { section: NavSectionKey; state: TaskState; label: string; meta: NavMeta }

function place(run: RunSummary, live: ActiveRun | undefined, loaded: boolean, now: number): Placement {
  const age = (iso: string): NavMeta => ({ kind: 'age', text: ageText(iso, now) })

  if (live?.waiting) {
    return {
      section: 'needs',
      state: 'needs',
      label: live.waiting.kind === 'approval' ? 'Needs your approval' : 'Has a question for you',
      meta: { kind: 'age', text: ageText(live.waiting.since, now), accent: true }
    }
  }
  // `status` is a snapshot on disk; the live registry wins once it has answered.
  const running = live != null || (!loaded && run.status === 'running')
  if (running) {
    const steps = live?.steps
    return {
      section: 'running',
      state: 'running',
      label: 'Running',
      meta: steps
        ? { kind: 'steps', current: Math.min(steps.completed + 1, steps.total), total: steps.total }
        : age(run.updatedAt)
    }
  }
  if (run.loopArmed && run.loopNextAt) {
    return {
      section: 'running',
      state: 'queued',
      label: 'Scheduled',
      meta: { kind: 'age', text: untilText(run.loopNextAt, now) }
    }
  }

  const finished = finishedState(run)
  if (run.review) {
    return {
      section: 'review',
      state: finished.state === 'done' ? 'review' : finished.state,
      label: finished.state === 'done' ? 'Ready for review' : `${finished.label} · edits to review`,
      meta:
        run.review.add !== undefined && run.review.del !== undefined
          ? { kind: 'diff', add: run.review.add, del: run.review.del, files: run.review.files }
          : { kind: 'files', files: run.review.files }
    }
  }
  return { section: 'done', ...finished, meta: age(run.updatedAt) }
}

function finishedState(run: RunSummary): { state: TaskState; label: string } {
  if (run.goalStatus === 'paused') return { state: 'paused', label: 'Goal paused' }
  if (isResumableInterruptedRun(run)) return { state: 'stopped', label: 'Interrupted' }
  if (run.status === 'error') return { state: 'failed', label: 'Failed' }
  if (run.status === 'cancelled') return { state: 'stopped', label: 'Stopped' }
  // A `running` snapshot main no longer lists: the run ended without writing
  // its final status. It is not running, and it did not report done.
  if (run.status === 'running') return { state: 'stopped', label: 'Stopped' }
  return { state: 'done', label: 'Done' }
}

/**
 * The state the task header shows — the navigator's rule, read from the pane's
 * own stream where that is fresher. While the stream is live the task is
 * running (or needs you); once the stream has seen the run end, how it ended
 * wins over a run list that has not refreshed yet.
 */
export function taskHeaderState(input: {
  run: RunSummary | null
  /** The stream is live: the run is in flight or starting. */
  streaming: boolean
  /** A pending approval or question, and since when. */
  needs: { kind: 'approval' | 'question'; since: number | null } | null
  /** The plan's progress in the live run. */
  steps: { current: number; total: number } | null
  /** How the stream saw the latest run end. */
  turnStatus: TurnOutcome | null
  /** The task has at least one run (a draft has none). */
  started: boolean
  now?: number
}): { state: TaskState; label: string } | null {
  const now = input.now ?? Date.now()
  if (input.needs) {
    const what = input.needs.kind === 'approval' ? 'Needs your approval' : 'Has a question for you'
    const since = input.needs.since != null ? relativeTime(new Date(input.needs.since).toISOString(), now) : ''
    return { state: 'needs', label: since ? `${what} · ${since}` : what }
  }
  if (input.streaming) {
    const steps = input.steps
    return { state: 'running', label: steps ? `Running · step ${steps.current} of ${steps.total}` : 'Running' }
  }
  if (!input.started && !input.run) return null
  const run = input.run
  if (run?.loopArmed && run.loopNextAt) return { state: 'queued', label: `Scheduled · ${untilText(run.loopNextAt, now)}` }
  const ended: { state: TaskState; label: string } =
    input.turnStatus === 'error'
      ? { state: 'failed', label: 'Failed' }
      : input.turnStatus === 'cancelled'
        ? { state: 'stopped', label: 'Stopped' }
        : input.turnStatus === 'interrupted'
          ? { state: 'stopped', label: 'Interrupted' }
          : input.turnStatus === 'done'
            ? run?.goalStatus === 'paused'
              ? { state: 'paused', label: 'Goal paused' }
              : { state: 'done', label: 'Done' }
            : run
              ? finishedState(run)
              : { state: 'done', label: 'Done' }
  if (run?.review) {
    return ended.state === 'done'
      ? { state: 'review', label: 'Ready for review' }
      : { state: ended.state, label: `${ended.label} · edits to review` }
  }
  return ended
}

/** "3m", "2h", "1d" — `now` for a future or unreadable time rather than nothing. */
function ageText(iso: string, now: number): string {
  return relativeTime(iso, now) || 'now'
}

function untilText(iso: string, now: number): string {
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms) || ms <= 60_000) return 'soon'
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `in ${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return `in ${hrs}h`
  return `in ${Math.round(hrs / 24)}d`
}
