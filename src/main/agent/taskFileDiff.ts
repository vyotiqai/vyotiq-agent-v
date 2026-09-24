import { existsSync, readFileSync, statSync } from 'fs'
import { lineDiffStat } from '../../shared/utils/lineDiffStat'
import { formatUnifiedDiff, lineDiff } from '../../shared/utils/unifiedDiff'
import { resolveInsideWorkspace } from '../workspace/safePath'
import { checkpointBeforeImagePath, listCheckpointMetas } from './checkpoints'

/**
 * What a task did to each file it wrote, net of all its turns: the
 * before-image its first write saved, against the file as it is now.
 *
 * The same comparison the navigator's "+52 −4" makes (see reviewSummary),
 * per file and for every file the task wrote — kept, undone or still waiting —
 * so the Changes list, its diffs and the navigator agree. Counts are exact or
 * absent: a binary, oversized or unreadable file has none rather than a guess.
 *
 * Every checkpoint counts, undone or not — `undone` is also stamped on a turn
 * whose files were all kept. An undone file needs no special case: it was put
 * back to its before-image, so it nets out against the file as it is now.
 */
export type TaskFileAction = 'created' | 'modified' | 'deleted'

export type TaskFileStat = { path: string; action: TaskFileAction; add?: number; del?: number }

export type TaskFileDiffReason = 'binary_or_large' | 'not_in_task' | 'unrestorable'

export type TaskFileDiff = {
  path: string
  action: TaskFileAction | null
  /** `git diff`-shaped text for this file, or null when there is none to show. */
  diff: string | null
  add?: number
  del?: number
  /** Too far apart to diff line by line: shown as one full replacement. */
  full?: boolean
  reason?: TaskFileDiffReason
}

/** Files above this are not diffed. */
const MAX_DIFF_BYTES = 2 * 1024 * 1024

type Written = { path: string; firstAction: TaskFileAction; beforePath: string | null; undoable: boolean }

/** Every file the task wrote; the earliest checkpoint that touched a path owns its before-image. */
function collectWritten(runDir: string): Map<string, Written> {
  const byPath = new Map<string, Written>()
  for (const meta of listCheckpointMetas(runDir)) {
    for (const file of meta.files) {
      if (byPath.has(file.path)) continue
      byPath.set(file.path, {
        path: file.path,
        firstAction: file.action,
        beforePath: file.action === 'created' ? null : safeBeforePath(runDir, meta.id, file.path),
        undoable: file.undoable
      })
    }
  }
  return byPath
}

function safeBeforePath(runDir: string, checkpointId: string, relPath: string): string | null {
  try {
    return checkpointBeforeImagePath(runDir, checkpointId, relPath)
  } catch {
    return null
  }
}

function workspaceFile(workspaceRoot: string, relPath: string): string | null {
  try {
    return resolveInsideWorkspace(workspaceRoot, relPath)
  } catch {
    return null
  }
}

/** Text of a file, '' when it does not exist, null when it cannot be diffed. */
function readText(path: string | null, missingIsEmpty: boolean): string | null {
  if (!path) return null
  if (!existsSync(path)) return missingIsEmpty ? '' : null
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

function netAction(written: Written, existsNow: boolean): TaskFileAction {
  if (written.firstAction === 'created') return 'created'
  return existsNow ? 'modified' : 'deleted'
}

function sides(written: Written, workspaceRoot: string): { before: string | null; after: string | null; existsNow: boolean } {
  const abs = workspaceFile(workspaceRoot, written.path)
  const existsNow = abs !== null && existsSync(abs)
  const before = written.firstAction === 'created' ? '' : readText(written.beforePath, false)
  const after = abs ? readText(abs, true) : null
  return { before, after, existsNow }
}

function statSignature(path: string | null): string {
  if (!path) return '-'
  try {
    const st = statSync(path)
    return `${st.size}:${st.mtimeMs}`
  } catch {
    return 'missing'
  }
}

const statsCache = new Map<string, { signature: string; stats: TaskFileStat[] }>()

/** One entry per file the task wrote, with exact counts where they can be had. */
export function taskFileStats(runDir: string, workspaceRoot: string): TaskFileStat[] {
  const written = [...collectWritten(runDir).values()]
  const signature = written
    .map((w) => `${w.path}:${w.firstAction}:${statSignature(w.beforePath)}:${statSignature(workspaceFile(workspaceRoot, w.path))}`)
    .join('|')
  const key = `${runDir}\0${workspaceRoot}`
  const hit = statsCache.get(key)
  if (hit && hit.signature === signature) return hit.stats
  const stats = computeStats(written, workspaceRoot)
  statsCache.set(key, { signature, stats })
  return stats
}

function computeStats(all: Written[], workspaceRoot: string): TaskFileStat[] {
  const out: TaskFileStat[] = []
  for (const written of all) {
    const { before, after, existsNow } = sides(written, workspaceRoot)
    // Created, then deleted again: the task left nothing behind here.
    if (written.firstAction === 'created' && !existsNow) continue
    const entry: TaskFileStat = { path: written.path, action: netAction(written, existsNow) }
    if (before !== null && after !== null) {
      const stat = lineDiffStat(before, after)
      if (stat) {
        entry.add = stat.add
        entry.del = stat.del
      }
    }
    out.push(entry)
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export function resetTaskFileStatsCacheForTests(): void {
  statsCache.clear()
}

/** The diff of one file the task wrote, as `git diff` would print it. */
export function taskFileDiff(runDir: string, workspaceRoot: string, relPath: string): TaskFileDiff {
  const path = relPath.replace(/\\/g, '/').replace(/^\.\//, '')
  const written = collectWritten(runDir).get(path)
  if (!written) return { path, action: null, diff: null, reason: 'not_in_task' }
  // A recursive directory delete keeps no before-image to compare with.
  if (!written.undoable && written.firstAction !== 'created') {
    return { path, action: 'deleted', diff: null, reason: 'unrestorable' }
  }
  const { before, after, existsNow } = sides(written, workspaceRoot)
  const action = netAction(written, existsNow)
  if (before === null || after === null) return { path, action, diff: null, reason: 'binary_or_large' }
  const diff = lineDiff(before, after)
  if (diff.hunks.length === 0) return { path, action, diff: null, add: 0, del: 0 }
  return {
    path,
    action,
    diff: formatUnifiedDiff(path, diff, action),
    ...(diff.full ? { full: true } : { add: diff.add, del: diff.del })
  }
}
