/*
  What Home's day sentence is made from, in one place: Home draws it, and
  the agent's `read_home` reads it (src/shared/appActions.ts) without Home
  on screen. Both go through `homeDayModel`, so what the agent says is what
  Home would show.
*/
import type { ActiveRun } from '@shared/ipc'
import type { TaskSchedule } from '@shared/ipc/schemas/schedules'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import type { WorkspaceRuns } from '@renderer/app/navigator/types'
import { buildNavigatorSections, type NavRow, type NavSectionKey } from '@renderer/app/navigator/navigatorModel'
import { daySentence, sentenceText, type DayFacts, type Segment } from './daySentence'
import { upcomingSchedules } from './components/ComingUpSection'

const DAY_MS = 86_400_000

export type DayModelInputs = {
  openWorkspaces: readonly string[]
  activeWorkspace: string | null
  runsByWorkspacePath: Record<string, WorkspaceRuns>
  /** Undefined until the active runs have loaded. */
  activeRuns: readonly ActiveRun[] | undefined
  /** The provider the next task would use has no key. */
  providerIssue: boolean
  /** Enabled MCP servers that aren't connected. */
  mcpIssues: number
  schedules: readonly TaskSchedule[]
  /** Uncommitted files per workspace path, where git answered. */
  changedFiles: Readonly<Record<string, number>>
  /** Tasks finished in the last seven days; null while unknown. */
  doneThisWeek: number | null
  userName: string
  now: Date
}

export type DayModel = {
  /** Runs parked on an approval or a question, longest wait first. */
  waiting: ActiveRun[]
  running: NavRow[]
  review: NavRow[]
  /** Failed in the last day and not already under review. */
  failed: NavRow[]
  upcoming: TaskSchedule[]
  issues: number
  facts: DayFacts
  segments: Segment[]
}

export function homeDayModel(i: DayModelInputs): DayModel {
  const openWorkspaces = [...i.openWorkspaces]
  // Longest wait first, as the navigator orders them: that one holds work up.
  const waiting = (i.activeRuns ?? [])
    .filter((run) => run.waiting && openWorkspaces.some((path) => workspacePathsEqual(path, run.workspacePath)))
    .sort((a, b) => Date.parse(a.waiting!.since) - Date.parse(b.waiting!.since))

  // Running and review come from the navigator's own model, so the sentence
  // and the list beside it can never disagree: it folds in queued loops,
  // failed runs with edits left and inline instances the same way.
  const sections = buildNavigatorSections({
    runsByWorkspacePath: i.runsByWorkspacePath,
    openPaths: openWorkspaces,
    activePath: i.activeWorkspace,
    activeRuns: [...(i.activeRuns ?? [])],
    activeRunsLoaded: i.activeRuns !== undefined,
    scopePath: null,
    now: i.now.getTime()
  })
  const rowsOf = (key: NavSectionKey): NavRow[] => sections.find((s) => s.key === key)?.rows ?? []
  const running = rowsOf('running')
  const review = rowsOf('review')
  const failed = [...rowsOf('done'), ...rowsOf('pinned')]
    .filter((r) => r.state === 'failed' && i.now.getTime() - Date.parse(r.run.updatedAt) < DAY_MS)
    .sort((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt))
  const upcoming = upcomingSchedules([...i.schedules], openWorkspaces)
  const dirty = Object.entries(i.changedFiles).filter(([, n]) => n > 0)
  const issues = i.mcpIssues + (i.providerIssue ? 1 : 0)

  const facts: DayFacts = {
    needs: waiting.length,
    issues,
    failed: failed.length,
    running: running.length,
    review: review.length,
    nextSchedule: upcoming[0]?.nextRunAt ? new Date(upcoming[0].nextRunAt) : null,
    changes: {
      files: dirty.reduce((n, [, files]) => n + files, 0),
      workspaces: dirty.length,
      name: dirty.length === 1 ? formatWorkspaceName(dirty[0]![0]) : null
    },
    doneThisWeek: i.doneThisWeek,
    userName: i.userName,
    now: i.now
  }
  return { waiting, running, review, failed, upcoming, issues, facts, segments: daySentence(facts) }
}

/** One part, or `fallback` when the bridge lacks it, throws or refuses: Home's hooks treat each part the same. */
async function part<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read()
  } catch {
    return fallback
  }
}

/** What the window knows already; the rest `readDaySentence` asks main for. */
export type DaySentenceSource = Pick<
  DayModelInputs,
  'openWorkspaces' | 'activeWorkspace' | 'runsByWorkspacePath' | 'activeRuns' | 'providerIssue' | 'userName'
>

/**
 * Home's sentence read fresh, as Home would draw it now: git status, the
 * week's receipts, MCP health and the schedules, each asked of main the way
 * Home's own hooks ask. A part that fails to read is left out, as Home
 * leaves it out, never guessed.
 */
export async function readDaySentence(src: DaySentenceSource): Promise<string> {
  if (src.openWorkspaces.length === 0) return 'No workspace is open, so Home has nothing to say yet.'
  const api = window.vyotiq
  const [git, activity, mcp, schedules] = await Promise.all([
    Promise.all(
      src.openWorkspaces.map((path) =>
        part(async (): Promise<[string, number] | null> => {
          const res = await api?.gitStatus?.(path)
          if (!res?.ok || res.data.kind !== 'ok') return null
          const status = res.data.status
          return [path, status.truncated ? status.fileCount : status.files.length]
        }, null)
      )
    ),
    part(async () => {
      const res = await api?.homeActivity?.({ workspacePaths: [...src.openWorkspaces], windowDays: 7 })
      return res?.ok ? res.data.outcomes.done : null
    }, null),
    part(async () => {
      const res = await api?.mcpStatus?.({ workspacePath: src.activeWorkspace })
      // A connect still in flight is not a fault; a failed read is not evidence a server is down.
      return res?.ok ? res.data.servers.filter((s) => s.enabled && !s.connected && !s.connecting).length : 0
    }, 0),
    part(async (): Promise<TaskSchedule[]> => {
      const res = await api?.listSchedules?.()
      return res?.ok ? res.data.schedules : []
    }, [])
  ])
  const model = homeDayModel({
    ...src,
    mcpIssues: mcp,
    schedules,
    changedFiles: Object.fromEntries(git.filter((g): g is [string, number] => g !== null)),
    doneThisWeek: activity,
    now: new Date()
  })
  return sentenceText(model.segments)
}
