import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = mkdtempSync(join(tmpdir(), 'vyotiq-taskwt-ud-'))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => join(tmpdir(), 'vyotiq-taskwt-app'),
    isPackaged: false
  }
}))

import {
  createTaskWorktree,
  discardTaskWorktree,
  findTaskWorktree,
  mergeTaskWorktree,
  taskWorktreeInfo,
  taskWorktreeSlug
} from '@main/git/taskWorktrees'

const repos: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

/** A repository on `main` with one commit of a.txt. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vyotiq-taskwt-repo-'))
  repos.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(dir, 'a.txt'), 'a0\n', 'utf8')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'first')
  return dir
}

let parent: string

beforeEach(() => {
  parent = repo()
})

afterAll(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

describe('taskWorktreeSlug', () => {
  it('names the branch from the brief’s first words', () => {
    expect(taskWorktreeSlug('Fix the updater EBUSY on Windows\n\nmore detail')).toBe('fix-the-updater-ebusy-on-windows')
    expect(taskWorktreeSlug('\n\n  Café — résumé!  ')).toBe('cafe-resume')
    expect(taskWorktreeSlug('')).toBe('task')
    expect(taskWorktreeSlug('***')).toBe('task')
    expect(taskWorktreeSlug('instance')).toBe('instance-task')
    expect(taskWorktreeSlug('a '.repeat(60)).length).toBeLessThanOrEqual(40)
  })
})

describe('task worktrees', () => {
  it('branches the current branch into a folder of its own, outside the project', async () => {
    const wt = await createTaskWorktree(parent, 'Add backpressure to the chat stream')
    expect(wt.branch).toBe('vyotiq/add-backpressure-to-the-chat-stream')
    expect(wt.baseBranch).toBe('main')
    expect(wt.workspacePath.startsWith(userData) || wt.workspacePath.toLowerCase().startsWith(userData.toLowerCase())).toBe(true)
    expect(readFileSync(join(wt.workspacePath, 'a.txt'), 'utf8')).toBe('a0\n')
    expect(git(wt.workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(wt.branch)
    // The parent is untouched and still on main.
    expect(git(parent, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main')
    expect(await findTaskWorktree(wt.workspacePath)).toMatchObject({ branch: wt.branch })

    // A second task with the same words gets the next name.
    const again = await createTaskWorktree(parent, 'Add backpressure to the chat stream')
    expect(again.branch).toBe('vyotiq/add-backpressure-to-the-chat-stream-2')
  })

  it('starts from the last commit: uncommitted files stay in the parent', async () => {
    writeFileSync(join(parent, 'a.txt'), 'mine, uncommitted\n', 'utf8')
    const wt = await createTaskWorktree(parent, 'change a')
    expect(readFileSync(join(wt.workspacePath, 'a.txt'), 'utf8')).toBe('a0\n')
    expect(readFileSync(join(parent, 'a.txt'), 'utf8')).toBe('mine, uncommitted\n')
  })

  it('opens a subfolder workspace at the same subfolder in the worktree', async () => {
    mkdirSync(join(parent, 'pkg'))
    writeFileSync(join(parent, 'pkg', 'b.txt'), 'b\n', 'utf8')
    git(parent, 'add', '-A')
    git(parent, 'commit', '-q', '-m', 'pkg')
    const wt = await createTaskWorktree(join(parent, 'pkg'), 'sub task')
    expect(wt.workspacePath).not.toBe(wt.worktreeRoot)
    expect(readFileSync(join(wt.workspacePath, 'b.txt'), 'utf8')).toBe('b\n')
  })

  it('refuses a detached HEAD and a repository with no commits', async () => {
    git(parent, 'checkout', '-q', '--detach')
    await expect(createTaskWorktree(parent, 'x')).rejects.toThrow('Check out a branch first')
    const empty = mkdtempSync(join(tmpdir(), 'vyotiq-taskwt-empty-'))
    repos.push(empty)
    git(empty, 'init', '-q', '-b', 'main')
    git(empty, 'config', 'core.autocrlf', 'false')
    await expect(createTaskWorktree(empty, 'x')).rejects.toThrow('no commits yet')
  })

  it('merges back: commits what is left, then brings the branch into main', async () => {
    const wt = await createTaskWorktree(parent, 'edit a')
    writeFileSync(join(wt.workspacePath, 'a.txt'), 'a1\n', 'utf8')
    writeFileSync(join(wt.workspacePath, 'c.txt'), 'c1\n', 'utf8')
    expect(await taskWorktreeInfo(wt.workspacePath)).toMatchObject({ ahead: 0, uncommitted: 2, parentExists: true })

    const result = await mergeTaskWorktree(wt.workspacePath, 'Edit a and add c')
    expect(result).toEqual({ merged: true, commits: 1, committedFirst: true })
    expect(readFileSync(join(parent, 'a.txt'), 'utf8')).toBe('a1\n')
    expect(readFileSync(join(parent, 'c.txt'), 'utf8')).toBe('c1\n')
    expect(git(parent, 'log', '-1', '--format=%s').trim()).toBe('Edit a and add c')
    const info = await taskWorktreeInfo(wt.workspacePath)
    expect(info).toMatchObject({ ahead: 0, uncommitted: 0 })
    expect(info?.mergedAt).toBeTruthy()
    // Nothing left to merge.
    await expect(mergeTaskWorktree(wt.workspacePath, 'again')).rejects.toThrow('Nothing to merge')
  })

  it('a conflicting merge is aborted, leaving the parent exactly as it was', async () => {
    const wt = await createTaskWorktree(parent, 'edit a')
    writeFileSync(join(wt.workspacePath, 'a.txt'), 'theirs\n', 'utf8')
    writeFileSync(join(parent, 'a.txt'), 'ours\n', 'utf8')
    git(parent, 'commit', '-q', '-am', 'ours')
    const head = git(parent, 'rev-parse', 'HEAD').trim()

    expect(await mergeTaskWorktree(wt.workspacePath, 'theirs')).toEqual({ merged: false, conflicts: ['a.txt'] })
    expect(git(parent, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(readFileSync(join(parent, 'a.txt'), 'utf8')).toBe('ours\n')
    expect(git(parent, 'status', '--porcelain').trim()).toBe('')
    expect(existsSync(join(parent, '.git', 'MERGE_HEAD'))).toBe(false)
  })

  it('will not merge into another branch than the one it came from', async () => {
    const wt = await createTaskWorktree(parent, 'edit a')
    writeFileSync(join(wt.workspacePath, 'a.txt'), 'a1\n', 'utf8')
    git(parent, 'checkout', '-q', '-b', 'other')
    await expect(mergeTaskWorktree(wt.workspacePath, 'm')).rejects.toThrow('is on other now — check out main there')
    expect(readFileSync(join(parent, 'a.txt'), 'utf8')).toBe('a0\n')
  })

  it('discard deletes the folder and the branch, and forgets it', async () => {
    const wt = await createTaskWorktree(parent, 'throwaway')
    writeFileSync(join(wt.workspacePath, 'a.txt'), 'gone\n', 'utf8')
    await discardTaskWorktree(wt.workspacePath)
    expect(existsSync(wt.worktreeRoot)).toBe(false)
    expect(git(parent, 'branch', '--list', wt.branch).trim()).toBe('')
    expect(git(parent, 'worktree', 'list').includes('throwaway')).toBe(false)
    expect(await findTaskWorktree(wt.workspacePath)).toBeNull()
    expect(readFileSync(join(parent, 'a.txt'), 'utf8')).toBe('a0\n')
    // Only worktrees made here can be deleted.
    await expect(discardTaskWorktree(parent)).rejects.toThrow('not a task worktree')
  })
})
