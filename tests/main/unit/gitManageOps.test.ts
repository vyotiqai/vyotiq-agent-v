import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  applyAnyStash,
  deleteLocalBranch,
  dropAnyStash,
  integrateCommit,
  listAllStashes,
  listLocalBranches,
  renameLocalBranch
} from '@main/git/git'
import { canGit } from '../../helpers/canGit'

/** Real git in temporary repositories: the branch, stash and commit operations the app offers. */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

let root = ''
let seq = 0

function repo(): string {
  const dir = join(root, `case-${++seq}`)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '--initial-branch=main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'first')
  return dir
}

const run = describe.skipIf(!canGit)

run('git branch, stash and commit operations', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'vyotiq-gitops-'))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('renames a branch, deletes a merged one, and asks before an unmerged one', async () => {
    const dir = repo()
    git(dir, 'branch', 'feature')
    expect((await renameLocalBranch(dir, 'feature', 'feature-2')).detail).toBe('Renamed feature to feature-2')
    expect((await listLocalBranches(dir)).map((b) => b.name)).toEqual(['main', 'feature-2'])
    expect(await deleteLocalBranch(dir, 'feature-2')).toEqual({ detail: 'Deleted feature-2' })

    git(dir, 'checkout', '-b', 'wip')
    writeFileSync(join(dir, 'b.txt'), 'b\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-m', 'wip')
    git(dir, 'checkout', 'main')
    const refused = await deleteLocalBranch(dir, 'wip')
    expect(refused.unmerged).toBe(true)
    expect((await deleteLocalBranch(dir, 'wip', { force: true })).detail).toBe('Deleted wip')
    await expect(deleteLocalBranch(dir, 'main')).rejects.toThrow(/Switch to another branch/)
  })

  it('lists, applies, pops and drops any stash', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    git(dir, 'stash', 'push', '-m', 'try two')
    const [stash] = await listAllStashes(dir)
    expect(stash).toMatchObject({ message: 'try two', branch: 'main', files: 1 })
    const applied = await applyAnyStash(dir, stash!.sha)
    expect(applied).toEqual({ detail: 'Applied the stash; it is kept', conflicted: false })
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('two\n')
    git(dir, 'checkout', '--', 'a.txt')
    expect((await applyAnyStash(dir, stash!.sha, { drop: true })).detail).toBe('Applied the stash and dropped it')
    expect(await listAllStashes(dir)).toEqual([])
    git(dir, 'stash', 'push', '-m', 'again')
    const [again] = await listAllStashes(dir)
    expect((await dropAnyStash(dir, again!.sha)).detail).toBe('Dropped the stash')
  })

  it('reverts a commit, and merges a branch in', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'changed\n')
    git(dir, 'commit', '-am', 'change')
    const sha = git(dir, 'rev-parse', 'HEAD').trim()
    expect((await integrateCommit(dir, 'revert', sha)).conflicted).toBe(false)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\n')

    git(dir, 'checkout', '-b', 'side')
    writeFileSync(join(dir, 'c.txt'), 'c\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-m', 'side')
    git(dir, 'checkout', 'main')
    expect(await integrateCommit(dir, 'merge', 'side')).toEqual({ detail: 'Merged side', conflicted: false })
    expect(readFileSync(join(dir, 'c.txt'), 'utf8')).toBe('c\n')
  })

  it('reports a conflict as an answer, not a failure', async () => {
    const dir = repo()
    git(dir, 'checkout', '-b', 'other')
    writeFileSync(join(dir, 'a.txt'), 'theirs\n')
    git(dir, 'commit', '-am', 'theirs')
    git(dir, 'checkout', 'main')
    writeFileSync(join(dir, 'a.txt'), 'ours\n')
    git(dir, 'commit', '-am', 'ours')
    const result = await integrateCommit(dir, 'merge', 'other')
    expect(result.conflicted).toBe(true)
    expect(result.detail).toMatch(/conflicts to resolve/)
  })

  it('refuses to start with uncommitted changes', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'dirty\n')
    await expect(integrateCommit(dir, 'merge', 'main')).rejects.toThrow(/Commit or stash your changes first/)
  })
})
