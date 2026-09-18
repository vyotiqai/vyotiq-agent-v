import type { NotificationItem, RunStat, RunSummary } from '@shared/ipc'
import { isResumableInterruptedRun } from '@shared/runInterrupt'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { pinnedRunKey } from './pinnedRuns'

export type HomeEntry = { workspacePath: string; run: RunSummary }

/**
 * Row state on Home, most urgent first. `blocked` comes from an unread
 * `needs_you` notification (the agent asked a question or requested tool
 * approval); the rest are derived from run status and receipt verification.
 */
export type HomeEntryState =
  | 'blocked'
  | 'failed'
  | 'interrupted'
  | 'unverified'
  | 'running'
  | 'done'

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

export type BlockedRunTarget = { workspacePath: string; runId: string }

/**
 * Runs whose agent is waiting on a human answer. Only unread `needs_you`
 * items count — the main process dismisses them as soon as the approval or
 * question is answered, so a read item is no longer a block.
 */
export function blockedRunTargets(items: readonly NotificationItem[]): BlockedRunTarget[] {
  const targets: BlockedRunTarget[] = []
  for (const item of items) {
    if (item.read || item.kind !== 'needs_you') continue
    if (item.action?.type !== 'open_run') continue
    targets.push({ workspacePath: item.action.workspacePath, runId: item.action.runId })
  }
  return targets
}

/**
 * Resolve blocked targets onto the listed entries' own keys.
 *
 * A notification carries the workspace path the run was started with, which
 * can differ from the listed workspace key by casing or canonicalization, so
 * the join goes through `workspacePathsEqual` rather than key equality — an
 * exact-string match would silently drop the row.
 */
export function blockedKeysForEntries(
  entries: readonly HomeEntry[],
  targets: readonly BlockedRunTarget[]
): Set<string> {
  const keys = new Set<string>()
  if (targets.length === 0) return keys
  for (const entry of entries) {
    const match = targets.some(
      (target) =>
        target.runId === entry.run.runId &&
        workspacePathsEqual(target.workspacePath, entry.workspacePath)
    )
    if (match) keys.add(homeEntryKey(entry))
  }
  return keys
}

/**
 * A run's single Home state, most urgent first.
 *
 * `blocked` outranks `running` because a run awaiting an approval or answer is
 * technically live but cannot progress. `running` then outranks every failure
 * state: the live run registry is fresher than a run summary that may still
 * carry an error from an earlier invoke.
 */
export function stateOfHomeEntry(
  entry: HomeEntry,
  stat: RunStat | undefined,
  activeKeys: ReadonlySet<string>,
  blockedKeys: ReadonlySet<string> = new Set()
): HomeEntryState {
  const key = homeEntryKey(entry)
  if (blockedKeys.has(key)) return 'blocked'
  if (activeKeys.has(key) || entry.run.status === 'running') return 'running'
  if (entry.run.status === 'error') return 'failed'
  if (isResumableInterruptedRun(entry.run)) return 'interrupted'
  if (stat?.verification?.verifiedAfterLastMutation === false) return 'unverified'
  return 'done'
}

/** The four states that put a session on the user's plate. */
export type AttentionState = 'blocked' | 'failed' | 'interrupted' | 'unverified'

const ATTENTION_RANK: Record<AttentionState, number> = {
  blocked: 0,
  failed: 1,
  interrupted: 2,
  unverified: 3
}

function isAttentionState(state: HomeEntryState): state is AttentionState {
  return state in ATTENTION_RANK
}

/** Sort key for a row's state; non-attention states sort last. */
function attentionRankOf(state: HomeEntryState): number {
  return isAttentionState(state) ? ATTENTION_RANK[state] : Number.MAX_SAFE_INTEGER
}

/**
 * Section 1 — everything that cannot move without the user. Ranked by
 * urgency, then recency. A run listed here is excluded from every section
 * below it, so Home never shows the same session twice.
 */
export function attentionHomeEntries(
  entries: readonly HomeEntry[],
  stats: Readonly<Record<string, RunStat>>,
  activeKeys: ReadonlySet<string>,
  blockedKeys: ReadonlySet<string> = new Set()
): Array<HomeEntry & { state: HomeEntryState }> {
  return entries
    .map((entry) => ({
      ...entry,
      state: stateOfHomeEntry(entry, stats[homeEntryKey(entry)], activeKeys, blockedKeys)
    }))
    .filter((entry) => isAttentionState(entry.state))
    .sort(
      (a, b) =>
        attentionRankOf(a.state) - attentionRankOf(b.state) ||
        b.run.updatedAt.localeCompare(a.run.updatedAt)
    )
}

/** True when a run is doing work, or is set up to do work on its own. */
function isInFlight(entry: HomeEntry, activeKeys: ReadonlySet<string>): boolean {
  const run = entry.run
  if (activeKeys.has(homeEntryKey(entry)) || run.status === 'running') return true
  if (run.goalStatus === 'active' || run.goalStatus === 'paused') return true
  return run.loopArmed === true
}

/**
 * Section 2 — live runs plus the standing work that keeps running without
 * the user: long-lived goals and armed prompt loops. Live runs sort first;
 * the rest by recency.
 */
export function inFlightHomeEntries(
  entries: readonly HomeEntry[],
  activeKeys: ReadonlySet<string>,
  excludeKeys: ReadonlySet<string> = new Set()
): HomeEntry[] {
  return entries
    .filter((entry) => !excludeKeys.has(homeEntryKey(entry)) && isInFlight(entry, activeKeys))
    .sort((a, b) => {
      const aLive = isRunningEntry(a, activeKeys) ? 0 : 1
      const bLive = isRunningEntry(b, activeKeys) ? 0 : 1
      return aLive - bLive || b.run.updatedAt.localeCompare(a.run.updatedAt)
    })
}

export function isRunningEntry(entry: HomeEntry, activeKeys: ReadonlySet<string>): boolean {
  return activeKeys.has(homeEntryKey(entry)) || entry.run.status === 'running'
}

/**
 * Section 3 — sessions the user starred, newest activity first. Pins already
 * shown above are dropped so the star never produces a duplicate row.
 */
export function pinnedHomeEntries(
  entries: readonly HomeEntry[],
  pinnedKeys: readonly string[],
  excludeKeys: ReadonlySet<string> = new Set()
): HomeEntry[] {
  const pinned = new Set(pinnedKeys)
  return entries.filter((entry) => {
    const key = homeEntryKey(entry)
    return pinned.has(key) && !excludeKeys.has(key)
  })
}

export type AttentionEntry = HomeEntry & { state: HomeEntryState }

export type AttentionGroup = { state: AttentionState; entries: AttentionEntry[] }

/**
 * The attention rows folded by state.
 *
 * Seven sessions sharing one problem are one problem with seven instances, not
 * seven separate alarms — folding them is what keeps a long tail of the mildest
 * state from burying a single hard failure. Group order follows
 * `ATTENTION_RANK` rather than input order, so the fold cannot reorder the page
 * even if the rows arrive unsorted.
 */
export function attentionGroups(attention: readonly AttentionEntry[]): AttentionGroup[] {
  const byState = new Map<AttentionState, AttentionEntry[]>()
  for (const entry of attention) {
    if (!isAttentionState(entry.state)) continue
    const bucket = byState.get(entry.state)
    if (bucket) bucket.push(entry)
    else byState.set(entry.state, [entry])
  }
  return [...byState.entries()]
    .sort(([a], [b]) => ATTENTION_RANK[a] - ATTENTION_RANK[b])
    .map(([state, entries]) => ({ state, entries }))
}
