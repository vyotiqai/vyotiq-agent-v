import { cp, mkdir, readFile, readdir, rename, rm, stat } from 'fs/promises'
import { join } from 'path'
import { atomicWriteJson } from '../storage/atomicWrite'
import { workspaceSessionsRoot, workspaceUsageDir } from '../storage/paths'
import { logger } from '../../shared/logger'

/**
 * Recently deleted tasks. Deleting a task moves its run folder (and its helper
 * instances' folders) here, beside `sessions/` so no listing sees it; it can
 * be restored for 30 days, then it is removed for good. A task's worktree
 * branches are not kept: those go when it is deleted, as before.
 *
 * Every file operation here is async. A move falls back to copy-and-remove
 * when Windows holds a handle, and the list sizes every deleted run: done
 * synchronously, both ran on the main thread, the shape that has frozen the
 * window ("Not Responding") before.
 */

export const DELETED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const MARKER = '.deleted.json'
const INSTANCES_DIR = '__instances'

export type DeletedRunMarker = { runId: string; deletedAt: string; goal?: string; instances: string[] }
export type DeletedRun = DeletedRunMarker & { bytes: number }

function deletedRoot(workspacePath: string): string {
  return join(workspaceUsageDir(workspacePath), 'deleted')
}

/** A run id as a folder name: what resolveRunDir would accept. */
function safeId(runId: string): string {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(runId) || runId === '.' || runId === '..') {
    throw new Error(`Invalid run id: ${runId}`)
  }
  return runId
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Rename, else copy then remove (a rename across devices, or a held handle on Windows). */
async function moveDir(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch {
    await cp(from, to, { recursive: true, errorOnExist: true, force: false })
    await rm(from, { recursive: true, force: true })
  }
}

async function dirBytes(dir: string): Promise<number> {
  let total = 0
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) total += await dirBytes(p)
      else if (entry.isFile()) total += (await stat(p)).size
    }
  } catch {
    // An unreadable folder counts what could be read.
  }
  return total
}

/**
 * Move a task (already drained of writers, with no live run) into Recently
 * deleted. `instanceDirs` are its helper instances' run folders.
 */
export async function moveRunToDeleted(
  workspacePath: string,
  runId: string,
  runDir: string,
  opts: { goal?: string; instanceDirs?: Array<{ runId: string; dir: string }>; now?: Date } = {}
): Promise<void> {
  const root = deletedRoot(workspacePath)
  const target = join(root, safeId(runId))
  await mkdir(root, { recursive: true })
  // A task deleted, restored and deleted again: the newer copy wins.
  if (await exists(target)) await rm(target, { recursive: true, force: true })
  await moveDir(runDir, target)
  const moved: string[] = []
  for (const child of opts.instanceDirs ?? []) {
    if (!(await exists(child.dir))) continue
    const childTarget = join(target, INSTANCES_DIR, safeId(child.runId))
    await mkdir(join(target, INSTANCES_DIR), { recursive: true })
    await moveDir(child.dir, childTarget)
    moved.push(child.runId)
  }
  const marker: DeletedRunMarker = {
    runId,
    deletedAt: (opts.now ?? new Date()).toISOString(),
    ...(opts.goal ? { goal: opts.goal } : {}),
    instances: moved
  }
  atomicWriteJson(join(target, MARKER), marker)
}

async function readMarker(dir: string): Promise<DeletedRunMarker | null> {
  try {
    const raw = JSON.parse(await readFile(join(dir, MARKER), 'utf8')) as Partial<DeletedRunMarker>
    if (typeof raw.runId !== 'string' || typeof raw.deletedAt !== 'string') return null
    return {
      runId: raw.runId,
      deletedAt: raw.deletedAt,
      ...(typeof raw.goal === 'string' ? { goal: raw.goal } : {}),
      instances: Array.isArray(raw.instances) ? raw.instances.filter((x): x is string => typeof x === 'string') : []
    }
  } catch {
    return null
  }
}

/** The workspace's recently deleted tasks, newest first. */
export async function listDeletedRuns(workspacePath: string): Promise<DeletedRun[]> {
  const root = deletedRoot(workspacePath)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: DeletedRun[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const marker = await readMarker(dir)
    if (!marker) continue
    out.push({ ...marker, bytes: await dirBytes(dir) })
  }
  return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
}

/** Put a deleted task (and its instances) back where it was. */
export async function restoreDeletedRun(workspacePath: string, runId: string): Promise<void> {
  const source = join(deletedRoot(workspacePath), safeId(runId))
  const marker = await readMarker(source)
  if (!marker) throw new Error('That task is not in Recently deleted')
  const sessions = workspaceSessionsRoot(workspacePath)
  const target = join(sessions, safeId(runId))
  if (await exists(target)) throw new Error('A task with that id is already in the workspace')
  await mkdir(sessions, { recursive: true })
  const instancesDir = join(source, INSTANCES_DIR)
  if (await exists(instancesDir)) {
    for (const childId of marker.instances) {
      const childSource = join(instancesDir, safeId(childId))
      const childTarget = join(sessions, safeId(childId))
      if ((await exists(childSource)) && !(await exists(childTarget))) await moveDir(childSource, childTarget)
    }
    await rm(instancesDir, { recursive: true, force: true })
  }
  await rm(join(source, MARKER), { force: true })
  await moveDir(source, target)
}

/** Remove one deleted task for good. */
export async function purgeDeletedRun(workspacePath: string, runId: string): Promise<boolean> {
  const dir = join(deletedRoot(workspacePath), safeId(runId))
  if (!(await exists(dir))) return false
  await rm(dir, { recursive: true, force: true })
  return true
}

/** Remove what has been in Recently deleted longer than 30 days. Returns how many went. */
export async function purgeExpiredDeletedRuns(workspacePath: string, now = Date.now()): Promise<number> {
  let removed = 0
  for (const run of await listDeletedRuns(workspacePath)) {
    const at = Date.parse(run.deletedAt)
    if (Number.isFinite(at) && now - at < DELETED_RETENTION_MS) continue
    try {
      if (await purgeDeletedRun(workspacePath, run.runId)) removed += 1
    } catch (err) {
      logger.warn('Could not remove an expired deleted task', { scope: 'runs', runId: run.runId, err })
    }
  }
  return removed
}
