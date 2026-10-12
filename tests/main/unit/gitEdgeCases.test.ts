import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import {
  checkoutBranch,
  discardPaths,
  dropBranchStash,
  readBranchStash,
  readCommitChanges,
  readGitDiff,
  readGitStatus,
  restoreBranchStash,
  stageHunk,
  stagePaths
} from '@main/git/git'
import { backgroundFetch, resetBackgroundFetchForTests } from '@main/git/backgroundFetch'
import { diffFingerprint, hunkIdentity, parseUnifiedHunks } from '@shared/utils/hunkPatch'
import { canGit } from '../../helpers/canGit'

/**
 * Real git, for the cases an audit of the Changes tab's git work found:
 * paths git reads as wildcards, a last hunk ending in a blank line, a
 * post-checkout hook that fails, a restore with a new file in the way,
 * paths reached through a link, and a repository with no commit yet.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// One root of our own under the OS temp dir; only it is ever removed.
let root = ''
let seq = 0

function emptyRepo(): string {
  const repo = join(root, `case-${++seq}`, 'repo')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '--initial-branch=main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'commit.gpgsign', 'false')
  git(repo, 'config', 'core.autocrlf', 'false')
  return repo
}

function repoWith(files: Record<string, string>): string {
  const repo = emptyRepo()
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(repo, rel, '..'), { recursive: true })
    writeFileSync(join(repo, rel), text)
  }
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'first')
  return repo
}

/** A folder standing in for the OS trash, beside the repository. */
function trashFor(repo: string): { trash: (abs: string) => Promise<void>; trashed: () => string[] } {
  const dir = join(repo, '..', 'trash')
  mkdirSync(dir, { recursive: true })
  let n = 0
  return {
    trash: async (abs) => renameSync(abs, join(dir, `${++n}-${basename(abs)}`)),
    trashed: () => readdirSync(dir).sort()
  }
}

const read = (repo: string, rel: string): string => readFileSync(join(repo, rel), 'utf8')
const status = (repo: string): string => git(repo, 'status', '--porcelain=v1', '-uall').trim()

async function shownHunk(repo: string, path: string, index: number, staged = false) {
  const diff = await readGitDiff(repo, { path, staged })
  if (!diff.ok) throw new Error(diff.error)
  const hunks = parseUnifiedHunks(diff.content)
  const hunk = hunks[index]
  if (!hunk) throw new Error(`no hunk ${index}`)
  return { hunk: hunkIdentity(hunk), diffHash: diffFingerprint(diff.content), count: hunks.length }
}

