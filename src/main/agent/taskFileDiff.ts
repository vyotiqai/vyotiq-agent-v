import { existsSync, readFileSync, statSync, type Stats } from 'fs'
import { readFile, stat } from 'fs/promises'
import { lineDiffStat } from '../../shared/utils/lineDiffStat'
import { formatUnifiedDiff, lineDiff } from '../../shared/utils/unifiedDiff'
import { createWorkspacePathResolver, resolveInsideWorkspace } from '../workspace/safePath'
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

/**
 * Every file the task wrote; the earliest checkpoint that touched a path owns
 * its before-image. A write that cannot be undone has none to use: its diff is
 * `unrestorable` and its row has no counts, whatever copy may sit on disk.
 */
function collectWritten(runDir: string): Map<string, Written> {
  const byPath = new Map<string, Written>()
  for (const meta of listCheckpointMetas(runDir)) {
    for (const file of meta.files) {
      if (byPath.has(file.path)) continue
      byPath.set(file.path, {
        path: file.path,
        firstAction: file.action,
        beforePath:
          file.action === 'created' || !file.undoable ? null : safeBeforePath(runDir, meta.id, file.path),
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

/**
 * Per file: its entry, and the before-image and file-now signatures it was
 * counted from. Keyed per file, so a write to one file re-reads and re-diffs
 * that file alone — the panel asks again after every write of a live run,
 * and a task can have written thousands of files.
 */
const statsCache = new Map<string, { signature: string; stat: TaskFileStat | null }>()
const STATS_CACHE_MAX = 50_000

/** Files counted at once: enough to keep the disk busy without taking the whole fs thread pool. */
const STATS_CONCURRENCY = 8

/**
 * One entry per file the task wrote, with exact counts where they can be had.
 *
 * Per-file path resolution, stats and reads are async. They ran on the main
 * thread in one piece — for a task that wrote 20,000 files, over a minute in
 * which the window could not paint or answer ("Not Responding" at every
 * launch, since the Changes list asks on open).
 */
export async function taskFileStats(runDir: string, workspaceRoot: string): Promise<TaskFileStat[]> {
  const written = [...collectWritten(runDir).values()]
  const resolve = createWorkspacePathResolver(workspaceRoot)
  const stats: Array<TaskFileStat | null> = new Array<TaskFileStat | null>(written.length).fill(null)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < written.length) {
      const i = next++
      stats[i] = await cachedStatFor(written[i]!, runDir, workspaceRoot, resolve)
    }
  }
  await Promise.all(Array.from({ length: Math.min(STATS_CONCURRENCY, written.length) }, worker))
  return stats.filter((s): s is TaskFileStat => s !== null).sort((a, b) => a.path.localeCompare(b.path))
}

async function statOrNull(path: string | null): Promise<Stats | null> {
  if (!path) return null
  try {
    return await stat(path)
  } catch {
    return null
  }
}

function statSignature(path: string | null, st: Stats | null): string {
  if (!path) return '-'
  return st ? `${st.size}:${st.mtimeMs}` : 'missing'
}

async function cachedStatFor(
  written: Written,
  runDir: string,
  workspaceRoot: string,
  resolve: ReturnType<typeof createWorkspacePathResolver>
): Promise<TaskFileStat | null> {
  const beforePath = written.beforePath
  const resolved = await resolve(written.path)
  const abs = resolved?.real ?? null
  const [beforeSt, afterSt] = await Promise.all([
    statOrNull(beforePath),
    resolved?.exists ? statOrNull(abs) : Promise.resolve(null)
  ])
  const signature = `${written.firstAction}:${written.undoable ? 1 : 0}:${statSignature(beforePath, beforeSt)}:${statSignature(abs, afterSt)}`
  const key = `${runDir}\0${workspaceRoot}\0${written.path}`
  const hit = statsCache.get(key)
  if (hit && hit.signature === signature) return hit.stat
  const entry = await statFor(written, beforePath, beforeSt, abs, afterSt)
  if (statsCache.size >= STATS_CACHE_MAX) statsCache.clear()
  statsCache.set(key, { signature, stat: entry })
  return entry
}

/** Text of a file already stat'ed: '' when a missing file means empty, null when it cannot be diffed. */
async function readStatedText(path: string | null, st: Stats | null, missingIsEmpty: boolean): Promise<string | null> {
  if (!path) return null
  if (!st) return missingIsEmpty ? '' : null
  if (!st.isFile() || st.size > MAX_DIFF_BYTES) return null
  try {
    const buf = await readFile(path)
    // NUL in the first 8 KB is how git decides a file is binary.
    if (buf.subarray(0, 8192).includes(0)) return null
    return buf.toString('utf8')
  } catch {
    return null
  }
}

async function statFor(
  written: Written,
  beforePath: string | null,
  beforeSt: Stats | null,
  abs: string | null,
  afterSt: Stats | null
): Promise<TaskFileStat | null> {
  const existsNow = afterSt !== null
  // Created, then deleted again: the task left nothing behind here.
  if (written.firstAction === 'created' && !existsNow) return null
  const entry: TaskFileStat = { path: written.path, action: netAction(written, existsNow) }
  const before = written.firstAction === 'created' ? '' : await readStatedText(beforePath, beforeSt, false)
  if (before === null) return entry
  const after = await readStatedText(abs, afterSt, true)
  if (after === null) return entry
  const counts = lineDiffStat(before, after)
  if (counts) {
    entry.add = counts.add
    entry.del = counts.del
  }
  return entry
}

export function resetTaskFileStatsCacheForTests(): void {
  statsCache.clear()
}

/** The diff of one file the task wrote, as `git diff` would print it. */
export function taskFileDiff(runDir: string, workspaceRoot: string, relPath: string): TaskFileDiff {
  const path = relPath.replace(/\\/g, '/').replace(/^\.\//, '')
  const written = collectWritten(runDir).get(path)
  if (!written) return { path, action: null, diff: null, reason: 'not_in_task' }
  // No before-image was kept — a recursive folder delete, or a terminal
  // command's change once the snapshot budget was spent. Say what happened to
  // the file now, not what a folder delete would have done.
  if (!written.undoable && written.firstAction !== 'created') {
    const abs = workspaceFile(workspaceRoot, path)
    return { path, action: netAction(written, abs !== null && existsSync(abs)), diff: null, reason: 'unrestorable' }
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
