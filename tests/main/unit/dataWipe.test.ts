import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = mkdtempSync(join(tmpdir(), 'vy-datawipe-'))
const repo = mkdtempSync(join(tmpdir(), 'vy-datawipe-repo-'))
mkdirSync(join(repo, '.git'))
const relaunch = vi.fn()
const quit = vi.fn()

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => '/tmp/vyotiq-app',
    isPackaged: false,
    relaunch: () => relaunch(),
    quit: () => quit()
  }
}))

const dirtyRoots = new Set<string>()
vi.mock('@main/git/git', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/git/git')>()),
  listNonNoiseDirtyPaths: vi.fn(async (cwd: string) => (dirtyRoots.has(cwd) ? ['src/a.ts'] : [])),
  runGit: vi.fn(async () => '')
}))
vi.mock('@main/git/taskWorktrees', () => ({
  listTaskWorktrees: vi.fn(async () => [
    { workspacePath: join(userData, 'task-worktrees', 'w', 'one'), worktreeRoot: join(userData, 'task-worktrees', 'w', 'one'), parentPath: repo, branch: 'vyotiq/one', baseBranch: 'main', createdAt: '' },
    { workspacePath: join(userData, 'task-worktrees', 'w', 'two'), worktreeRoot: join(userData, 'task-worktrees', 'w', 'two'), parentPath: repo, branch: 'vyotiq/two', baseBranch: 'main', createdAt: '' },
    // Registered but already gone from disk: not counted.
    { workspacePath: join(userData, 'gone'), worktreeRoot: join(userData, 'gone'), parentPath: repo, branch: 'vyotiq/gone', baseBranch: 'main', createdAt: '' }
  ])
}))
vi.mock('@main/workspace/workspaces', () => ({
  getHomeWorkspacePath: () => join(userData, 'home'),
  getWorkspaces: () => ({ openPaths: [], recentPaths: [] })
}))
vi.mock('@main/agent/runRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/agent/runRegistry')>()),
  listActiveRuns: () => [{ runId: 'live' }]
}))

import { previewDataWipe, pruneWorktreesAfterWipe, resetDataWipeTokenForTests, runDataWipe } from '@main/storage/dataWipe'
import { readWipeRequest } from '@main/storage/wipeUserData'
import { runGit } from '@main/git/git'

afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

beforeEach(() => {
  resetDataWipeTokenForTests()
  relaunch.mockReset()
  quit.mockReset()
})

function seed(): void {
  for (const run of ['r1', 'r2', 'r3']) mkdirSync(join(userData, 'workspaces', 'ws-a', 'sessions', run), { recursive: true })
  mkdirSync(join(userData, 'workspaces', 'ws-b', 'sessions', 'r4'), { recursive: true })
  mkdirSync(join(userData, 'workspaces', 'ws-c'), { recursive: true })
  mkdirSync(join(userData, 'home'), { recursive: true })
  writeFileSync(join(userData, 'home', 'notes.md'), 'hello')
  writeFileSync(join(userData, 'settings.json'), '{"a":1}')
  for (const name of ['one', 'two']) mkdirSync(join(userData, 'task-worktrees', 'w', name), { recursive: true })
  dirtyRoots.add(join(userData, 'task-worktrees', 'w', 'two'))
}

describe('delete all my data: preview and confirm', () => {
  it('measures what goes: tasks across workspaces, running tasks, worktrees on disk and which hold uncommitted work, Home files', async () => {
    seed()
    const preview = await previewDataWipe()
    expect(preview).toMatchObject({
      dataPath: userData,
      tasks: 4,
      runningTasks: 1,
      taskWorktrees: 2,
      uncommittedWorktrees: 1,
      homeFiles: 1
    })
    expect(preview.totalBytes).toBe('hello'.length + '{"a":1}'.length)
  })

  it('the run needs the preview’s token, once, within ten minutes', async () => {
    seed()
    await expect(runDataWipe('made-up')).rejects.toThrow(/expired/)
    const { confirm } = await previewDataWipe(1_000)
    await expect(runDataWipe(confirm.token, 1_000 + 10 * 60 * 1000 + 1)).rejects.toThrow(/expired/)

    const fresh = await previewDataWipe(5_000)
    await runDataWipe(fresh.confirm.token, 5_000)
    const request = readWipeRequest(userData)!
    expect(request.pid).toBe(process.pid)
    expect(request.repos).toEqual([repo])
    // Relaunch and quit follow the reply.
    await vi.waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1))
    expect(quit).toHaveBeenCalledTimes(1)
    // Spent.
    await expect(runDataWipe(fresh.confirm.token, 5_000)).rejects.toThrow(/expired/)
  })

  it('prunes git’s worktree entries in repositories that still exist', async () => {
    vi.mocked(runGit).mockClear()
    await pruneWorktreesAfterWipe([repo, join(repo, 'missing')])
    expect(runGit).toHaveBeenCalledTimes(1)
    expect(runGit).toHaveBeenCalledWith(['worktree', 'prune'], repo, 30_000)
  })
})
