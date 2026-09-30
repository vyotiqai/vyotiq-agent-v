import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { atomicWriteJson } from '@main/storage/atomicWrite'
import type { TaskOutcome, TaskOutcomeCommit } from '../../shared/ipc/schemas/taskOutcome'
import { listCheckpointMetas, listCheckpointMetasAsync, type WriteCheckpointMeta } from './checkpoints'

/**
 * How a task's edits were settled after review, kept with the run: which
 * commit took them (outcome.json) and, per file, Kept or Undone (the write
 * checkpoints' own marks). The record's result reads it back as one line.
 */
const OUTCOME_FILE = 'outcome.json'

/** A commit made from the task's Changes, and the writes it kept on the way. */
export type TaskCommitRecord = TaskOutcomeCommit & {
  /** What the commit kept that was still waiting, so taking it back reopens exactly those. */
  kept: Array<{ checkpointId: string; path: string }>
}

type OutcomeDoc = { version: 1; commit?: TaskCommitRecord }

function outcomePath(runDir: string): string {
  return join(runDir, OUTCOME_FILE)
}

function isCommitRecord(value: unknown): value is TaskCommitRecord {
  const c = value as Partial<TaskCommitRecord> | null
  return (
    c != null &&
    typeof c === 'object' &&
    typeof c.sha === 'string' &&
    /^[0-9a-f]{40,64}$/.test(c.sha) &&
    typeof c.at === 'string' &&
    (c.branch === null || typeof c.branch === 'string') &&
    typeof c.pushed === 'boolean' &&
    Array.isArray(c.kept)
  )
}

/** The commit recorded for this task, or null (none, or a file that cannot be read). */
export function readTaskCommit(runDir: string): TaskCommitRecord | null {
  const p = outcomePath(runDir)
  if (!existsSync(p)) return null
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8')) as Partial<OutcomeDoc> | null
    if (!isCommitRecord(doc?.commit)) return null
    const kept = doc.commit.kept.filter(
      (k): k is { checkpointId: string; path: string } =>
        k != null && typeof k.checkpointId === 'string' && typeof k.path === 'string'
    )
    return { ...doc.commit, kept }
  } catch {
    return null
  }
}

/** Record the commit that took this task's edits, or clear it (null). */
export function writeTaskCommit(runDir: string, commit: TaskCommitRecord | null): void {
  if (!commit) {
    rmSync(outcomePath(runDir), { force: true })
    return
  }
  const doc: OutcomeDoc = { version: 1, commit }
  atomicWriteJson(outcomePath(runDir), doc)
}

/** Every path the task's checkpoints recorded. */
export function taskWrittenPaths(runDir: string): Set<string> {
  const out = new Set<string>()
  for (const meta of listCheckpointMetas(runDir)) for (const f of meta.files) out.add(f.path)
  return out
}

/**
 * Each file's standing, from the newest checkpoint that wrote it: kept,
 * undone, or still waiting. A write that can never be undone (a folder
 * deleted whole) has nothing to decide, so it is left out while it waits.
 */
export function outcomeFiles(metas: readonly WriteCheckpointMeta[]): TaskOutcome['files'] {
  const byPath = new Map<string, TaskOutcome['files'][number]>()
  for (const meta of metas) {
    const closed = Boolean(meta.undone || meta.resolved)
    for (const f of meta.files) {
      if (f.resolved === 'kept' || f.resolved === 'discarded') {
        byPath.set(f.path, { path: f.path, mark: f.resolved === 'kept' ? 'kept' : 'undone' })
      } else if (f.undoable && !closed) {
        byPath.set(f.path, { path: f.path, mark: 'pending' })
      } else {
        byPath.delete(f.path)
      }
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}

export async function readTaskOutcome(runDir: string): Promise<TaskOutcome> {
  const files = outcomeFiles(await listCheckpointMetasAsync(runDir))
  const commit = readTaskCommit(runDir)
  return {
    files,
    ...(commit
      ? {
          commit: {
            sha: commit.sha,
            branch: commit.branch,
            at: commit.at,
            pushed: commit.pushed
          }
        }
      : {})
  }
}
