import { app } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { readdir } from 'fs/promises'
import { join } from 'path'
import type { DataWipePreviewResult } from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { listActiveRuns } from '../agent/runRegistry'
import { isGitRepo, listNonNoiseDirtyPaths, runGit } from '../git/git'
import { instanceWorktreesRoot } from '../git/instanceWorktree'
import { listTaskWorktrees } from '../git/taskWorktrees'
import { getHomeWorkspacePath, getWorkspaces } from '../workspace/workspaces'
import { userDataRoot, workspacesRoot } from './paths'
import { measureDir } from './retention'
import { requestDataWipe } from './wipeUserData'

/**
 * Settings → Storage → Delete all my data. The preview measures what goes; the
 * run echoes its token, leaves a request in the data folder and restarts. The
 * next launch does the deleting (wipeUserData), before anything opens a file.
 */

const TOKEN_TTL_MS = 10 * 60 * 1000
/** Each dirty check is a git process; past this many, the rest are counted unchecked. */
const MAX_DIRTY_CHECKS = 20

let pendingToken: { token: string; mintedAtMs: number } | null = null

async function countTasks(): Promise<number> {
  let tasks = 0
  let workspaceDirs: string[] = []
  try {
    workspaceDirs = await readdir(workspacesRoot())
  } catch {
    return 0
  }
  for (const id of workspaceDirs) {
    try {
      const entries = await readdir(join(workspacesRoot(), id, 'sessions'), { withFileTypes: true })
      tasks += entries.filter((e) => e.isDirectory()).length
    } catch {
      // No sessions folder: no tasks here.
    }
  }
  return tasks
}

/** Repositories whose `.git/worktrees` will point at folders the wipe removes. */
async function reposWithWorktreesInData(): Promise<string[]> {
  const repos = new Set<string>()
  for (const worktree of await listTaskWorktrees()) repos.add(worktree.parentPath)
  const { openPaths, recentPaths } = getWorkspaces()
  for (const path of [...openPaths, ...recentPaths]) {
    if (existsSync(instanceWorktreesRoot(path))) repos.add(path)
  }
  return [...repos].filter((repo) => existsSync(repo) && isGitRepo(repo))
}

export async function previewDataWipe(nowMs = Date.now()): Promise<DataWipePreviewResult> {
  const dataPath = userDataRoot()
  const worktrees = (await listTaskWorktrees()).filter((w) => existsSync(w.worktreeRoot))
  let uncommittedWorktrees = 0
  for (const worktree of worktrees.slice(0, MAX_DIRTY_CHECKS)) {
    if ((await listNonNoiseDirtyPaths(worktree.worktreeRoot)).length > 0) uncommittedWorktrees += 1
  }
  const [total, home, tasks] = await Promise.all([measureDir(dataPath), measureDir(getHomeWorkspacePath()), countTasks()])
  const token = randomUUID()
  pendingToken = { token, mintedAtMs: nowMs }
  return {
    dataPath,
    totalBytes: total.bytes,
    tasks,
    runningTasks: listActiveRuns().length,
    taskWorktrees: worktrees.length,
    uncommittedWorktrees,
    homeFiles: home.files,
    confirm: { token, mintedAt: new Date(nowMs).toISOString() }
  }
}

/**
 * Confirmed: leave the request and restart. The quit is the normal one — runs
 * stop and queued writes land — so nothing is open when the next launch deletes.
 */
export async function runDataWipe(confirmToken: string, nowMs = Date.now()): Promise<void> {
  const minted = pendingToken
  pendingToken = null
  if (!minted || minted.token !== confirmToken || nowMs - minted.mintedAtMs > TOKEN_TTL_MS) {
    throw new Error('That confirmation expired — check again')
  }
  const repos = await reposWithWorktreesInData()
  requestDataWipe(userDataRoot(), { repos })
  logger.warn('Delete all my data confirmed; restarting to delete', {
    scope: 'storage',
    code: 'DATA_WIPE_REQUESTED',
    count: repos.length
  })
  // After the reply reaches the renderer.
  setTimeout(() => {
    app.relaunch()
    app.quit()
  }, 100)
}

/** After a wipe: drop the worktree entries git still has for folders that are gone. */
export async function pruneWorktreesAfterWipe(repos: readonly string[]): Promise<void> {
  for (const repo of repos) {
    if (!existsSync(repo) || !isGitRepo(repo)) continue
    try {
      await runGit(['worktree', 'prune'], repo, 30_000)
    } catch (err) {
      logger.warn('git worktree prune after data wipe failed', { scope: 'storage', err })
    }
  }
}

export function resetDataWipeTokenForTests(): void {
  pendingToken = null
}
