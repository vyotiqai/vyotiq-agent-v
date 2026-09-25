import { existsSync, mkdirSync, realpathSync } from 'fs'
import { readFile } from 'fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import {
  TaskWorktreeSchema,
  type TaskWorktree,
  type TaskWorktreeInfo,
  type TaskWorktreeMergeResult
} from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { canonicalizeWorkspacePath, workspacePathsEqual } from '../../shared/workspacePath'
import { atomicWriteJsonAsync } from '../storage/atomicWrite'
import { userDataRoot, workspaceId } from '../storage/paths'
import {
  commitAll,
  currentGitBranch,
  gitAvailable,
  hasGitCommits,
  isGitRepo,
  listNonNoiseDirtyPaths,
  runGit
} from './git'
import {
  releaseInstanceWorktreeResources,
  removeInstanceWorktreeDirBestEffort,
  withGitWorktreeMutex
} from './instanceWorktree'

/**
 * A whole task in its own worktree. The folder lives under the app's data,
 * never in the project tree, so nothing in the repository sees it; the branch
 * is `vyotiq/<words from the brief>`. What was made is kept in one file so
 * only folders this module created can ever be merged from or deleted.
 */
const REGISTRY_FILE = 'task-worktrees.json'
const BRANCH_PREFIX = 'vyotiq/'
const SLUG_MAX = 40

type RegistryFile = { version: 1; worktrees: TaskWorktree[] }

let chain: Promise<unknown> = Promise.resolve()

function registryPath(): string {
  return join(userDataRoot(), REGISTRY_FILE)
}

/** Under `<userData>/task-worktrees/`, and not that folder itself. */
function isInsideTaskWorktrees(path: string): boolean {
  const root = resolve(userDataRoot(), 'task-worktrees')
  const target = resolve(path)
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  return process.platform === 'win32'
    ? target.toLowerCase().startsWith(prefix.toLowerCase())
    : target.startsWith(prefix)
}

function worktreesRoot(parentPath: string): string {
  return join(userDataRoot(), 'task-worktrees', workspaceId(canonicalizeWorkspacePath(parentPath)))
}

async function readRegistry(): Promise<TaskWorktree[]> {
  try {
    const raw = JSON.parse(await readFile(registryPath(), 'utf8')) as Partial<RegistryFile>
    const out: TaskWorktree[] = []
    for (const value of Array.isArray(raw?.worktrees) ? raw.worktrees : []) {
      const parsed = TaskWorktreeSchema.safeParse(value)
      if (parsed.success) out.push(parsed.data)
    }
    return out
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      logger.warn('task worktrees registry unreadable', { scope: 'git', err })
    }
    return []
  }
}

/** Read-modify-write under one queue, so two changes never drop each other. */
function updateRegistry<T>(change: (list: TaskWorktree[]) => { next: TaskWorktree[]; result: T }): Promise<T> {
  const run = chain.then(async () => {
    const { next, result } = change(await readRegistry())
    await atomicWriteJsonAsync(registryPath(), { version: 1, worktrees: next } satisfies RegistryFile)
    return result
  })
  chain = run.catch(() => undefined)
  return run
}

export async function findTaskWorktree(workspacePath: string): Promise<TaskWorktree | null> {
  await chain
  return (await readRegistry()).find((w) => workspacePathsEqual(w.workspacePath, workspacePath)) ?? null
}

/** "Fix the updater EBUSY on Windows" → "fix-the-updater-ebusy-on-windows". */
export function taskWorktreeSlug(brief: string): string {
  const firstLine = brief.split(/\r?\n/).find((line) => line.trim()) ?? ''
  const words = firstLine
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  let slug = ''
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word
    if (next.length > SLUG_MAX) break
    slug = next
  }
  if (!slug && words[0]) slug = words[0].slice(0, SLUG_MAX)
  // vyotiq/instance/* holds sub-agents' branches; a branch named that would collide.
  if (slug === 'instance') slug = 'instance-task'
  return slug || 'task'
}

/** git's own reason, one line: "fatal: …" / "error: …", else the message. */
function gitReason(err: unknown): string {
  const rec = (err ?? {}) as { stderr?: unknown; message?: unknown }
  const text = [typeof rec.stderr === 'string' ? rec.stderr : '', typeof rec.message === 'string' ? rec.message : '']
    .join('\n')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const line = text.find((l) => /^(fatal|error):/i.test(l)) ?? text.find((l) => !/^Command failed:/i.test(l)) ?? text[0]
  if (/please tell me who you are|unable to auto-detect email/i.test(text.join('\n'))) {
    return 'Git needs your name and email to commit (git config user.name and user.email)'
  }
  return (line ?? 'git failed').replace(/^(fatal|error):\s*/i, '')
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd, 5_000)
    return true
  } catch {
    return false
  }
}

