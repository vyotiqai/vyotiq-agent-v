import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  addGitRemote,
  checkoutBranch,
  commitAll,
  commitEmpty,
  createBranch,
  currentGitBranch,
  gitRemoteUrl,
  isGitRepo,
  listLocalBranches,
  readGitCommitFiles,
  readGitBlame,
  readGitDiff,
  readGitLog,
  readGitStatus,
  sanitizeRelativePaths,
  stageAll,
  stagePaths,
  unstagePaths
} from '@main/git/git'
import type { GitStatus, GitStatusResult } from '@shared/ipc'
import { canGit } from '../../helpers/canGit'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function expectOk(result: GitStatusResult): GitStatus {
  expect(result.kind).toBe('ok')
  if (result.kind !== 'ok') throw new Error('expected ok')
  return result.status
}

describe('sanitizeRelativePaths', () => {
  it('keeps relative workspace paths and rejects abs/UNC/drive/escapes', () => {
    expect(sanitizeRelativePaths(['src/a.ts', 'docs/readme.md'])).toEqual([
      'src/a.ts',
      'docs/readme.md'
    ])
    expect(
      sanitizeRelativePaths([
        'C:\\Windows\\system.ini',
        'C:/Windows/system.ini',
        '//server/share/secret',
        '\\\\server\\share\\secret',
        '/etc/passwd',
        '../secret',
        'node_modules/pkg/index.js',
        'src/a.ts',
        'src/a.ts'
      ])
    ).toEqual(['src/a.ts'])
  })
})

