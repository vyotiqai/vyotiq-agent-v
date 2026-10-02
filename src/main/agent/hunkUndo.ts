import { createHash, randomUUID } from 'crypto'
import { existsSync, readFileSync, statSync } from 'fs'
import { atomicWriteFile } from '@main/storage/atomicWrite'
import { lineDiff, formatUnifiedDiff } from '../../shared/utils/unifiedDiff'
import {
  applyHunkPatch,
  diffFingerprint,
  hunkIdentity,
  invertPatch,
  reverseHunk,
  sameHunk,
  type HunkIdentity,
  type HunkPatch
} from '../../shared/utils/hunkPatch'
import { newestAgentWrite, resolveCheckpointPath, restampAgentWrite, type AgentWriteRecord } from './checkpoints'
import { taskExtraRoots, taskFileSides } from './taskFileDiff'

/**
 * Undo one hunk of what the task did to a file, from its Changes: the hunk is
 * taken back out of the file as it is now, and nothing else in it moves.
 *
 * The diff is computed again here — the task's before-image against the file
 * now, exactly as the Changes list shows it — and the request must name the
 * diff it was looking at (its fingerprint) and the hunk in it (position and
 * content). Anything else is refused: the file changed since it was shown.
 *
 * A file the task created or deleted is one hunk, the whole file; that is the
 * file's own Undo, which keeps a copy to bring back. Only a modified file is
 * undone by hunk.
 *
 * Bookkeeping: the write stays waiting on review, and its recorded hash moves
 * with the file (see restampAgentWrite), so the file's own Undo, Keep and a
 * rewind still treat it as the agent's write rather than as your edit.
 */
export class HunkUndoRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HunkUndoRefused'
  }
}

export type UndoHunkResult = {
  path: string
  /** Hand back to {@link restoreHunk} to put the hunk back; good until the app quits. */
  restoreToken: string
}

type Restore = { workspacePath: string; runId: string; path: string; patch: HunkPatch }

/** Put-back patches, newest last. A toast's Restore lives seconds; a few dozen is plenty. */
const restores = new Map<string, Restore>()
const RESTORES_MAX = 32

function remember(restore: Restore): string {
  const token = randomUUID()
  restores.set(token, restore)
  while (restores.size > RESTORES_MAX) {
    const oldest = restores.keys().next().value
    if (oldest === undefined) break
    restores.delete(oldest)
  }
  return token
}

export function resetHunkRestoresForTests(): void {
  restores.clear()
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The write a hunk edit may touch: one still waiting on Keep or Undo. */
function pendingWrite(runDir: string, workspaceRoot: string, path: string): AgentWriteRecord {
  const record = newestAgentWrite(runDir, workspaceRoot, path)
  if (!record) throw new HunkUndoRefused('This task did not write that file.')
  if (record.settled === 'kept') throw new HunkUndoRefused('That file is already kept — unkeep it to change it again.')
  if (record.settled) throw new HunkUndoRefused('That file is already settled — there is nothing left to undo in it.')
  if (!record.undoable) throw new HunkUndoRefused('No copy of that file from before the task was kept, so it cannot be undone.')
  return record
}

/** The file now, as text that writes back to the same bytes, with its hash and mode. */
function readWorkspaceText(abs: string): { text: string; hash: string; mode: number } {
  if (!existsSync(abs)) throw new HunkUndoRefused('That file is gone since its diff was shown.')
  const st = statSync(abs)
  const bytes = readFileSync(abs)
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new HunkUndoRefused('That file is not UTF-8 text, so it cannot be undone by hunk.')
  }
  return { text, hash: sha256(bytes), mode: st.mode & 0o777 }
}

/** The ending a line of the before-image used, for a file that has none of its own left. */
function endingOf(text: string): string {
  const m = /\r\n|\r|\n/.exec(text)
  return m ? m[0] : '\n'
}

export function undoHunk(
  runDir: string,
  workspaceRoot: string,
  runId: string,
  req: { path: string; hunk: HunkIdentity; diffHash: string }
): UndoHunkResult {
  const sided = taskFileSides(runDir, workspaceRoot, req.path)
  if (!sided.ok) {
    throw new HunkUndoRefused(
      sided.reason === 'not_in_task'
        ? 'This task did not write that file.'
        : sided.reason === 'unrestorable'
          ? 'No copy of that file from before the task was kept, so it cannot be undone.'
          : 'That file is binary or too large to undo by hunk.'
    )
  }
  const { path, action, before, after } = sided
  if (action === 'created') throw new HunkUndoRefused('The task created that file — undo the file to remove it.')
  if (action === 'deleted') throw new HunkUndoRefused('The task deleted that file — undo the file to bring it back.')
  const record = pendingWrite(runDir, workspaceRoot, path)

  const diff = lineDiff(before, after)
  if (diff.hunks.length === 0 || diffFingerprint(formatUnifiedDiff(path, diff, action)) !== req.diffHash) {
    throw new HunkUndoRefused('That file changed since its diff was shown — look at it again, then undo.')
  }
  const hunk = diff.hunks.find((h) => sameHunk(hunkIdentity(h), req.hunk))
  if (!hunk) throw new HunkUndoRefused('That hunk is no longer in the diff — look at it again, then undo.')

  // A file in an added folder is keyed by its absolute path (extraRoots.ts).
  const abs = resolveCheckpointPath(workspaceRoot, path, taskExtraRoots(runDir))
  const now = readWorkspaceText(abs)
  // The diff above read the file too; a write between the two is a change since.
  if (now.text !== after) throw new HunkUndoRefused('That file changed since its diff was shown — look at it again, then undo.')

  const patch = reverseHunk(hunk)
  const applied = applyHunkPatch(now.text, patch, { eol: endingOf(before) })
  if (!applied.ok) throw new HunkUndoRefused('That hunk no longer applies to the file as it is now.')

  atomicWriteFile(abs, applied.text, now.mode)
  restampAgentWrite(runDir, record.checkpointId, record.path, now.hash, sha256(Buffer.from(applied.text, 'utf8')))
  return {
    path,
    restoreToken: remember({ workspacePath: workspaceRoot, runId, path, patch: invertPatch(patch, applied.at) })
  }
}

/**
 * Put back a hunk {@link undoHunk} took out. The hunk is found where it was
 * left or, when other lines moved it since, at the nearest place it still
 * matches; a file changed under it is left as it is.
 */
export function restoreHunk(runDir: string, workspaceRoot: string, runId: string, token: string): { path: string } {
  const restore = restores.get(token)
  if (!restore || restore.runId !== runId || restore.workspacePath !== workspaceRoot) {
    throw new HunkUndoRefused('There is nothing to put back for that hunk any more.')
  }
  const record = pendingWrite(runDir, workspaceRoot, restore.path)
  const abs = resolveCheckpointPath(workspaceRoot, restore.path, taskExtraRoots(runDir))
  const now = readWorkspaceText(abs)
  const applied = applyHunkPatch(now.text, restore.patch, { maxOffset: 1000 })
  if (!applied.ok) throw new HunkUndoRefused('That file changed where the hunk was, so it was left as it is.')
  atomicWriteFile(abs, applied.text, now.mode)
  restampAgentWrite(runDir, record.checkpointId, record.path, now.hash, sha256(Buffer.from(applied.text, 'utf8')))
  restores.delete(token)
  return { path: restore.path }
}
