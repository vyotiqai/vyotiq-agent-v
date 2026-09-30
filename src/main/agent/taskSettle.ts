import type { ReopenWritesResult, TaskCommitSettled } from '../../shared/ipc/schemas/taskOutcome'
import { logger } from '../../shared/logger'
import { resolveRunDir } from '../storage/paths'
import { commitChangedPaths, readHeadCommit, undoLatestCommit } from '../git/git'
import { invalidateGitStatusCache } from '../git/gitStatusCache'
import { emitGitStatusChanged } from '../git/gitStatusEvents'
import { getWriteCheckpointMeta, keepWritesForPaths, reopenWrites } from './checkpoints'
import { invalidateListRunsCache } from './runListCache'
import { isActive } from './runRegistry'
import { appendEvent, runExists } from './state'
import { readTaskCommit, taskWrittenPaths, writeTaskCommit } from './taskOutcome'

/**
 * Settling a task's edits, reversibly: taking back a Keep or an Undo, and a
 * commit made from the task's Changes — which keeps what it took, and can be
 * taken back while it is still the latest, unpushed commit.
 */

/** Persist each changed checkpoint as a writes_checkpoint row, so a reload shows it. */
function persistCheckpoints(runDir: string, runId: string, checkpointIds: Iterable<string>): void {
  for (const id of new Set(checkpointIds)) {
    const meta = getWriteCheckpointMeta(runDir, id)
    if (!meta) continue
    appendEvent(runDir, {
      type: 'writes_checkpoint',
      runId,
      checkpointId: meta.id,
      undone: Boolean(meta.undone || meta.resolved),
      files: meta.files
    })
  }
}

function afterWorkspaceChange(workspacePath: string): void {
  invalidateGitStatusCache(workspacePath)
  emitGitStatusChanged(workspacePath)
}

/** The reopen result as the renderer takes it: each file without main-only fields. */
function forRenderer(result: {
  reopened: string[]
  conflicted: string[]
  skipped: string[]
  checkpoints: Array<{ checkpointId: string; files: ReadonlyArray<{ path: string; action: 'created' | 'modified' | 'deleted'; undoable: boolean; resolved?: 'kept' | 'discarded'; conflicted?: boolean }> }>
}): ReopenWritesResult {
  return {
    reopened: result.reopened,
    conflicted: result.conflicted,
    skipped: result.skipped,
    checkpoints: result.checkpoints.map((cp) => ({
      checkpointId: cp.checkpointId,
      files: cp.files.map((f) => ({
        path: f.path,
        action: f.action,
        undoable: f.undoable,
        ...(f.resolved ? { resolved: f.resolved } : {}),
        ...(f.conflicted ? { conflicted: true } : {})
      }))
    }))
  }
}

/** Take back a Keep or an Undo of this task's files. */
export function reopenTaskWrites(
  workspacePath: string,
  runId: string,
  req: { checkpointId?: string; paths?: string[] }
): ReopenWritesResult {
  if (isActive(runId)) throw new Error('Stop the run before reopening its edits.')
  if (!runExists(workspacePath, runId)) throw new Error('Run not found')
  const runDir = resolveRunDir(workspacePath, runId)
  const result = reopenWrites(runDir, workspacePath, req)
  persistCheckpoints(runDir, runId, result.checkpoints.map((cp) => cp.checkpointId))
  if (result.reopened.length > 0) {
    invalidateListRunsCache(workspacePath)
    afterWorkspaceChange(workspacePath)
  }
  return forRenderer(result)
}

/**
 * After a commit from the task's Changes: when it took any of the task's
 * files, record it with the run and keep what it took that still waited on
 * review. Never fails the commit — a task it cannot settle stays as it was.
 */
export async function settleTaskAfterCommit(
  workspacePath: string,
  runId: string,
  commit: { committed: boolean; pushed: boolean }
): Promise<TaskCommitSettled | undefined> {
  if (!commit.committed) return undefined
  try {
    if (!runExists(workspacePath, runId)) return undefined
    const runDir = resolveRunDir(workspacePath, runId)
    const head = await readHeadCommit(workspacePath)
    if (!head) return undefined
    const taskPaths = taskWrittenPaths(runDir)
    const taken = (await commitChangedPaths(workspacePath, head.sha)).filter((p) => taskPaths.has(p))
    if (taken.length === 0) return undefined
    // A live run's writes are not the user's to settle yet; the commit is still recorded.
    const kept = isActive(runId) ? [] : keepWritesForPaths(runDir, workspacePath, taken)
    writeTaskCommit(runDir, {
      sha: head.sha,
      branch: head.branch,
      at: new Date().toISOString(),
      pushed: commit.pushed,
      kept
    })
    persistCheckpoints(runDir, runId, kept.map((k) => k.checkpointId))
    invalidateListRunsCache(workspacePath)
    return {
      sha: head.sha,
      branch: head.branch,
      kept: [...new Set(kept.map((k) => k.path))],
      undoable: !commit.pushed
    }
  } catch (err) {
    logger.warn('Committed, but could not record the commit with its task', {
      scope: 'git',
      correlationId: runId,
      err
    })
    return undefined
  }
}

/**
 * Take back the commit recorded for this task: HEAD moves back to its parent
 * with the changes left staged (see undoLatestCommit), and the files the
 * commit kept wait on review again.
 */
export async function undoTaskCommit(workspacePath: string, runId: string, sha: string): Promise<ReopenWritesResult> {
  if (isActive(runId)) throw new Error('Stop the run before taking back its commit.')
  if (!runExists(workspacePath, runId)) throw new Error('Run not found')
  const runDir = resolveRunDir(workspacePath, runId)
  const record = readTaskCommit(runDir)
  if (!record || record.sha !== sha) throw new Error('That commit is not recorded for this task')
  if (record.pushed) throw new Error('That commit has been pushed; it cannot be taken back here')
  try {
    await undoLatestCommit(workspacePath, sha)
  } finally {
    afterWorkspaceChange(workspacePath)
  }
  writeTaskCommit(runDir, null)

  const byCheckpoint = new Map<string, string[]>()
  for (const k of record.kept) byCheckpoint.set(k.checkpointId, [...(byCheckpoint.get(k.checkpointId) ?? []), k.path])
  const merged: ReopenWritesResult = { reopened: [], conflicted: [], skipped: [], checkpoints: [] }
  for (const [checkpointId, paths] of byCheckpoint) {
    try {
      const r = forRenderer(reopenWrites(runDir, workspacePath, { checkpointId, paths }))
      merged.reopened.push(...r.reopened)
      merged.conflicted.push(...r.conflicted)
      merged.skipped.push(...r.skipped)
      merged.checkpoints.push(...r.checkpoints)
    } catch (err) {
      // The commit is already taken back; a turn whose marks cannot be read keeps them.
      logger.warn('Took back a commit, but could not reopen what it kept', {
        scope: 'git',
        correlationId: runId,
        checkpointId,
        err
      })
      merged.skipped.push(...paths)
    }
  }
  persistCheckpoints(runDir, runId, merged.checkpoints.map((cp) => cp.checkpointId))
  invalidateListRunsCache(workspacePath)
  return merged
}