describe.skipIf(!canGit)('git remote setup', () => {
  it('adds a GitHub remote without replacing a different origin', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'vyotiq-git-remote-'))
    try {
      git(repo, 'init', '--initial-branch=main')
      await addGitRemote(repo, 'https://github.com/example/project')
      await expect(gitRemoteUrl(repo)).resolves.toBe('https://github.com/example/project')
      await expect(
        addGitRemote(repo, 'https://github.com/example/other-project')
      ).rejects.toThrow(/already exists/i)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!canGit)('git empty baseline', () => {
  it('does not consume staged changes while creating an empty baseline commit', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'vyotiq-git-empty-'))
    try {
      git(repo, 'init', '--initial-branch=main')
      git(repo, 'config', 'user.email', 'test@example.com')
      git(repo, 'config', 'user.name', 'Test')
      writeFileSync(join(repo, 'pending.txt'), 'pending\n', 'utf8')
      git(repo, 'add', 'pending.txt')
      await commitEmpty(repo, 'chore: initialize repository')
      const status = expectOk(await readGitStatus(repo))
      expect(status.files.find((file) => file.path === 'pending.txt')).toMatchObject({
        staged: true,
        unstaged: false
      })
      await expect(readGitLog(repo, 1)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ subject: 'chore: initialize repository' })])
      )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!canGit)('git diff without an initial commit', () => {
  it('includes both staged and worktree edits for an uncommitted diff', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'vyotiq-git-no-head-'))
    try {
      git(repo, 'init', '--initial-branch=main')
      git(repo, 'config', 'user.email', 'test@example.com')
      git(repo, 'config', 'user.name', 'Test')
      writeFileSync(join(repo, 'tracked.txt'), 'indexed\n', 'utf8')
      git(repo, 'add', 'tracked.txt')
      writeFileSync(join(repo, 'tracked.txt'), 'indexed\nworktree\n', 'utf8')

      const diff = await readGitDiff(repo, { vsHead: true })

      expect(diff.ok).toBe(true)
      if (!diff.ok) throw new Error('expected ok')
      expect(diff.content).toContain('+indexed')
      expect(diff.content).toContain('+worktree')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!canGit)('isGitRepo ancestor discovery', () => {
  let repo: string
  let plain: string

  beforeAll(() => {
    plain = mkdtempSync(join(tmpdir(), 'vyotiq-plain-'))
    repo = mkdtempSync(join(tmpdir(), 'vyotiq-git-'))
    git(repo, 'init', '--initial-branch=main')
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(plain, { recursive: true, force: true })
  })

  it('matches git ancestor .git discovery from a repo subdirectory', () => {
    const subdir = join(repo, 'src', 'main')
    mkdirSync(subdir, { recursive: true })
    expect(isGitRepo(repo)).toBe(true)
    expect(isGitRepo(subdir)).toBe(true)
  })

  it('treats a .git file (worktree checkout) as a repository', () => {
    const wt = mkdtempSync(join(tmpdir(), 'vyotiq-wtfile-'))
    try {
      writeFileSync(join(wt, '.git'), 'gitdir: ../elsewhere/worktrees/one\n', 'utf8')
      expect(isGitRepo(wt)).toBe(true)
    } finally {
      rmSync(wt, { recursive: true, force: true })
    }
  })

  it('stays false when no ancestor contains .git', () => {
    const subdir = join(plain, 'a', 'b')
    mkdirSync(subdir, { recursive: true })
    expect(isGitRepo(plain)).toBe(false)
    expect(isGitRepo(subdir)).toBe(false)
  })
})

describe.skipIf(!canGit)('git status', () => {
  let repo: string
  let plain: string

  beforeAll(() => {
    plain = mkdtempSync(join(tmpdir(), 'vyotiq-plain-'))

    repo = mkdtempSync(join(tmpdir(), 'vyotiq-git-'))
    git(repo, 'init', '--initial-branch=main')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(repo, 'kept.txt'), 'one\ntwo\nthree\n', 'utf8')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'first')
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(plain, { recursive: true, force: true })
  })

  it('reports not_repo for a directory that is not a repository', async () => {
    expect(isGitRepo(plain)).toBe(false)
    expect(await readGitStatus(plain)).toEqual({ kind: 'not_repo' })
  })

  it('reports a clean repository with its branch', async () => {
    const status = expectOk(await readGitStatus(repo))
    expect(status.branch).toBe('main')
    expect(status.files).toEqual([])
    expect(status.added).toBe(0)
    expect(status.hasCommits).toBe(true)
  })

  it('counts added and removed lines for a tracked edit', async () => {
    writeFileSync(join(repo, 'kept.txt'), 'one\ntwo\nthree\nfour\n', 'utf8')
    const status = expectOk(await readGitStatus(repo))
    const file = status.files.find((entry) => entry.path === 'kept.txt')
    expect(file).toMatchObject({
      status: 'modified',
      added: 1,
      removed: 0,
      addedUnstaged: 1,
      removedUnstaged: 0,
      addedStaged: 0,
      removedStaged: 0,
      staged: false,
      unstaged: true
    })
    expect(status.added).toBe(1)
  })

  it('counts an untracked file as wholly added', async () => {
    mkdirSync(join(repo, 'sub'), { recursive: true })
    writeFileSync(join(repo, 'sub', 'new.txt'), 'a\nb\n', 'utf8')
    const status = expectOk(await readGitStatus(repo))
    const file = status.files.find((entry) => entry.path === 'sub/new.txt')
    expect(file).toMatchObject({
      status: 'untracked',
      added: 2,
      removed: 0,
      addedUnstaged: 2,
      staged: false,
      unstaged: true
    })
  })

  it('returns a full-add unified diff for an untracked file', async () => {
    writeFileSync(join(repo, 'brand-new.txt'), 'hello\nworld\n', 'utf8')
    const diff = await readGitDiff(repo, { path: 'brand-new.txt', staged: false })
    expect(diff.ok).toBe(true)
    if (!diff.ok) throw new Error('expected ok')
    expect(diff.content).not.toMatch(/no unstaged changes/)
    expect(diff.content).toContain('+hello')
    expect(diff.content).toContain('+world')
  })

  it('splits partially staged line deltas per side', async () => {
    writeFileSync(join(repo, 'kept.txt'), 'staged-line\nworktree-line\n', 'utf8')
    git(repo, 'add', 'kept.txt')
    writeFileSync(join(repo, 'kept.txt'), 'staged-line\nworktree-line\nextra\n', 'utf8')
    const status = expectOk(await readGitStatus(repo))
    const file = status.files.find((entry) => entry.path === 'kept.txt')
    expect(file).toMatchObject({
      staged: true,
      unstaged: true
    })
    expect((file?.addedStaged ?? 0) + (file?.removedStaged ?? 0)).toBeGreaterThan(0)
    expect((file?.addedUnstaged ?? 0) + (file?.removedUnstaged ?? 0)).toBeGreaterThan(0)
  })

  it('marks staged-only index changes via porcelain XY', async () => {
    writeFileSync(join(repo, 'kept.txt'), 'staged-only\n', 'utf8')
    git(repo, 'add', 'kept.txt')
    const status = expectOk(await readGitStatus(repo))
    const file = status.files.find((entry) => entry.path === 'kept.txt')
    expect(file).toMatchObject({ staged: true, unstaged: false })
  })

  it('stages and unstages specific paths', async () => {
    writeFileSync(join(repo, 'kept.txt'), 'path-stage\n', 'utf8')
    writeFileSync(join(repo, 'extra2.txt'), 'y\n', 'utf8')
    const staged = await stagePaths(repo, ['kept.txt'])
    expect(staged.staged).toBe(true)
    let status = expectOk(await readGitStatus(repo))
    expect(status.files.find((f) => f.path === 'kept.txt')).toMatchObject({
      staged: true,
      unstaged: false
    })
    expect(status.files.find((f) => f.path === 'extra2.txt')).toMatchObject({
      staged: false,
      unstaged: true
    })
    const unstaged = await unstagePaths(repo, ['kept.txt'])
    expect(unstaged.unstaged).toBe(true)
    status = expectOk(await readGitStatus(repo))
    expect(status.files.find((f) => f.path === 'kept.txt')).toMatchObject({
      staged: false,
      unstaged: true
    })
  })

  it('lists local branches and checks out another', async () => {
    const before = await listLocalBranches(repo)
    expect(before.some((b) => b.name === 'main' && b.current)).toBe(true)
    git(repo, 'branch', 'feature-x')
    await checkoutBranch(repo, 'feature-x')
    const after = await listLocalBranches(repo)
    expect(after.find((b) => b.name === 'feature-x')?.current).toBe(true)
    await checkoutBranch(repo, 'main')
  })

  it('creates a topic branch without discarding the working tree', async () => {
    writeFileSync(join(repo, 'topic.txt'), 'topic\n', 'utf8')
    expect(await currentGitBranch(repo)).toBe('main')
    await createBranch(repo, 'vyotiq/pr-test')
    expect(await currentGitBranch(repo)).toBe('vyotiq/pr-test')
    expect(readFileSync(join(repo, 'topic.txt'), 'utf8')).toBe('topic\n')
    await checkoutBranch(repo, 'main')
  })

  it('stages all unstaged changes without committing', async () => {
    writeFileSync(join(repo, 'kept.txt'), 'to-stage\n', 'utf8')
    writeFileSync(join(repo, 'extra.txt'), 'x\n', 'utf8')
    const staged = await stageAll(repo)
    expect(staged.staged).toBe(true)
    const status = expectOk(await readGitStatus(repo))
    expect(status.files.every((f) => f.staged && !f.unstaged)).toBe(true)
  })

  it('commits staged content only when mode is staged', async () => {
    writeFileSync(join(repo, 'kept.txt'), 'index-version\n', 'utf8')
    git(repo, 'add', 'kept.txt')
    writeFileSync(join(repo, 'kept.txt'), 'index-version\nworktree-extra\n', 'utf8')
    const result = await commitAll(repo, 'staged-only', false, 'staged')
    expect(result.committed).toBe(true)
    const status = expectOk(await readGitStatus(repo))
    const file = status.files.find((entry) => entry.path === 'kept.txt')
    expect(file).toMatchObject({ staged: false, unstaged: true })
  })

  it('commits everything and reports what it did', async () => {
    const result = await commitAll(repo, 'second', false, 'all')
    expect(result).toMatchObject({ committed: true, pushed: false })

    const status = expectOk(await readGitStatus(repo))
    expect(status.files).toEqual([])
  })

  it('refuses to invent a commit when nothing changed', async () => {
    const result = await commitAll(repo, 'empty', false)
    expect(result.committed).toBe(false)
    expect(result.detail).toBe('Nothing to commit')
  })

  it('reports that a push had nowhere to go rather than failing', async () => {
    writeFileSync(join(repo, 'kept.txt'), 'one\n', 'utf8')
    const result = await commitAll(repo, 'third', true)
    expect(result).toMatchObject({ committed: true, pushed: false })
    expect(result.detail).toContain('No remote')
  })

  it('counts a deleted tracked file', async () => {
    writeFileSync(join(repo, 'doomed.txt'), 'bye\n', 'utf8')
    git(repo, 'add', 'doomed.txt')
    git(repo, 'commit', '-m', 'add doomed')
    rmSync(join(repo, 'doomed.txt'))
    const status = expectOk(await readGitStatus(repo))
    const file = status.files.find((entry) => entry.path === 'doomed.txt')
    expect(file).toMatchObject({ status: 'deleted', unstaged: true })
  })

  it('reports null branch for detached HEAD', async () => {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8'
    }).trim()
    git(repo, 'checkout', '--detach', sha)
    try {
      const status = expectOk(await readGitStatus(repo))
      expect(status.branch).toBeNull()
    } finally {
      git(repo, 'checkout', 'main')
    }
  })

  it('rejects option-like sha values before invoking git show', async () => {
    const diff = await readGitDiff(repo, { sha: '--output=/tmp/pwned' })
    expect(diff.ok).toBe(false)
    if (diff.ok) throw new Error('expected fail')
    expect(diff.error).toMatch(/invalid commit/i)
  })

  it('lists commit files and the patch introduced by that commit', async () => {
    writeFileSync(join(repo, 'commit-panel.txt'), 'alpha\n', 'utf8')
    git(repo, 'add', 'commit-panel.txt')
    git(repo, 'commit', '-m', 'show in panel')
    const log = await readGitLog(repo, 5)
    expect(log[0]?.subject).toBe('show in panel')
    expect(log[0]?.sha).toMatch(/^[0-9a-f]{7,40}$/i)
    const files = await readGitCommitFiles(repo, log[0]!.sha)
    expect(files.some((file) => file.path === 'commit-panel.txt')).toBe(true)
    const diff = await readGitDiff(repo, { sha: log[0]!.sha, path: 'commit-panel.txt' })
    expect(diff.ok).toBe(true)
    if (!diff.ok) throw new Error('expected ok')
    expect(diff.content).toContain('+alpha')
    expect(diff.content).not.toMatch(/no changes in commit/)
  })

  it('rejects checkout of option-like and unknown branch names', async () => {
    await expect(checkoutBranch(repo, '-f')).rejects.toThrow(/Invalid branch/)
    await expect(checkoutBranch(repo, 'no-such-branch')).rejects.toThrow(/Unknown branch/)
  })
})

