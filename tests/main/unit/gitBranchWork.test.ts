import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  amendLastCommit,
  checkoutBranch,
  readBranchStash,
  readGitDiff,
  readLastCommit,
  restoreBranchStash,
  stageHunk
} from '@main/git/git'
import {
  BACKGROUND_FETCH_HOLD_OFF_MS,
  BACKGROUND_FETCH_MIN_GAP_MS,
  backgroundFetch,
  resetBackgroundFetchForTests
} from '@main/git/backgroundFetch'
import { diffFingerprint, hunkIdentity, parseUnifiedHunks } from '@shared/utils/hunkPatch'
import { canGit } from '../../helpers/canGit'

/** Real git in real temporary repositories: switching with changes, hunk staging, amend, background fetch. */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function configure(repo: string): void {
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'commit.gpgsign', 'false')
  git(repo, 'config', 'core.autocrlf', 'false')
}

// One root of our own under the OS temp dir; only it is ever removed.
let root = ''
let seq = 0

function repoWith(files: Record<string, string>): string {
  const repo = join(root, `case-${++seq}`)
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '--initial-branch=main')
  configure(repo)
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(repo, rel), text)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'first')
  return repo
}

const read = (repo: string, rel: string): string => readFileSync(join(repo, rel), 'utf8')
const status = (repo: string): string => git(repo, 'status', '--porcelain=v1', '-uall').trim()

const LINES = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
const text = (lines: string[], eol = '\n'): string => lines.join(eol) + eol

/** The file's diff as the panel gets it, and the hunk the person clicked. */
async function shownHunk(repo: string, path: string, index: number, staged = false) {
  const diff = await readGitDiff(repo, { path, staged })
  if (!diff.ok) throw new Error(diff.error)
  const hunk = parseUnifiedHunks(diff.content)[index]
  if (!hunk) throw new Error(`no hunk ${index}`)
  return { hunk: hunkIdentity(hunk), diffHash: diffFingerprint(diff.content) }
}

