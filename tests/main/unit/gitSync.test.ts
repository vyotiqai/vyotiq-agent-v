import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createGitBranch,
  describeGitSyncError,
  fetchRemotes,
  pullCurrentBranch,
  pushBranch,
  readGitStatus
} from '@main/git/git'
import { branchNameProblem } from '@shared/utils/gitBranch'
import { canGit } from '../../helpers/canGit'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function configure(repo: string): void {
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'commit.gpgsign', 'false')
  // A machine-wide autocrlf would hand back "text\r\n" from checkouts.
  git(repo, 'config', 'core.autocrlf', 'false')
}

function commitFile(repo: string, file: string, text: string, message: string): void {
  writeFileSync(join(repo, file), text, 'utf8')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', message)
}

const head = (repo: string): string => git(repo, 'rev-parse', 'HEAD').trim()

// One root of our own under the OS temp dir; only it is ever removed.
let root = ''
let seq = 0

/** A bare remote, a clone of it ("repo") that tracks origin/main, and a second clone ("twin"). */
function setup(): { repo: string; bare: string; twin: string } {
  const dir = join(root, `case-${++seq}`)
  const bare = join(dir, 'remote.git')
  const repo = join(dir, 'repo')
  const twin = join(dir, 'twin')
  mkdirSync(bare, { recursive: true })
  mkdirSync(repo)
  git(bare, 'init', '--bare', '--initial-branch=main')
  git(repo, 'init', '--initial-branch=main')
  configure(repo)
  commitFile(repo, 'base.txt', 'base\n', 'first')
  git(repo, 'remote', 'add', 'origin', bare)
  git(repo, 'push', '-u', 'origin', 'main')
  git(dir, 'clone', bare, 'twin')
  configure(twin)
  return { repo, bare, twin }
}

describe('branchNameProblem', () => {
  it('accepts names git accepts and words what it refuses', () => {
    for (const ok of ['feature', 'feat/login-form', 'fix_1.2', 'user/a.b']) {
      expect(branchNameProblem(ok)).toBeNull()
    }
    for (const bad of ['', ' ', '-x', 'HEAD', 'a b', 'a..b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', 'feat/', '/feat', 'a//b', 'a.', '.a', 'a/.b', 'x.lock', 'a@{1}']) {
      expect(branchNameProblem(bad), bad).toEqual(expect.any(String))
    }
  })
})

describe('describeGitSyncError', () => {
  it('names a timeout, a sign-in failure and a rejected push', () => {
    expect(describeGitSyncError('fetch', { killed: true, signal: 'SIGTERM' }, 120_000)).toMatch(/no answer in 120s/)
    const auth = Object.assign(new Error('Command failed: git fetch'), {
      stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n"
    })
    expect(describeGitSyncError('fetch', auth)).toMatch(/could not sign in.*terminal prompts disabled/i)
    const rejected = Object.assign(new Error('Command failed: git push'), {
      stderr: ' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs\nhint: Updates were rejected\n'
    })
    const said = describeGitSyncError('push', rejected)
    expect(said).toMatch(/Pull, then push again/)
    expect(said).not.toMatch(/hint:/)
  })
})