describe.skipIf(!canGit)('git push remote selection', () => {
  it('sets upstream to the first remote when origin is absent', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'vyotiq-git-push-'))
    const bare = mkdtempSync(join(tmpdir(), 'vyotiq-git-bare-'))
    try {
      git(bare, 'init', '--bare', '--initial-branch=main')
      git(repo, 'init', '--initial-branch=main')
      git(repo, 'config', 'user.email', 'test@example.com')
      git(repo, 'config', 'user.name', 'Test')
      git(repo, 'config', 'commit.gpgsign', 'false')
      writeFileSync(join(repo, 'kept.txt'), 'one\n', 'utf8')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-m', 'first')
      git(repo, 'remote', 'add', 'upstream', bare)
      writeFileSync(join(repo, 'kept.txt'), 'two\n', 'utf8')
      const result = await commitAll(repo, 'second', true)
      expect(result).toMatchObject({ committed: true, pushed: true })
      const tracking = execFileSync('git', ['rev-parse', '--abbrev-ref', '@{upstream}'], {
        cwd: repo,
        encoding: 'utf8'
      }).trim()
      expect(tracking).toBe('upstream/main')
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(bare, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!canGit)('git blame', () => {
  it('returns bounded line ownership and current working-tree text', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'vyotiq-git-blame-'))
    try {
      git(repo, 'init', '--initial-branch=main')
      git(repo, 'config', 'user.email', 'test@example.com')
      git(repo, 'config', 'user.name', 'Test')
      writeFileSync(join(repo, 'note.ts'), 'one\ntwo\n', 'utf8')
      git(repo, 'add', 'note.ts')
      git(repo, 'commit', '-m', 'initial')
      writeFileSync(join(repo, 'note.ts'), 'one\nchanged\n', 'utf8')

      const result = await readGitBlame(repo, 'note.ts')
      expect(result.kind).toBe('ok')
      if (result.kind !== 'ok') throw new Error('expected blame result')
      expect(result.lines).toHaveLength(2)
      expect(result.lines[1]).toMatchObject({
        line: 2,
        text: 'changed',
        author: 'Not Committed Yet'
      })
      expect(result.lines[0]?.shortSha).toMatch(/^[0-9a-f]{7}$/i)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
