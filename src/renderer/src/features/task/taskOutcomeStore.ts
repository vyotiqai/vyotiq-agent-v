import { useEffect, useState, useSyncExternalStore } from 'react'
import type { TaskOutcome } from '@shared/ipc'

/**
 * How a task's edits were settled (main's outcome.json and checkpoint marks),
 * read by the record's result and the Changes list. Keep, Undo, Commit and
 * taking any of them back bump the revision, and every reader asks again.
 */
let revision = 0
const listeners = new Set<() => void>()
const cache = new Map<string, { revision: number; promise: Promise<TaskOutcome | null> }>()
const CACHE_MAX = 64

/** Something settled or unsettled a task's edits: read every outcome again. */
export function bumpTaskOutcome(): void {
  revision += 1
  cache.clear()
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const currentRevision = (): number => revision

function readOutcome(workspacePath: string, runId: string, key: string): Promise<TaskOutcome | null> {
  const hit = cache.get(key)
  if (hit && hit.revision === revision) return hit.promise
  if (cache.size >= CACHE_MAX) cache.clear()
  const api = typeof window !== 'undefined' ? window.vyotiq?.taskOutcome : undefined
  const promise = api
    ? api({ workspacePath, runId })
        .then((res) => (res.ok ? res.data : null))
        .catch(() => null)
    : Promise.resolve(null)
  cache.set(key, { revision, promise })
  return promise
}

/**
 * The task's outcome, or null while it loads, when it is off (`enabled`), or
 * when it cannot be read. `refreshKey` asks again when the caller knows the
 * task's writes moved (a run ended, git changed).
 */
export function useTaskOutcome(
  workspacePath: string | null | undefined,
  runId: string | null | undefined,
  enabled: boolean,
  refreshKey: string | number = ''
): TaskOutcome | null {
  const rev = useSyncExternalStore(subscribe, currentRevision, currentRevision)
  const key = enabled && workspacePath && runId ? `${workspacePath}\u0000${runId}\u0000${refreshKey}` : null
  const [state, setState] = useState<{ key: string; outcome: TaskOutcome | null } | null>(null)
  useEffect(() => {
    if (!key || !workspacePath || !runId) return undefined
    let cancelled = false
    void readOutcome(workspacePath, runId, key).then((outcome) => {
      if (!cancelled) setState({ key, outcome })
    })
    return () => {
      cancelled = true
    }
  }, [key, workspacePath, runId, rev])
  return state && state.key === key ? state.outcome : null
}

export type OutcomeSummary =
  | { kind: 'committed'; sha: string; branch: string | null; undone: number }
  | { kind: 'kept' }
  | { kind: 'undone' }
  | { kind: 'mixed'; kept: number; undone: number }

/**
 * The one line a settled task's result says, or null while anything still
 * waits on review (or nothing was written).
 */
export function summarizeOutcome(outcome: TaskOutcome | null): OutcomeSummary | null {
  if (!outcome || outcome.files.length === 0) return null
  if (outcome.files.some((f) => f.mark === 'pending')) return null
  const kept = outcome.files.filter((f) => f.mark === 'kept').length
  const undone = outcome.files.length - kept
  if (outcome.commit) return { kind: 'committed', sha: outcome.commit.sha, branch: outcome.commit.branch, undone }
  if (undone === 0) return { kind: 'kept' }
  if (kept === 0) return { kind: 'undone' }
  return { kind: 'mixed', kept, undone }
}

/** Each settled file's mark, by workspace-relative path. */
export function outcomeMarks(outcome: TaskOutcome | null): ReadonlyMap<string, 'kept' | 'undone'> {
  const marks = new Map<string, 'kept' | 'undone'>()
  for (const f of outcome?.files ?? []) if (f.mark !== 'pending') marks.set(f.path, f.mark)
  return marks
}
