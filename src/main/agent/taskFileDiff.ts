import { existsSync, readFileSync, statSync, type Stats } from 'fs'
import { readFile, stat } from 'fs/promises'
import { lineDiffStat } from '../../shared/utils/lineDiffStat'
import { mapLimit } from '../../shared/utils/mapLimit'
import { formatUnifiedDiff, lineDiff } from '../../shared/utils/unifiedDiff'
import { createWorkspacePathResolver } from '../workspace/safePath'
import { extraRootFor, isAbsolutePathLike } from '../../shared/extraRoots'
import {
  checkpointBeforeImagePath,
  listCheckpointMetas,
  listCheckpointMetasAsync,
  resolveCheckpointPath,
  type WriteCheckpointMeta
} from './checkpoints'

/**
 * Every added folder the task's turns wrote under (extraRoots.ts), from the
 * checkpoints themselves: a file keyed by its absolute path is read only
 * while it is inside one of them.
 */
export function checkpointsExtraRoots(metas: readonly WriteCheckpointMeta[]): string[] {
  const out: string[] = []
  for (const meta of metas) {
    for (const root of meta.extraRoots ?? []) if (!out.includes(root)) out.push(root)
  }
  return out
}

/** The added folders a run's checkpoints recorded. */
export function taskExtraRoots(runDir: string): string[] {
  return checkpointsExtraRoots(listCheckpointMetas(runDir))
}

/** taskExtraRoots off the main thread's back, through the metas' parse cache. */
export async function taskExtraRootsAsync(runDir: string): Promise<string[]> {
  return checkpointsExtraRoots(await listCheckpointMetasAsync(runDir))
}

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
  /**
   * Too far apart to diff line by line: shown as one full replacement. Not a
   * claim about the numbers — when `add`/`del` are there they are exact, counted
   * by {@link lineDiffStat} at its own (higher) edit budget, so this view and
   * the list agree.
   */
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
function collectWritten(runDir: string, metas: readonly WriteCheckpointMeta[]): Map<string, Written> {
  const byPath = new Map<string, Written>()
  for (const meta of metas) {
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

function workspaceFile(workspaceRoot: string, relPath: string, extraRoots: readonly string[] = []): string | null {
  try {
    return resolveCheckpointPath(workspaceRoot, relPath, extraRoots)
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

function sides(
  written: Written,
  workspaceRoot: string,
  extraRoots: readonly string[]
): { before: string | null; after: string | null; existsNow: boolean } {
  const abs = workspaceFile(workspaceRoot, written.path, extraRoots)
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
  const metas = await listCheckpointMetasAsync(runDir)
  const written = [...collectWritten(runDir, metas).values()]
  const resolve = rootsPathResolver(workspaceRoot, checkpointsExtraRoots(metas))
  const stats = await mapLimit(written, STATS_CONCURRENCY, (file) => cachedStatFor(file, runDir, workspaceRoot, resolve))
  return stats.filter((s): s is TaskFileStat => s !== null).sort((a, b) => a.path.localeCompare(b.path))
}

type PathResolver = ReturnType<typeof createWorkspacePathResolver>

/**
 * The workspace's resolver, plus one per added folder for the files keyed by
 * absolute path in it. A key in no listed folder resolves to nothing.
 */
export function rootsPathResolver(workspaceRoot: string, extraRoots: readonly string[]): PathResolver {
  const primary = createWorkspacePathResolver(workspaceRoot)
  if (extraRoots.length === 0) return primary
  const byRoot = new Map<string, PathResolver>()
  return async (key) => {
    if (!isAbsolutePathLike(key)) return primary(key)
    const inWorkspace = await primary(key)
    if (inWorkspace) return inWorkspace
    const root = extraRootFor(key, extraRoots)
    if (!root) return null
    let resolver = byRoot.get(root)
    if (!resolver) {
      resolver = createWorkspacePathResolver(root)
      byRoot.set(root, resolver)
    }
    return resolver(key)
  }
}

export async function statOrNull(path: string | null): Promise<Stats | null> {
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
  resolve: PathResolver
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
export async function readStatedText(
  path: string | null,
  st: Stats | null,
  missingIsEmpty: boolean
): Promise<string | null> {
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

/**
 * The two texts one file's task diff is made from: the before-image its first
 * write saved and the file now ('' for a side that does not exist), or why
 * there are none to compare.
 */
export type TaskFileSides =
  | { ok: true; path: string; action: TaskFileAction; before: string; after: string }
  | { ok: false; path: string; action: TaskFileAction | null; reason: TaskFileDiffReason }

export function taskFileSides(runDir: string, workspaceRoot: string, relPath: string): TaskFileSides {
  const path = relPath.replace(/\\/g, '/').replace(/^\.\//, '')
  const metas = listCheckpointMetas(runDir)
  const written = collectWritten(runDir, metas).get(path)
  if (!written) return { ok: false, path, action: null, reason: 'not_in_task' }
  const extraRoots = checkpointsExtraRoots(metas)
  // No before-image was kept — a recursive folder delete, or a terminal
  // command's change once the snapshot budget was spent. Say what happened to
  // the file now, not what a folder delete would have done.
  if (!written.undoable && written.firstAction !== 'created') {
    const abs = workspaceFile(workspaceRoot, path, extraRoots)
    return { ok: false, path, action: netAction(written, abs !== null && existsSync(abs)), reason: 'unrestorable' }
  }
  const { before, after, existsNow } = sides(written, workspaceRoot, extraRoots)
  const action = netAction(written, existsNow)
  if (before === null || after === null) return { ok: false, path, action, reason: 'binary_or_large' }
  return { ok: true, path, action, before, after }
}

/** The diff of one file the task wrote, as `git diff` would print it. */
export function taskFileDiff(runDir: string, workspaceRoot: string, relPath: string): TaskFileDiff {
  const sided = taskFileSides(runDir, workspaceRoot, relPath)
  if (!sided.ok) return { path: sided.path, action: sided.action, diff: null, reason: sided.reason }
  const { path, action, before, after } = sided
  const diff = lineDiff(before, after)
  if (diff.hunks.length === 0) return { path, action, diff: null, add: 0, del: 0 }
  return {
    path,
    action,
    diff: formatUnifiedDiff(path, diff, action),
    // Past `lineDiff`'s own budget the hunk is a whole-file replacement, so its
    // counts are the replacement's, not the change's. The list counted this
    // file with `lineDiffStat`, which has the higher budget: count it the same
    // way here, so the two views report one number. Beyond *that* budget there
    // is no exact count, and none is invented.
    ...(diff.full ? { full: true, ...exactCounts(before, after) } : { add: diff.add, del: diff.del })
  }
}

/** `add`/`del` for two texts, or nothing when even the counting budget is passed. */
function exactCounts(before: string, after: string): { add?: number; del?: number } {
  const counts = lineDiffStat(before, after)
  return counts ? { add: counts.add, del: counts.del } : {}
}