describe.skipIf(!canGit)('git edge cases', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'vyotiq-git-edges-test-'))
  })
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  describe('a path is only that path', () => {
    it('discarding `a[bc].txt` leaves `ab.txt` — which the bracket would match — alone', async () => {
      const repo = repoWith({ 'a[bc].txt': 'one\n', 'ab.txt': 'one\n' })
      writeFileSync(join(repo, 'a[bc].txt'), 'two\n')
      writeFileSync(join(repo, 'ab.txt'), 'two\n')
      const { trash, trashed } = trashFor(repo)
      const result = await discardPaths(repo, ['a[bc].txt'], 'worktree', trash)
      expect(result).toMatchObject({ discarded: ['a[bc].txt'], backedUp: 1 })
      expect(read(repo, 'a[bc].txt')).toBe('one\n')
      expect(read(repo, 'ab.txt')).toBe('two\n')
      expect(trashed()).toEqual(['1-a[bc].txt'])
    })

    it('staging `app/[id].tsx` stages only it, and its diff is only its own', async () => {
      const repo = repoWith({ 'app/[id].tsx': 'one\n', 'app/i.tsx': 'one\n' })
      writeFileSync(join(repo, 'app/[id].tsx'), 'two\n')
      writeFileSync(join(repo, 'app/i.tsx'), 'two\n')
      const diff = await readGitDiff(repo, { path: 'app/[id].tsx' })
      expect(diff.ok && diff.content).not.toMatch(/i\.tsx/)
      await stagePaths(repo, ['app/[id].tsx'])
      expect(status(repo).split('\n').sort()).toEqual(['M  app/[id].tsx', ' M app/i.tsx'].sort())
    })
  })

  describe('discard', () => {
    it('all: a file untracked with `git rm --cached` comes back from HEAD, not into the trash', async () => {
      const repo = repoWith({ 'f.txt': 'kept\n' })
      git(repo, 'rm', '--cached', '-q', 'f.txt')
      expect(status(repo).split('\n').sort()).toEqual(['?? f.txt', 'D  f.txt'])
      const { trash } = trashFor(repo)
      const result = await discardPaths(repo, ['f.txt'], 'all', trash)
      expect(result.discarded).toEqual(['f.txt'])
      expect(read(repo, 'f.txt')).toBe('kept\n')
      expect(status(repo)).toBe('')
    })

    it('all: an added file deleted again (`AD`) is discarded by unstaging it, with no error', async () => {
      const repo = repoWith({ 'f.txt': 'x\n' })
      writeFileSync(join(repo, 'new.txt'), 'new\n')
      git(repo, 'add', 'new.txt')
      rmSync(join(repo, 'new.txt'))
      expect(status(repo)).toBe('AD new.txt')
      const { trash, trashed } = trashFor(repo)
      const result = await discardPaths(repo, ['new.txt'], 'all', trash)
      expect(result.discarded).toEqual(['new.txt'])
      expect(result.detail).not.toMatch(/could not/)
      expect(status(repo)).toBe('')
      expect(trashed()).toEqual([])
    })

    it('works before the first commit: the added file is unstaged and goes to the trash', async () => {
      const repo = emptyRepo()
      writeFileSync(join(repo, 'a.txt'), 'staged\n')
      git(repo, 'add', 'a.txt')
      writeFileSync(join(repo, 'a.txt'), 'edited\n')
      const { trash, trashed } = trashFor(repo)
      const result = await discardPaths(repo, ['a.txt'], 'all', trash)
      expect(result.discarded).toEqual(['a.txt'])
      expect(existsSync(join(repo, 'a.txt'))).toBe(false)
      expect(status(repo)).toBe('')
      expect(trashed()).toEqual(['1-a.txt'])
    })

    it('never trashes the file a link leads to', async () => {
      const repo = repoWith({ 'docs/a.md': 'tracked\n' })
      // A junction on Windows (no admin needed), a symlink elsewhere.
      symlinkSync(join(repo, 'docs'), join(repo, 'docs-link'), 'junction')
      const listed = status(repo)
      const { trash, trashed } = trashFor(repo)
      if (listed.includes('docs-link/a.md')) {
        // Git for Windows lists the junction's contents as untracked files.
        await expect(discardPaths(repo, ['docs-link/a.md'], 'all', trash)).rejects.toThrow(/reached through a link/)
        expect(read(repo, 'docs/a.md')).toBe('tracked\n')
        expect(trashed()).toEqual([])
      } else {
        // Elsewhere git lists the link itself: it is the link that goes, not the folder.
        expect(listed).toBe('?? docs-link')
        await discardPaths(repo, ['docs-link'], 'all', trash)
        expect(read(repo, 'docs/a.md')).toBe('tracked\n')
        expect(trashed()).toEqual(['1-docs-link'])
      }
    })
  })

  describe('hunk staging', () => {
    const lines = Array.from({ length: 30 }, (_, i) => (i === 16 ? '' : `line ${i + 1}`))

    for (const eol of ['\n', '\r\n']) {
      it(`stages a last hunk whose trailing context ends on a blank line (${eol === '\n' ? 'LF' : 'CRLF'})`, async () => {
        const repo = repoWith({ 'f.txt': lines.join(eol) + eol })
        const edited = [...lines]
        edited[1] = 'line 2 changed'
        edited[13] = 'line 14 changed'
        writeFileSync(join(repo, 'f.txt'), edited.join(eol) + eol)
        const last = await shownHunk(repo, 'f.txt', 1)
        expect(last.count).toBe(2)
        await stageHunk(repo, 'f.txt', last.hunk, last.diffHash)
        const staged = git(repo, 'diff', '--cached', '--', 'f.txt')
        expect(staged).toContain('+line 14 changed')
        expect(staged).not.toContain('+line 2 changed')
      })
    }
  })

  describe('switching branches', () => {
    it('a failing post-checkout hook does not move the changes onto the new branch', async () => {
      const repo = repoWith({ 'f.txt': 'one\n' })
      git(repo, 'branch', 'other')
      const hook = join(repo, '.git', 'hooks', 'post-checkout')
      writeFileSync(hook, '#!/bin/sh\nexit 1\n')
      chmodSync(hook, 0o755)
      writeFileSync(join(repo, 'f.txt'), 'mine\n')
      const result = await checkoutBranch(repo, 'other', { leaveChanges: true })
      expect(result.stashed).toBe(true)
      expect(result.detail).toMatch(/^Checked out other\. Your changes stay on main\. The post-checkout hook failed/)
      expect(git(repo, 'branch', '--show-current').trim()).toBe('other')
      expect(status(repo)).toBe('')
      expect(git(repo, 'stash', 'list')).toContain('vyotiq: changes left on main')
    })

    it('refuses to leave the changes of a merge in progress', async () => {
      const repo = repoWith({ 'f.txt': 'base\n' })
      git(repo, 'checkout', '-q', '-b', 'side')
      writeFileSync(join(repo, 'g.txt'), 'side\n')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'side')
      git(repo, 'checkout', '-q', 'main')
      git(repo, 'branch', 'other')
      git(repo, 'merge', '--no-commit', '--no-ff', 'side')
      await expect(checkoutBranch(repo, 'other', { leaveChanges: true })).rejects.toThrow(/A merge is in progress/)
      expect(git(repo, 'branch', '--show-current').trim()).toBe('main')
      expect(git(repo, 'stash', 'list')).toBe('')
    })
  })

  describe('restoring what a switch left', () => {
    it('refuses, changing nothing, when one of its new files now exists here', async () => {
      const repo = repoWith({ 'f.txt': 'one\n' })
      git(repo, 'branch', 'other')
      writeFileSync(join(repo, 'f.txt'), 'mine\n')
      writeFileSync(join(repo, 'new.txt'), 'left behind\n')
      await checkoutBranch(repo, 'other', { leaveChanges: true })
      await checkoutBranch(repo, 'main')
      writeFileSync(join(repo, 'new.txt'), 'made since\n')
      const stash = await readBranchStash(repo)
      await expect(restoreBranchStash(repo, stash!.sha)).rejects.toThrow(/New files in those changes exist here now \(new\.txt\)/)
      // Not half done: the tracked change did not come back either.
      expect(read(repo, 'f.txt')).toBe('one\n')
      expect(await readBranchStash(repo)).not.toBeNull()
    })

    it('after a restore with conflicts, Drop takes the stash away', async () => {
      const repo = repoWith({ 'f.txt': 'one\n' })
      git(repo, 'branch', 'other')
      writeFileSync(join(repo, 'f.txt'), 'mine\n')
      await checkoutBranch(repo, 'other', { leaveChanges: true })
      await checkoutBranch(repo, 'main')
      writeFileSync(join(repo, 'f.txt'), 'theirs\n')
      git(repo, 'commit', '-q', '-am', 'moved on')
      const stash = await readBranchStash(repo)
      const restored = await restoreBranchStash(repo, stash!.sha)
      expect(restored.conflicted).toBe(true)
      expect(restored.detail).toBe('1 file came back with conflicts; the stash is kept')
      // Resolved by hand.
      writeFileSync(join(repo, 'f.txt'), 'resolved\n')
      git(repo, 'add', 'f.txt')
      expect(await dropBranchStash(repo, stash!.sha)).toEqual({ detail: 'Dropped the changes left on main' })
      expect(await readBranchStash(repo)).toBeNull()
      expect(git(repo, 'stash', 'list')).toBe('')
    })

    it('Drop refuses a stash left on another branch', async () => {
      const repo = repoWith({ 'f.txt': 'one\n' })
      git(repo, 'branch', 'other')
      writeFileSync(join(repo, 'f.txt'), 'mine\n')
      await checkoutBranch(repo, 'other', { leaveChanges: true })
      const sha = git(repo, 'rev-parse', 'refs/stash').trim()
      await expect(dropBranchStash(repo, sha)).rejects.toThrow(/left on main; switch to it/)
      expect(git(repo, 'stash', 'list')).toContain('changes left on main')
    })
  })

  it('reads every change a commit takes, for its message: kinds, counts, diffs, no noise folders', async () => {
    const repo = repoWith({ 'src/a.ts': 'one\ntwo\n', 'src/gone.ts': 'bye\n', 'app/[id].tsx': 'x\n', 'café menu.md': 'old\n' })
    writeFileSync(join(repo, 'src/a.ts'), 'one\nTWO\nthree\n')
    rmSync(join(repo, 'src/gone.ts'))
    writeFileSync(join(repo, 'app/[id].tsx'), 'y\n')
    writeFileSync(join(repo, 'café menu.md'), 'new\n')
    writeFileSync(join(repo, 'staged.ts'), 'export const s = 1\n')
    git(repo, 'add', 'staged.ts')
    writeFileSync(join(repo, 'fresh.ts'), 'export const f = 1\nexport const g = 2')
    writeFileSync(join(repo, 'logo.bin'), Buffer.from([0, 1, 2, 3]))
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'noise\n')

    const changes = await readCommitChanges(repo, 'all')
    const byPath = new Map(changes!.files.map((f) => [f.path, f]))
    expect([...byPath.keys()].sort()).toEqual(['app/[id].tsx', 'café menu.md', 'fresh.ts', 'logo.bin', 'src/a.ts', 'src/gone.ts', 'staged.ts'])
    expect(byPath.get('src/a.ts')).toMatchObject({ kind: 'modified', added: 2, removed: 1, untracked: false })
    expect(byPath.get('src/a.ts')!.diff).toContain('+TWO')
    expect(byPath.get('src/gone.ts')).toMatchObject({ kind: 'deleted', removed: 1 })
    expect(byPath.get('staged.ts')).toMatchObject({ kind: 'added', added: 1, untracked: false })
    expect(byPath.get('fresh.ts')).toMatchObject({ kind: 'added', added: 2, untracked: true })
    expect(byPath.get('fresh.ts')!.diff).toBe('new file fresh.ts\n+export const f = 1\n+export const g = 2')
    expect(byPath.get('logo.bin')).toMatchObject({ binary: true, diff: null })
    // A path git quotes in its diff header still finds its diff.
    expect(byPath.get('café menu.md')!.diff).toContain('+new')
    expect(byPath.get('app/[id].tsx')!.diff).toContain('+y')
    expect(changes!.partial).toBe(false)

    // Same changes, same key; a same-size edit is a new key.
    expect((await readCommitChanges(repo, 'all'))!.key).toBe(changes!.key)
    writeFileSync(join(repo, 'src/a.ts'), 'one\nTWX\nthree\n')
    expect((await readCommitChanges(repo, 'all'))!.key).not.toBe(changes!.key)

    // Staged: the index only.
    const staged = await readCommitChanges(repo, 'staged')
    expect(staged!.files.map((f) => f.path)).toEqual(['staged.ts'])
    expect(staged!.key).not.toBe(changes!.key)
  })

  it('reads past the status list cap and before the first commit', async () => {
    const repo = emptyRepo()
    for (let i = 0; i < 250; i++) writeFileSync(join(repo, `f${i}.txt`), `${i}\n`)
    writeFileSync(join(repo, 'kept.txt'), 'staged\n')
    git(repo, 'add', 'kept.txt')
    const changes = await readCommitChanges(repo, 'all')
    expect(changes!.files).toHaveLength(251)
    expect(changes!.files.find((f) => f.path === 'kept.txt')).toMatchObject({ kind: 'added', untracked: false })
    const status = await readGitStatus(repo)
    expect(status.kind === 'ok' && status.status.truncated).toBe(true)
  })

  it('status names HEAD, so Amend can tell when the last commit changed', async () => {
    const repo = repoWith({ 'f.txt': 'one\n' })
    const first = await readGitStatus(repo)
    expect(first.kind === 'ok' && first.status.head).toBe(git(repo, 'rev-parse', 'HEAD').trim())
    git(repo, 'commit', '-q', '--amend', '-m', 'reworded')
    const second = await readGitStatus(repo)
    expect(second.kind === 'ok' && second.status.head).toBe(git(repo, 'rev-parse', 'HEAD').trim())
    expect(second.kind === 'ok' && first.kind === 'ok' && second.status.head !== first.status.head).toBe(true)
    const unborn = await readGitStatus(emptyRepo())
    expect(unborn.kind === 'ok' && unborn.status.head).toBeUndefined()
  })

  it('two background fetches asked at once run one fetch', async () => {
    resetBackgroundFetchForTests()
    const remote = join(root, `case-${++seq}`, 'remote.git')
    mkdirSync(remote, { recursive: true })
    git(remote, 'init', '--bare', '--initial-branch=main')
    const repo = repoWith({ 'f.txt': 'one\n' })
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', '-u', 'origin', 'main')
    const now = Date.now()
    const [a, b] = await Promise.all([backgroundFetch(repo, now), backgroundFetch(repo, now)])
    expect([a.skipped === true, b.skipped === true].sort()).toEqual([false, true])
    resetBackgroundFetchForTests()
  })

  it('a subfolder and another worktree of one repository share its background fetch', async () => {
    resetBackgroundFetchForTests()
    const remote = join(root, `case-${++seq}`, 'remote.git')
    mkdirSync(remote, { recursive: true })
    git(remote, 'init', '--bare', '--initial-branch=main')
    const repo = repoWith({ 'sub/f.txt': 'one\n' })
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', '-u', 'origin', 'main')
    const tree = join(repo, '..', 'tree')
    git(repo, 'worktree', 'add', '-q', '-b', 'side', tree)
    const now = Date.now()
    const [a, b, c] = await Promise.all([
      backgroundFetch(repo, now),
      backgroundFetch(join(repo, 'sub'), now),
      backgroundFetch(tree, now)
    ])
    expect([a, b, c].filter((r) => r.skipped !== true)).toHaveLength(1)
    // Once one went through, the others wait out the gap, but each is told
    // once that the refs moved, so its counts are read again.
    const ran = [a, b, c].findIndex((r) => r.skipped !== true)
    const paths = [repo, join(repo, 'sub'), tree]
    for (const [i, path] of paths.entries()) {
      const again = await backgroundFetch(path, now + 1000)
      expect(again.skipped).toBe(true)
      expect(again.refsMoved === true).toBe(i !== ran)
    }
    expect((await backgroundFetch(tree, now + 2000)).refsMoved).toBeUndefined()
    // Another repository is its own.
    const other = repoWith({ 'g.txt': 'one\n' })
    git(other, 'remote', 'add', 'origin', remote)
    expect((await backgroundFetch(other, now + 1000)).skipped).not.toBe(true)
    resetBackgroundFetchForTests()
  })

  it('a failed fetch tells no other worktree that the refs moved', async () => {
    resetBackgroundFetchForTests()
    const repo = repoWith({ 'f.txt': 'one\n' })
    git(repo, 'remote', 'add', 'origin', join(root, `case-${++seq}`, 'missing.git'))
    const tree = join(repo, '..', 'tree')
    git(repo, 'worktree', 'add', '-q', '-b', 'side', tree)
    const now = Date.now()
    await expect(backgroundFetch(repo, now)).rejects.toThrow()
    const after = await backgroundFetch(tree, now + 1000)
    expect(after.skipped).toBe(true)
    expect(after.refsMoved).toBeUndefined()
    resetBackgroundFetchForTests()
  })
})