// Each case spawns dozens of git processes (~250ms apiece on Windows), so the
// default 30s is tight when the suite runs under load.
describe.skipIf(!canGit)('git sync against a real bare remote', { timeout: 90_000 }, () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'vyotiq-gitsync-test-'))
  })
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('reports the upstream in status, and none for an unpublished branch', async () => {
    const { repo } = setup()
    const status = await readGitStatus(repo)
    expect(status.kind === 'ok' && status.status.upstream).toBe('origin/main')
    git(repo, 'switch', '-c', 'local-only')
    const local = await readGitStatus(repo)
    expect(local.kind === 'ok' && local.status.upstream).toBeUndefined()
  })

  it('fetches what another clone pushed, without touching the working tree', async () => {
    const { repo, twin } = setup()
    commitFile(twin, 'remote.txt', 'remote\n', 'remote commit')
    git(twin, 'push', 'origin', 'main')
    const before = head(repo)

    const fetched = await fetchRemotes(repo)
    expect(fetched).toMatchObject({ ahead: 0, behind: 1 })
    expect(fetched.detail).toMatch(/1 new commit on origin\/main/)
    expect(head(repo)).toBe(before)
    expect(existsSync(join(repo, 'remote.txt'))).toBe(false)
  })

  it('refuses to fetch with no remote', async () => {
    const dir = join(root, 'no-remote')
    mkdirSync(dir)
    git(dir, 'init', '--initial-branch=main')
    configure(dir)
    commitFile(dir, 'a.txt', 'a\n', 'a')
    await expect(fetchRemotes(dir)).rejects.toThrow(/no git remote/i)
  })

  it('says plainly when the remote cannot be reached', async () => {
    const { repo } = setup()
    git(repo, 'remote', 'set-url', 'origin', join(root, 'does-not-exist.git'))
    await expect(fetchRemotes(repo)).rejects.toThrow(/could not be reached|not found/i)
  })

  it('fast-forwards a pull', async () => {
    const { repo, twin } = setup()
    commitFile(twin, 'remote.txt', 'remote\n', 'remote commit')
    git(twin, 'push', 'origin', 'main')

    const pulled = await pullCurrentBranch(repo)
    expect(pulled).toEqual({ kind: 'pulled', detail: 'Pulled 1 commit from origin/main' })
    expect(readFileSync(join(repo, 'remote.txt'), 'utf8')).toBe('remote\n')
    expect(head(repo)).toBe(head(twin))
    await expect(pullCurrentBranch(repo)).resolves.toEqual({ kind: 'up-to-date', detail: 'Already up to date' })
  })

  it('returns diverged without changing anything, then rebases when asked', async () => {
    const { repo, twin } = setup()
    commitFile(twin, 'remote.txt', 'remote\n', 'remote commit')
    git(twin, 'push', 'origin', 'main')
    commitFile(repo, 'local.txt', 'local\n', 'local commit')
    const before = head(repo)

    const first = await pullCurrentBranch(repo)
    expect(first).toMatchObject({ kind: 'diverged', ahead: 1, behind: 1, upstream: 'origin/main' })
    expect(head(repo)).toBe(before)
    expect(existsSync(join(repo, 'remote.txt'))).toBe(false)

    const rebased = await pullCurrentBranch(repo, 'rebase')
    expect(rebased.kind).toBe('pulled')
    // Linear: the local commit now sits on top of the remote one.
    expect(git(repo, 'rev-parse', 'HEAD~1').trim()).toBe(head(twin))
    expect(git(repo, 'rev-list', '--merges', '--count', 'HEAD').trim()).toBe('0')
  })

  it('merges when asked, and leaves merge conflicts for the resolver', async () => {
    const { repo, twin } = setup()
    commitFile(twin, 'remote.txt', 'remote\n', 'remote commit')
    git(twin, 'push', 'origin', 'main')
    commitFile(repo, 'local.txt', 'local\n', 'local commit')
    const merged = await pullCurrentBranch(repo, 'merge')
    expect(merged.kind).toBe('pulled')
    expect(git(repo, 'rev-list', '--merges', '--count', 'HEAD').trim()).toBe('1')

    const clash = setup()
    commitFile(clash.twin, 'base.txt', 'theirs\n', 'theirs')
    git(clash.twin, 'push', 'origin', 'main')
    commitFile(clash.repo, 'base.txt', 'ours\n', 'ours')
    const conflicted = await pullCurrentBranch(clash.repo, 'merge')
    expect(conflicted).toMatchObject({ kind: 'conflicted', files: 1 })
    expect(git(clash.repo, 'diff', '--name-only', '--diff-filter=U').trim()).toBe('base.txt')
  })

  it('undoes a rebase that stops on a conflict', async () => {
    const { repo, twin } = setup()
    commitFile(twin, 'base.txt', 'theirs\n', 'theirs')
    git(twin, 'push', 'origin', 'main')
    commitFile(repo, 'base.txt', 'ours\n', 'ours')
    const before = head(repo)
    await expect(pullCurrentBranch(repo, 'rebase')).rejects.toThrow(/undone; nothing changed/)
    expect(head(repo)).toBe(before)
    expect(readFileSync(join(repo, 'base.txt'), 'utf8')).toBe('ours\n')
    expect(() => git(repo, 'rev-parse', '--verify', '--quiet', 'REBASE_HEAD')).toThrow()
  })

  it('refuses to pull a branch with no upstream', async () => {
    const { repo } = setup()
    git(repo, 'switch', '-c', 'unpublished')
    await expect(pullCurrentBranch(repo)).rejects.toThrow(/no upstream yet/)
  })

  it('publishes a branch with no upstream, then pushes to it', async () => {
    const { repo, bare } = setup()
    git(repo, 'switch', '-c', 'feature')
    commitFile(repo, 'feature.txt', 'f\n', 'feature work')

    await expect(pushBranch(repo, { setUpstream: false })).rejects.toThrow(/no upstream/)
    const published = await pushBranch(repo)
    expect(published).toEqual({ detail: 'Published feature to origin/feature', upstream: 'origin/feature', published: true })
    expect(git(bare, 'rev-parse', 'refs/heads/feature').trim()).toBe(head(repo))
    expect(git(repo, 'rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/feature')

    commitFile(repo, 'feature.txt', 'f2\n', 'more')
    const pushed = await pushBranch(repo)
    expect(pushed).toMatchObject({ detail: 'Pushed 1 commit to origin/feature', published: false })
    expect(git(bare, 'rev-parse', 'refs/heads/feature').trim()).toBe(head(repo))
  })

  it('never forces: a push behind the remote is rejected with a way on', async () => {
    const { repo, twin, bare } = setup()
    commitFile(twin, 'remote.txt', 'remote\n', 'remote commit')
    git(twin, 'push', 'origin', 'main')
    commitFile(repo, 'local.txt', 'local\n', 'local commit')
    await expect(pushBranch(repo)).rejects.toThrow(/Pull, then push again/)
    expect(git(bare, 'rev-parse', 'refs/heads/main').trim()).toBe(head(twin))
  })

  it('creates and switches to a valid branch, and refuses bad or taken names', async () => {
    const { repo } = setup()
    await expect(createGitBranch(repo, 'bad name')).rejects.toThrow(/No spaces/)
    await expect(createGitBranch(repo, '-x')).rejects.toThrow(/can’t start with -/)
    await expect(createGitBranch(repo, 'a..b')).rejects.toThrow(/\.\./)
    await expect(createGitBranch(repo, 'x.lock')).rejects.toThrow(/\.lock/)
    await expect(createGitBranch(repo, 'main')).rejects.toThrow(/already exists/)
    await expect(createGitBranch(repo, 'topic', { from: 'no-such-ref' })).rejects.toThrow(/Unknown starting point/)

    await expect(createGitBranch(repo, 'feat/one')).resolves.toEqual({
      branch: 'feat/one',
      detail: 'Created and switched to feat/one'
    })
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('feat/one')

    commitFile(repo, 'one.txt', '1\n', 'on feat/one')
    await createGitBranch(repo, 'from-main', { from: 'main', checkout: false })
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('feat/one')
    expect(git(repo, 'rev-parse', 'from-main').trim()).toBe(git(repo, 'rev-parse', 'main').trim())
  })
})