function realOrSame(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * Branch the parent's current branch into a new worktree. Starts from its last
 * commit: uncommitted files in the parent stay there.
 */
export async function createTaskWorktree(parentPath: string, brief: string): Promise<TaskWorktree> {
  const parent = canonicalizeWorkspacePath(parentPath)
  if (!(await gitAvailable())) throw new Error('Git is not installed or not on PATH')
  if (!isGitRepo(parent)) throw new Error('This folder is not a git repository')
  const baseBranch = await currentGitBranch(parent)
  if (!baseBranch) throw new Error('Check out a branch first — a worktree branches from one')
  if (!(await hasGitCommits(parent))) throw new Error('The repository has no commits yet — a worktree starts from one')

  // A workspace opened at a subfolder of the repository opens at that subfolder in the worktree.
  const top = (await runGit(['rev-parse', '--show-toplevel'], parent, 5_000)).trim()
  const sub = relative(realOrSame(top), realOrSame(parent))
  if (sub.startsWith('..') || isAbsolute(sub)) throw new Error('Could not place this folder inside its repository')

  return withGitWorktreeMutex(parent, async () => {
    const root = worktreesRoot(parent)
    mkdirSync(root, { recursive: true })
    const slug = taskWorktreeSlug(brief)
    for (let n = 1; n <= 50; n++) {
      const name = n === 1 ? slug : `${slug}-${n}`
      const branch = `${BRANCH_PREFIX}${name}`
      const worktreeRoot = join(root, name)
      if (existsSync(worktreeRoot) || (await branchExists(parent, branch))) continue
      try {
        await runGit(['worktree', 'add', '-b', branch, worktreeRoot, 'HEAD'], parent, 60_000)
      } catch (err) {
        const reason = gitReason(err)
        // Another ref under that name (a vyotiq/<name>/… branch): try the next name.
        if (/already exists|cannot lock ref/i.test(reason)) continue
        throw new Error(`Couldn’t make the worktree: ${reason}`)
      }
      const record: TaskWorktree = {
        workspacePath: canonicalizeWorkspacePath(sub ? join(worktreeRoot, sub) : worktreeRoot),
        worktreeRoot: canonicalizeWorkspacePath(worktreeRoot),
        parentPath: parent,
        branch,
        baseBranch,
        createdAt: new Date().toISOString()
      }
      await updateRegistry((list) => ({ next: [...list, record], result: undefined }))
      logger.info('task worktree created', { scope: 'git', branch, baseBranch })
      return record
    }
    throw new Error('Couldn’t find a free name for the worktree’s branch')
  })
}

async function countRevs(cwd: string, args: string[]): Promise<number> {
  const n = Number((await runGit(['rev-list', '--count', ...args], cwd, 5_000)).trim())
  if (!Number.isFinite(n) || n < 0) throw new Error('git rev-list gave no count')
  return n
}

/**
 * Commits on the branch its base doesn't have. With the base gone (deleted or
 * renamed) there is nothing to compare with, so it counts the commits no other
 * local branch has — what deleting the branch would lose. Never a silent 0:
 * Discard's warning reads this.
 */
async function commitsAhead(
  cwd: string,
  base: string,
  branch: string
): Promise<{ count: number; baseMissing: boolean }> {
  if (await branchExists(cwd, base)) {
    return { count: await countRevs(cwd, [`refs/heads/${base}..refs/heads/${branch}`]), baseMissing: false }
  }
  return {
    count: await countRevs(cwd, [`refs/heads/${branch}`, '--not', `--exclude=${branch}`, '--branches']),
    baseMissing: true
  }
}

export async function taskWorktreeInfo(workspacePath: string): Promise<TaskWorktreeInfo | null> {
  const record = await findTaskWorktree(workspacePath)
  if (!record) return null
  const here = existsSync(record.worktreeRoot) && isGitRepo(record.worktreeRoot)
  const ahead = here ? await commitsAhead(record.worktreeRoot, record.baseBranch, record.branch) : null
  return {
    ...record,
    ahead: ahead?.count ?? 0,
    baseMissing: ahead?.baseMissing ?? false,
    uncommitted: here ? (await listNonNoiseDirtyPaths(record.worktreeRoot)).length : 0,
    parentExists: existsSync(record.parentPath) && isGitRepo(record.parentPath)
  }
}

/**
 * Commit what is uncommitted in the worktree, then merge its branch into the
 * branch it came from, in the folder it came from. A merge that would conflict
 * is aborted: the parent is left exactly as it was, and the files are named.
 */
export async function mergeTaskWorktree(workspacePath: string, message: string): Promise<TaskWorktreeMergeResult> {
  const record = await findTaskWorktree(workspacePath)
  if (!record) throw new Error('This workspace is not a task worktree')
  const parent = record.parentPath
  if (!existsSync(parent) || !isGitRepo(parent)) throw new Error('The folder it came from is gone')
  if (!(await branchExists(parent, record.baseBranch))) {
    throw new Error(`Its base branch ${record.baseBranch} is gone — there is nothing to merge into`)
  }
  const onBranch = await currentGitBranch(parent)
  if (onBranch !== record.baseBranch) {
    throw new Error(
      `The folder it came from is on ${onBranch ?? 'a detached HEAD'} now — check out ${record.baseBranch} there to merge into it`
    )
  }

  let committedFirst = false
  if ((await listNonNoiseDirtyPaths(record.worktreeRoot)).length > 0) {
    try {
      committedFirst = (await commitAll(record.worktreeRoot, message, false, 'all')).committed
    } catch (err) {
      throw new Error(`Couldn’t commit the worktree’s changes: ${gitReason(err)}`)
    }
  }
  const { count: commits } = await commitsAhead(record.worktreeRoot, record.baseBranch, record.branch)
  if (commits === 0) throw new Error(`Nothing to merge — ${record.baseBranch} already has everything on ${record.branch}`)

  return withGitWorktreeMutex(parent, async (): Promise<TaskWorktreeMergeResult> => {
    try {
      await runGit(['merge', '--no-edit', record.branch], parent, 60_000)
    } catch (err) {
      let conflicts: string[] = []
      try {
        conflicts = (await runGit(['diff', '--name-only', '--diff-filter=U'], parent, 5_000))
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      } catch {
        /* no merge in progress */
      }
      if (conflicts.length > 0) {
        await runGit(['merge', '--abort'], parent, 30_000)
        return { merged: false, conflicts, committedFirst }
      }
      throw new Error(`Couldn’t merge: ${gitReason(err)}`)
    }
    const mergedAt = new Date().toISOString()
    await updateRegistry((list) => ({
      next: list.map((w) => (workspacePathsEqual(w.workspacePath, record.workspacePath) ? { ...w, mergedAt } : w)),
      result: undefined
    }))
    logger.info('task worktree merged', { scope: 'git', branch: record.branch, commits })
    return { merged: true, commits, committedFirst }
  })
}

/**
 * Delete the worktree folder and its branch. Only a worktree this module made;
 * the renderer closes its workspace first, so nothing of the app holds it.
 */
export async function discardTaskWorktree(workspacePath: string): Promise<void> {
  const record = await findTaskWorktree(workspacePath)
  if (!record) throw new Error('This workspace is not a task worktree')
  if (!isInsideTaskWorktrees(record.worktreeRoot) || !record.branch.startsWith(BRANCH_PREFIX)) {
    throw new Error('This worktree is not one the app made, so it will not delete it')
  }
  await releaseInstanceWorktreeResources(record.workspacePath)
  if (!workspacePathsEqual(record.workspacePath, record.worktreeRoot)) {
    await releaseInstanceWorktreeResources(record.worktreeRoot)
  }
  const parent = record.parentPath
  const parentRepo = existsSync(parent) && isGitRepo(parent)

  await withGitWorktreeMutex(parent, async () => {
    if (parentRepo && existsSync(record.worktreeRoot)) {
      try {
        await runGit(['worktree', 'remove', '--force', record.worktreeRoot], parent, 60_000)
      } catch (err) {
        logger.warn('task worktree git remove failed; deleting the folder', { scope: 'git', err: gitReason(err) })
      }
    }
    if (existsSync(record.worktreeRoot)) {
      try {
        await removeInstanceWorktreeDirBestEffort(record.worktreeRoot)
      } catch {
        throw new Error('Couldn’t delete the worktree folder — something still has a file open in it')
      }
    }
    if (parentRepo) {
      try {
        await runGit(['worktree', 'prune'], parent, 30_000)
      } catch {
        /* best-effort: git prunes it on its own later */
      }
      if (await branchExists(parent, record.branch)) {
        try {
          await runGit(['branch', '-D', record.branch], parent, 30_000)
        } catch (err) {
          throw new Error(`The folder is gone, but its branch ${record.branch} couldn’t be deleted: ${gitReason(err)}`)
        }
      }
    }
  })
  await updateRegistry((list) => ({
    next: list.filter((w) => !workspacePathsEqual(w.workspacePath, record.workspacePath)),
    result: undefined
  }))
  logger.info('task worktree discarded', { scope: 'git', branch: record.branch })
}
