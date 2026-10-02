import { lineDiffStat } from '../../shared/utils/lineDiffStat'
import { mapLimit } from '../../shared/utils/mapLimit'
import {
  checkpointBeforeImagePath,
  listCheckpointMetasAsync,
  type CheckpointFileAction,
  type WriteCheckpointMeta
} from './checkpoints'
import { checkpointsExtraRoots, readStatedText, rootsPathResolver, statOrNull } from './taskFileDiff'

/**
 * A finished task's edits that still wait on Keep or Undo — the navigator's
 * "Ready for review" and its "+52 −4".
 *
 * Same set the Changes panel offers Keep/Undo on after a reload: every file of
 * every checkpoint that is neither undone nor fully resolved, where the file
 * itself is undoable and not yet kept or discarded.
 *
 * Counts compare the before-image the agent's first write saved with the file
 * as it is now. They are exact or absent: a file that is binary, too large or
 * unreadable drops the numbers for the whole task instead of under-counting.
 *
 * Asked for every task each time the task list is read, so nothing here
 * blocks: a task that left a thousand files waiting was a second of
 * synchronous stat and read calls on the main thread per listing.
 */
export type PendingReview = { files: number; add?: number; del?: number }

type Pending = { path: string; action: CheckpointFileAction; beforePath: string | null }

/** Workspace files checked at once. */
const STAT_CONCURRENCY = 8

const cache = new Map<string, { signature: string; review: PendingReview | undefined }>()

export async function pendingReviewSummary(
  runDir: string,
  workspaceRoot: string
): Promise<PendingReview | undefined> {
  const metas = await listCheckpointMetasAsync(runDir)
  // Files in the task's added folders are keyed absolute (extraRoots.ts).
  const resolve = rootsPathResolver(workspaceRoot, checkpointsExtraRoots(metas))
  const candidates = await mapLimit(
    collectPending(runDir, metas),
    STAT_CONCURRENCY,
    async (file) => {
      const resolved = await resolve(file.path)
      const st = resolved?.exists ? await statOrNull(resolved.real) : null
      return { ...file, resolved, st }
    }
  )
  // A file the task created and later deleted left nothing to review — the
  // Changes list skips it too, so the count here must.
  const pending = candidates.filter((p) => p.action !== 'created' || p.resolved?.exists === true)
  if (pending.length === 0) {
    cache.delete(runDir)
    return undefined
  }
  const signature = pending
    .map((p) => `${p.path}:${p.action}:${p.st ? `${p.st.size}:${p.st.mtimeMs}` : 'missing'}`)
    .join('|')
  const hit = cache.get(runDir)
  if (hit && hit.signature === signature) return hit.review

  const review: PendingReview = { files: pending.length }
  let add = 0
  let del = 0
  let exact = true
  for (const file of pending) {
    // Before the agent's first write, against the file as it is now — so a
    // file created and later deleted by the task nets out to nothing.
    const before =
      file.action === 'created' ? '' : await readStatedText(file.beforePath, await statOrNull(file.beforePath), false)
    // Gone now (the agent deleted it, or someone did since): every line removed.
    const after = !file.resolved
      ? null
      : !file.resolved.exists
        ? ''
        : await readStatedText(file.resolved.real, file.st, false)
    if (before === null || after === null) {
      exact = false
      break
    }
    const stat = lineDiffStat(before, after)
    if (!stat) {
      exact = false
      break
    }
    add += stat.add
    del += stat.del
  }
  if (exact) {
    review.add = add
    review.del = del
  }
  cache.set(runDir, { signature, review })
  return review
}

/** Unresolved files, deduped by path; the earliest checkpoint that touched a path owns its before-image. */
function collectPending(runDir: string, metas: readonly WriteCheckpointMeta[]): Pending[] {
  const byPath = new Map<string, Pending>()
  for (const meta of metas) {
    if (meta.undone || meta.resolved) continue
    for (const file of meta.files) {
      if (file.resolved || !file.undoable) continue
      if (byPath.has(file.path)) continue
      byPath.set(file.path, {
        path: file.path,
        action: file.action,
        beforePath: file.action === 'created' ? null : safeBeforePath(runDir, meta.id, file.path)
      })
    }
  }
  return [...byPath.values()]
}

function safeBeforePath(runDir: string, checkpointId: string, relPath: string): string | null {
  try {
    return checkpointBeforeImagePath(runDir, checkpointId, relPath)
  } catch {
    return null
  }
}

export function resetPendingReviewCacheForTests(): void {
  cache.clear()
}