describe.skipIf(!canGit)('git branch work', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'vyotiq-branch-work-test-'))
  })
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  describe('switching with uncommitted changes', () => {
    it('leaves them on the old branch — untracked and staged too — and restores them there', async () => {
      const repo = repoWith({ 'a.txt': 'a1\n', 'b.txt': 'b1\n' })
      git(repo, 'branch', 'feature')
      writeFileSync(join(repo, 'a.txt'), 'a2 staged\n')
      git(repo, 'add', 'a.txt')
      writeFileSync(join(repo, 'b.txt'), 'b2 unstaged\n')
      writeFileSync(join(repo, 'new.txt'), 'brand new\n')

      const result = await checkoutBranch(repo, 'feature', { leaveChanges: true })
      expect(result).toEqual({ detail: 'Checked out feature. Your changes stay on main', stashed: true })
      expect(git(repo, 'branch', '--show-current').trim()).toBe('feature')
      expect(status(repo)).toBe('')
      expect(existsSync(join(repo, 'new.txt'))).toBe(false)
      // Not offered on the branch they were not left on.
      expect(await readBranchStash(repo)).toBeNull()

      await checkoutBranch(repo, 'main')
      const left = await readBranchStash(repo)
      expect(left).toMatchObject({ branch: 'main', files: 3 })
      expect(left!.sha).toBe(git(repo, 'rev-parse', 'refs/stash').trim())

      const restored = await restoreBranchStash(repo, left!.sha)
      expect(restored).toEqual({ detail: 'Restored the changes left on main', conflicted: false })
      expect(read(repo, 'a.txt')).toBe('a2 staged\n')
      expect(read(repo, 'b.txt')).toBe('b2 unstaged\n')
      expect(read(repo, 'new.txt')).toBe('brand new\n')
      // Staged stays staged, unstaged stays unstaged; the stash is gone.
      expect(status(repo).split('\n').sort()).toEqual([' M b.txt', '?? new.txt', 'M  a.txt'])
      expect(git(repo, 'stash', 'list').trim()).toBe('')
      expect(await readBranchStash(repo)).toBeNull()
    })

    it('without leaveChanges git carries them over, and refuses one that would be overwritten', async () => {
      const repo = repoWith({ 'a.txt': 'a1\n' })
      git(repo, 'switch', '-c', 'other')
      writeFileSync(join(repo, 'a.txt'), 'a on other\n')
      git(repo, 'commit', '-am', 'other')
      git(repo, 'switch', 'main')
      writeFileSync(join(repo, 'a.txt'), 'my edit\n')
      await expect(checkoutBranch(repo, 'other')).rejects.toThrow(/would be overwritten by checkout/)
      expect(git(repo, 'branch', '--show-current').trim()).toBe('main')
      expect(read(repo, 'a.txt')).toBe('my edit\n')
      // Leaving them behind is what makes that switch possible.
      await checkoutBranch(repo, 'other', { leaveChanges: true })
      expect(read(repo, 'a.txt')).toBe('a on other\n')
    })

    it('a stash that conflicts on restore comes back with markers and is kept', async () => {
      const repo = repoWith({ 'a.txt': 'a1\n' })
      git(repo, 'branch', 'feature')
      writeFileSync(join(repo, 'a.txt'), 'left behind\n')
      await checkoutBranch(repo, 'feature', { leaveChanges: true })
      await checkoutBranch(repo, 'main')
      // Meanwhile main moves on under the same line.
      writeFileSync(join(repo, 'a.txt'), 'committed since\n')
      git(repo, 'commit', '-am', 'moved')
      const left = await readBranchStash(repo)
      const result = await restoreBranchStash(repo, left!.sha)
      expect(result.conflicted).toBe(true)
      expect(read(repo, 'a.txt')).toContain('<<<<<<<')
      expect(git(repo, 'stash', 'list').trim()).not.toBe('')
    })

    it('refuses to restore on a branch the changes were not left on', async () => {
      const repo = repoWith({ 'a.txt': 'a1\n' })
      git(repo, 'branch', 'feature')
      writeFileSync(join(repo, 'a.txt'), 'mine\n')
      await checkoutBranch(repo, 'feature', { leaveChanges: true })
      const sha = git(repo, 'rev-parse', 'refs/stash').trim()
      await expect(restoreBranchStash(repo, sha)).rejects.toThrow(/left on main; switch to it/)
    })

    it('clean tree: a plain switch, nothing stashed', async () => {
      const repo = repoWith({ 'a.txt': 'a1\n' })
      git(repo, 'branch', 'feature')
      expect(await checkoutBranch(repo, 'feature', { leaveChanges: true })).toEqual({ detail: 'Checked out feature' })
      expect(git(repo, 'stash', 'list').trim()).toBe('')
    })
  })

  describe('staging one hunk', () => {
    it('stages only the hunk asked for, and unstages it back', async () => {
      const repo = repoWith({ 'f.txt': text(LINES) })
      const edited = [...LINES]
      edited[1] = 'line 2 CHANGED'
      edited[27] = 'line 28 CHANGED'
      writeFileSync(join(repo, 'f.txt'), text(edited))

      const second = await shownHunk(repo, 'f.txt', 1)
      expect(await stageHunk(repo, 'f.txt', second.hunk, second.diffHash)).toEqual({
        detail: 'Staged the hunk at line 25 of f.txt'
      })
      const cached = git(repo, 'diff', '--cached', '--', 'f.txt')
      expect(cached).toContain('+line 28 CHANGED')
      expect(cached).not.toContain('line 2 CHANGED')
      expect(git(repo, 'diff', '--', 'f.txt')).toContain('+line 2 CHANGED')
      expect(read(repo, 'f.txt')).toBe(text(edited))

      const staged = await shownHunk(repo, 'f.txt', 0, true)
      await stageHunk(repo, 'f.txt', staged.hunk, staged.diffHash, true)
      expect(git(repo, 'diff', '--cached').trim()).toBe('')
      expect(read(repo, 'f.txt')).toBe(text(edited))
    })

    it('keeps CRLF line endings intact', async () => {
      const repo = repoWith({ 'w.txt': text(LINES, '\r\n') })
      const edited = [...LINES]
      edited[0] = 'first CHANGED'
      edited[29] = 'last CHANGED'
      writeFileSync(join(repo, 'w.txt'), text(edited, '\r\n'))
      const first = await shownHunk(repo, 'w.txt', 0)
      await stageHunk(repo, 'w.txt', first.hunk, first.diffHash)
      const index = git(repo, 'show', ':w.txt')
      const want = [...LINES]
      want[0] = 'first CHANGED'
      expect(index).toBe(text(want, '\r\n'))
    })

    it('works under diff.noprefix and from a subfolder workspace', async () => {
      const repo = repoWith({ 'top.txt': 'x\n' })
      mkdirSync(join(repo, 'pkg'))
      writeFileSync(join(repo, 'pkg', 'p.txt'), text(LINES))
      git(repo, 'add', '-A')
      git(repo, 'commit', '-m', 'pkg')
      git(repo, 'config', 'diff.noprefix', 'true')
      const edited = [...LINES]
      edited[4] = 'five CHANGED'
      edited[25] = 'twenty-six CHANGED'
      writeFileSync(join(repo, 'pkg', 'p.txt'), text(edited))
      const workspace = join(repo, 'pkg')
      const shown = await shownHunk(workspace, 'p.txt', 1)
      await stageHunk(workspace, 'p.txt', shown.hunk, shown.diffHash)
      const cached = git(repo, 'diff', '--cached')
      expect(cached).toContain('+twenty-six CHANGED')
      expect(cached).not.toContain('five CHANGED')
    })

    it('refuses when the file changed after its diff was shown', async () => {
      const repo = repoWith({ 'f.txt': text(LINES) })
      const edited = [...LINES]
      edited[1] = 'shown'
      writeFileSync(join(repo, 'f.txt'), text(edited))
      const shown = await shownHunk(repo, 'f.txt', 0)
      edited[1] = 'edited again'
      writeFileSync(join(repo, 'f.txt'), text(edited))
      await expect(stageHunk(repo, 'f.txt', shown.hunk, shown.diffHash)).rejects.toThrow(/changed since its diff was shown/)
      expect(git(repo, 'diff', '--cached').trim()).toBe('')
    })
  })

  describe('amending the last commit', () => {
    let repo = ''
    let bare = ''
    beforeEach(() => {
      bare = join(root, `bare-${++seq}`)
      git(root, 'init', '--bare', '--initial-branch=main', bare)
      repo = repoWith({ 'a.txt': 'a1\n' })
      git(repo, 'remote', 'add', 'origin', bare)
      git(repo, 'push', '-u', 'origin', 'main')
      writeFileSync(join(repo, 'a.txt'), 'a2\n')
      git(repo, 'commit', '-am', 'second\n\nwith a body')
    })

    it('reads the last commit: its whole message, not pushed', async () => {
      const head = git(repo, 'rev-parse', 'HEAD').trim()
      expect(await readLastCommit(repo)).toEqual({ sha: head, message: 'second\n\nwith a body', pushed: false, amendable: true })
    })

    it('folds a forgotten file in and rewrites the message', async () => {
      const head = git(repo, 'rev-parse', 'HEAD').trim()
      writeFileSync(join(repo, 'forgot.txt'), 'forgotten\n')
      const result = await amendLastCommit(repo, 'second, complete', head, 'all')
      expect(result).toEqual({ committed: true, pushed: false, detail: `Amended ${head.slice(0, 7)}` })
      expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('second, complete')
      expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['a.txt', 'forgot.txt'])
      expect(git(repo, 'rev-list', '--count', 'HEAD').trim()).toBe('2')
      expect(status(repo)).toBe('')
    })

    it('staged mode leaves unstaged changes out', async () => {
      const head = git(repo, 'rev-parse', 'HEAD').trim()
      writeFileSync(join(repo, 'in.txt'), 'staged\n')
      git(repo, 'add', 'in.txt')
      writeFileSync(join(repo, 'out.txt'), 'not staged\n')
      await amendLastCommit(repo, 'second', head, 'staged')
      expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['a.txt', 'in.txt'])
      expect(status(repo)).toBe('?? out.txt')
    })

    it('refuses a pushed commit, and one that is no longer HEAD', async () => {
      const head = git(repo, 'rev-parse', 'HEAD').trim()
      git(repo, 'push')
      expect((await readLastCommit(repo))?.pushed).toBe(true)
      await expect(amendLastCommit(repo, 'x', head)).rejects.toThrow(/has been pushed/)
      writeFileSync(join(repo, 'b.txt'), 'b\n')
      git(repo, 'add', 'b.txt')
      git(repo, 'commit', '-m', 'third')
      await expect(amendLastCommit(repo, 'x', head)).rejects.toThrow(/no longer the latest/)
    })
  })

  describe('background fetch', () => {
    let bare = ''
    let mine = ''
    let theirs = ''
    beforeEach(() => {
      resetBackgroundFetchForTests()
      bare = join(root, `bare-${++seq}`)
      git(root, 'init', '--bare', '--initial-branch=main', bare)
      mine = repoWith({ 'a.txt': 'a1\n' })
      git(mine, 'remote', 'add', 'origin', bare)
      git(mine, 'push', '-u', 'origin', 'main')
      theirs = join(root, `theirs-${++seq}`)
      git(root, 'clone', bare, theirs)
      configure(theirs)
    })

    it('brings in a commit pushed elsewhere, then holds off for the gap', async () => {
      writeFileSync(join(theirs, 'b.txt'), 'theirs\n')
      git(theirs, 'add', '-A')
      git(theirs, 'commit', '-m', 'theirs')
      git(theirs, 'push')

      const now = Date.now()
      const first = await backgroundFetch(mine, now)
      expect(first).toMatchObject({ behind: 1, ahead: 0, changed: true })
      expect(first.skipped).toBeUndefined()
      // The working tree is never touched by a fetch.
      expect(existsSync(join(mine, 'b.txt'))).toBe(false)

      expect(await backgroundFetch(mine, now + 1000)).toEqual({ detail: 'Fetched a moment ago', skipped: true })
      const later = await backgroundFetch(mine, now + BACKGROUND_FETCH_MIN_GAP_MS + 1000)
      expect(later).toMatchObject({ behind: 1, changed: false })
    })

    it('a failing remote is held off quietly, then tried again', async () => {
      git(mine, 'remote', 'set-url', 'origin', join(root, 'no-such-remote'))
      const now = Date.now()
      await expect(backgroundFetch(mine, now)).rejects.toThrow()
      expect(await backgroundFetch(mine, now + BACKGROUND_FETCH_MIN_GAP_MS + 1000)).toEqual({
        detail: 'Held off after a failed fetch',
        skipped: true
      })
      git(mine, 'remote', 'set-url', 'origin', bare)
      expect((await backgroundFetch(mine, now + BACKGROUND_FETCH_HOLD_OFF_MS + 1000)).skipped).toBeUndefined()
    })

    it('a repository without a remote is skipped', async () => {
      const lone = repoWith({ 'x.txt': 'x\n' })
      expect(await backgroundFetch(lone)).toEqual({ detail: 'No remote to fetch', skipped: true })
    })
  })
})
