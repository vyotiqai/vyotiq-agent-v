import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { canGit } from '../../helpers/canGit'

const userData = join(tmpdir(), `vyotiq-wt-ud-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => '/tmp/vyotiq-app',
    isPackaged: false
  }
}))

import {
  addInstanceWorktree,
  gitShowToFile,
  instanceWorktreePath,
  isInstanceWorktreeDir,
  mergeInstanceBranch,
  removeInstanceWorktree,
  resetInstanceWorktreeCleanupForTests
} from '@main/git/instanceWorktree'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
}

describe('isInstanceWorktreeDir', () => {
  it('detects instance-worktrees path segments', () => {
    expect(isInstanceWorktreeDir(join('C:', 'workspaces', 'abc', 'instance-worktrees', 'run-1'))).toBe(
      true
    )
    expect(isInstanceWorktreeDir(join('C:', 'Documents', 'project'))).toBe(false)
  })
})

describe.skipIf(!canGit)('instanceWorktree concurrent add', () => {
  let repo = ''
  let worktreePaths: string[] = []

  afterEach(async () => {
    for (const wt of worktreePaths) {
      if (repo) await removeInstanceWorktree(repo, wt)
    }
    worktreePaths = []
    if (repo && existsSync(repo)) {
      rmSync(repo, { recursive: true, force: true })
    }
    if (existsSync(userData)) {
      rmSync(userData, { recursive: true, force: true })
    }
    resetInstanceWorktreeCleanupForTests()
  })

  it('adds two worktrees on one repo without index.lock', async () => {
    repo = mkdtempSync(join(tmpdir(), 'vyotiq-wt-repo-'))
    git(repo, 'init', '--initial-branch=main')
    writeFileSync(join(repo, 'README.md'), 'base\n', 'utf8')
    git(repo, 'add', 'README.md')
    git(
      repo,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'commit',
      '-m',
      'init'
    )

    const runIdA = `run-a-${process.pid}`
    const runIdB = `run-b-${process.pid}`
    worktreePaths = [instanceWorktreePath(repo, runIdA), instanceWorktreePath(repo, runIdB)]
    const [a, b] = await Promise.all([
      addInstanceWorktree(repo, runIdA),
      addInstanceWorktree(repo, runIdB)
    ])

    if (!a.ok) expect(a.error).not.toMatch(/index\.lock/i)
    if (!b.ok) expect(b.error).not.toMatch(/index\.lock/i)
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (!a.ok || !b.ok) return

    expect(existsSync(a.worktreePath)).toBe(true)
    expect(existsSync(b.worktreePath)).toBe(true)
    expect(a.worktreePath).not.toBe(b.worktreePath)
  }, 30_000)
})

describe.skipIf(!canGit)('instanceWorktree merge gate', () => {
  let repo = ''

  afterEach(() => {
    if (repo && existsSync(repo)) {
      rmSync(repo, { recursive: true, force: true })
    }
    repo = ''
    if (existsSync(userData)) {
      rmSync(userData, { recursive: true, force: true })
    }
    resetInstanceWorktreeCleanupForTests()
  })

  function initRepo(): void {
    repo = mkdtempSync(join(tmpdir(), 'vyotiq-wt-merge-'))
    git(repo, 'init', '--initial-branch=main')
    writeFileSync(join(repo, 'README.md'), 'base\n', 'utf8')
    git(repo, 'add', 'README.md')
    git(
      repo,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'commit',
      '-m',
      'init'
    )
  }

  function addBranch(name: string): void {
    git(repo, 'branch', name, 'main')
    git(
      repo,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'commit',
      '--allow-empty',
      '-m',
      `${name} seed`
    )
    git(repo, 'branch', '--force', name, 'HEAD')
  }

  it('allows merging when the parent tree has only untracked files', async () => {
    initRepo()
    const branch = `vyotiq/instance/run-a-${process.pid}`
    addBranch(branch)
    writeFileSync(join(repo, 'scratch.txt'), 'untracked\n', 'utf8')

    const result = await mergeInstanceBranch(repo, branch)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.detail).toContain(branch)
  }, 30_000)

  it('refuses merging when the parent has a tracked modification', async () => {
    initRepo()
    const branch = `vyotiq/instance/run-b-${process.pid}`
    addBranch(branch)
    writeFileSync(join(repo, 'README.md'), 'modified\n', 'utf8')

    const result = await mergeInstanceBranch(repo, branch)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/uncommitted tracked changes.*README\.md/s)
  }, 30_000)

  it('refuses merging when the parent has a staged addition', async () => {
    initRepo()
    const branch = `vyotiq/instance/run-c-${process.pid}`
    addBranch(branch)
    writeFileSync(join(repo, 'staged.ts'), 'export const s = 1\n', 'utf8')
    git(repo, 'add', 'staged.ts')

    const result = await mergeInstanceBranch(repo, branch)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/uncommitted tracked changes.*staged\.ts/s)
  }, 30_000)

  it('allows merging a clean parent tree', async () => {
    initRepo()
    const branch = `vyotiq/instance/run-d-${process.pid}`
    addBranch(branch)

    const result = await mergeInstanceBranch(repo, branch)
    expect(result.ok).toBe(true)
  }, 30_000)

  it('reports pre-merge head and every applied change after a merge', async () => {
    initRepo()
    writeFileSync(join(repo, 'del.txt'), 'gone\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'seed')

    const branch = `vyotiq/instance/run-changes-${process.pid}`
    git(repo, 'checkout', '-b', branch)
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(join(repo, 'src', 'new.ts'), 'export const n = 1\n', 'utf8')
    writeFileSync(join(repo, 'README.md'), 'instance edit\n', 'utf8')
    rmSync(join(repo, 'del.txt'))
    git(repo, 'add', '-A')
    git(repo, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'work')
    git(repo, 'checkout', 'main')

    const result = await mergeInstanceBranch(repo, branch)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.preMergeHead).toMatch(/^[0-9a-f]{40,64}$/)
    expect(result.changedFiles).toEqual(
      expect.arrayContaining([
        { path: 'src/new.ts', action: 'created' },
        { path: 'README.md', action: 'modified' },
        { path: 'del.txt', action: 'deleted' }
      ])
    )

    const prior = await gitShowToFile(repo, result.preMergeHead, 'README.md')
    expect(prior).not.toBeNull()
    if (prior) expect(readFileSync(prior, 'utf8')).toBe('base\n')
    expect(await gitShowToFile(repo, result.preMergeHead, 'src/new.ts')).toBeNull()
  }, 30_000)
})

describe.skipIf(!canGit)('instanceWorktree locked remove', () => {
  let repo = ''
  let worktreePath = ''

  afterEach(async () => {
    if (repo && worktreePath) await removeInstanceWorktree(repo, worktreePath)
    worktreePath = ''
    if (repo && existsSync(repo)) {
      rmSync(repo, { recursive: true, force: true })
    }
    if (existsSync(userData)) {
      rmSync(userData, { recursive: true, force: true })
    }
    resetInstanceWorktreeCleanupForTests()
  })

  it('removes a git-locked instance worktree left after a crash', async () => {
    repo = mkdtempSync(join(tmpdir(), 'vyotiq-wt-lock-'))
    git(repo, 'init', '--initial-branch=main')
    writeFileSync(join(repo, 'README.md'), 'base\n', 'utf8')
    git(repo, 'add', 'README.md')
    git(
      repo,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'commit',
      '-m',
      'init'
    )

    const runId = `run-lock-${process.pid}`
    const added = await addInstanceWorktree(repo, runId)
    expect(added.ok).toBe(true)
    if (!added.ok) return
    worktreePath = added.worktreePath
    git(repo, 'worktree', 'lock', worktreePath)

    await removeInstanceWorktree(repo, worktreePath)
    expect(existsSync(worktreePath)).toBe(false)
    worktreePath = ''
  }, 30_000)
})

describe.skipIf(!canGit)('instanceWorktree sparse path_scope', () => {
  let repo = ''
  let worktreePath = ''

  afterEach(async () => {
    if (repo && worktreePath) await removeInstanceWorktree(repo, worktreePath)
    worktreePath = ''
    if (repo && existsSync(repo)) {
      rmSync(repo, { recursive: true, force: true })
    }
    if (existsSync(userData)) {
      rmSync(userData, { recursive: true, force: true })
    }
    resetInstanceWorktreeCleanupForTests()
  })

  it('materializes only path_scope cones', async () => {
    repo = mkdtempSync(join(tmpdir(), 'vyotiq-wt-sparse-'))
    git(repo, 'init', '--initial-branch=main')
    mkdirSync(join(repo, 'src'), { recursive: true })
    mkdirSync(join(repo, 'extra'), { recursive: true })
    writeFileSync(join(repo, 'src', 'app.ts'), 'export const n = 1\n', 'utf8')
    writeFileSync(join(repo, 'extra', 'skip.ts'), 'export const s = 1\n', 'utf8')
    git(repo, 'add', '.')
    git(
      repo,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'commit',
      '-m',
      'init'
    )

    const runId = `run-sparse-${process.pid}`
    const added = await addInstanceWorktree(repo, runId, ['src'])
    expect(added.ok).toBe(true)
    if (!added.ok) return
    worktreePath = added.worktreePath
    expect(existsSync(join(worktreePath, 'src', 'app.ts'))).toBe(true)
    expect(existsSync(join(worktreePath, 'extra', 'skip.ts'))).toBe(false)
  }, 30_000)
})
