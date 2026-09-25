import { existsSync, readFileSync, statSync } from 'fs'
import { lineDiffStat } from '../../shared/utils/lineDiffStat'
import { resolveInsideWorkspace } from '../workspace/safePath'
import { checkpointBeforeImagePath, listCheckpointMetas, type CheckpointFileAction } from './checkpoints'

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
 */
export type PendingReview = { files: number; add?: number; del?: number }

/** Files above this are not diffed; the task then shows a file count only. */
const MAX_DIFF_BYTES = 2 * 1024 * 1024

type Pending = { path: string; action: CheckpointFileAction; beforePath: string | null }

const cache = new Map<string, { signature: string; review: PendingReview | undefined }>()

export function pendingReviewSummary(runDir: string, workspaceRoot: string): PendingReview | undefined {
  // A file the task created and later deleted left nothing to review — the
  // Changes list skips it too, so the count here must.
  const pending = collectPending(runDir).filter((p) => p.action !== 'created' || fileExists(workspaceRoot, p.path))
  if (pending.length === 0) {
    cache.delete(runDir)
    return undefined
  }
  const signature = pending.map((p) => `${p.path}:${p.action}:${statSignature(workspaceRoot, p.path)}`).join('|')
  const hit = cache.get(runDir)
  if (hit && hit.signature === signature) return hit.review

  const review: PendingReview = { files: pending.length }
  let add = 0
  let del = 0
  let exact = true
  for (const file of pending) {
    // Before the agent's first write, against the file as it is now — so a
    // file created and later deleted by the task nets out to nothing.
    const before = file.action === 'created' ? '' : readText(file.beforePath)
    const after = readWorkspaceText(workspaceRoot, file.path)
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
function collectPending(runDir: string): Pending[] {
  const byPath = new Map<string, Pending>()
  for (const meta of listCheckpointMetas(runDir)) {
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

function fileExists(workspaceRoot: string, relPath: string): boolean {
  try {
    return existsSync(resolveInsideWorkspace(workspaceRoot, relPath))
  } catch {
    return false
  }
}

function statSignature(workspaceRoot: string, relPath: string): string {
  try {
    const st = statSync(resolveInsideWorkspace(workspaceRoot, relPath))
    return `${st.size}:${st.mtimeMs}`
  } catch {
    return 'missing'
  }
}

function readWorkspaceText(workspaceRoot: string, relPath: string): string | null {
  let abs: string
  try {
    abs = resolveInsideWorkspace(workspaceRoot, relPath)
  } catch {
    return null
  }
  // Gone now (the agent deleted it, or someone did since): every line removed.
  if (!existsSync(abs)) return ''
  return readText(abs)
}

function readText(path: string | null): string | null {
  if (!path) return null
  try {
    const st = statSync(path)
    if (!st.isFile() || st.size > MAX_DIFF_BYTES) return null
    const buf = readFileSync(path)
    // NUL in the first 8 KB is how git decides a file is binary.
    if (buf.subarray(0, 8192).includes(0)) return null
    return buf.toString('utf8')
  } catch {
    return null
  }
}

export function resetPendingReviewCacheForTests(): void {
  cache.clear()
}
