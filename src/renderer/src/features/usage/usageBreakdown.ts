import type { HomeActivityResult, HomeActivityTask } from '@shared/ipc'
import { workspacePathsEqual } from '@shared/workspacePathMatch'

/**
 * The Usage page's "where it went": the window's tasks grouped under their
 * workspace, groups and tasks costliest first. Workspace totals come from
 * main's per-workspace slices, which count every task; the task rows are
 * main's capped list, so a group can hold fewer rows than its task count.
 */

export type BreakdownTask = HomeActivityTask & {
  tokens: number
  /** Bill plus estimate; null when neither was reported. */
  cost: number | null
  estimated: boolean
}

export type BreakdownGroup = {
  path: string
  runs: number
  tokens: number
  cachedInputTokens: number
  cost: number | null
  estimated: boolean
  /** Share of the window's measure (cost when any was reported, else tokens), 0–1. */
  share: number
  tasks: BreakdownTask[]
}

export type Breakdown = {
  /** What `share` divides: spend when anything reported one, else tokens. */
  measure: 'cost' | 'tokens'
  groups: BreakdownGroup[]
  /** Tasks main left out of the list; the CSV still has them. */
  omitted: number
}

function costOf(entry: { billedCost?: number; estimatedCost?: number }): { cost: number | null; estimated: boolean } {
  const cost = (entry.billedCost ?? 0) + (entry.estimatedCost ?? 0)
  return { cost: cost > 0 ? cost : null, estimated: (entry.estimatedCost ?? 0) > 0 }
}

export function usageBreakdown(data: HomeActivityResult): Breakdown {
  const slices = data.workspaces ?? []
  const tasks: BreakdownTask[] = (data.tasks ?? []).map((task) => ({
    ...task,
    tokens: task.billedInputTokens + task.outputTokens,
    ...costOf(task)
  }))
  const groups: BreakdownGroup[] = slices.map((slice) => ({
    path: slice.path,
    runs: slice.runs,
    tokens: slice.billedInputTokens + slice.outputTokens,
    cachedInputTokens: slice.cachedInputTokens ?? 0,
    ...costOf(slice),
    share: 0,
    tasks: tasks.filter((task) => workspacePathsEqual(task.workspacePath, slice.path))
  }))
  // A task whose workspace has no slice (never expected) still lists, under its own path.
  for (const task of tasks) {
    if (groups.some((group) => workspacePathsEqual(group.path, task.workspacePath))) continue
    let group = groups.find((g) => g.path === task.workspacePath)
    if (!group) {
      group = { path: task.workspacePath, runs: 0, tokens: 0, cachedInputTokens: 0, cost: null, estimated: false, share: 0, tasks: [] }
      groups.push(group)
    }
    group.tasks.push(task)
    group.runs += 1
    group.tokens += task.tokens
    group.cachedInputTokens += task.cachedInputTokens ?? 0
    if (task.cost != null) group.cost = (group.cost ?? 0) + task.cost
    group.estimated ||= task.estimated
  }
  const measure = groups.some((group) => group.cost != null) ? 'cost' : 'tokens'
  const value = (group: BreakdownGroup): number => (measure === 'cost' ? (group.cost ?? 0) : group.tokens)
  const total = groups.reduce((sum, group) => sum + value(group), 0)
  for (const group of groups) group.share = total > 0 ? value(group) / total : 0
  groups.sort((a, b) => value(b) - value(a) || b.tokens - a.tokens || a.path.localeCompare(b.path))
  return {
    measure,
    groups: groups.filter((group) => group.runs > 0 || group.tasks.length > 0),
    omitted: data.tasksOmitted ?? 0
  }
}
