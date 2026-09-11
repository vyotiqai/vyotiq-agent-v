import type { RunStat, RunSummary } from '@shared/ipc'
import { isResumableInterruptedRun } from '@shared/runInterrupt'
import { pinnedRunKey } from './pinnedRuns'

export type HomeEntry = { workspacePath: string; run: RunSummary }

export type HomeEntryState = 'running' | 'failed' | 'interrupted' | 'unverified' | 'done'

export function homeEntryKey(entry: HomeEntry): string {
  return pinnedRunKey(entry.workspacePath, entry.run.runId)
}

export function flattenHomeEntries(
  openWorkspaces: readonly string[],
  runsByWorkspacePath: Record<string, { runs: RunSummary[] } | undefined>
): HomeEntry[] {
  const entries: HomeEntry[] = []
  for (const workspacePath of openWorkspaces) {
    for (const run of runsByWorkspacePath[workspacePath]?.runs ?? []) {
      entries.push({ workspacePath, run })
    }
  }
  return entries.sort((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt))
}

export function stateOfHomeEntry(
  entry: HomeEntry,
  stat: RunStat | undefined,
  activeKeys: ReadonlySet<string>
): HomeEntryState {
  if (activeKeys.has(homeEntryKey(entry)) || entry.run.status === 'running') return 'running'
  if (isResumableInterruptedRun(entry.run)) return 'interrupted'
  if (entry.run.status === 'error') return 'failed'
  if (stat?.verification?.verifiedAfterLastMutation === false) return 'unverified'
  return 'done'
}

export function attentionHomeEntries(
  entries: readonly HomeEntry[],
  stats: Readonly<Record<string, RunStat>>,
  activeKeys: ReadonlySet<string>
): HomeEntry[] {
  const rank: Record<HomeEntryState, number> = {
    failed: 0,
    interrupted: 1,
    unverified: 2,
    running: 3,
    done: 4
  }
  return entries
    .filter((entry) => {
      const state = stateOfHomeEntry(entry, stats[homeEntryKey(entry)], activeKeys)
      return state === 'failed' || state === 'interrupted' || state === 'unverified'
    })
    .sort((a, b) => {
      const aState = stateOfHomeEntry(a, stats[homeEntryKey(a)], activeKeys)
      const bState = stateOfHomeEntry(b, stats[homeEntryKey(b)], activeKeys)
      return rank[aState] - rank[bState] || b.run.updatedAt.localeCompare(a.run.updatedAt)
    })
}

export function runningHomeEntries(
  entries: readonly HomeEntry[],
  activeKeys: ReadonlySet<string>
): HomeEntry[] {
  return entries.filter(
    (entry) => activeKeys.has(homeEntryKey(entry)) || entry.run.status === 'running'
  )
}
