import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { canGit } from '../../helpers/canGit'

/**
 * Real git in real repositories (a bare "origin" plus a clone); only GitHub
 * is played here: `gh pr view` and the refs API answer from the bare remote,
 * and a DELETE removes the branch from it, as GitHub's would.
 */
const { gh } = vi.hoisted(() => ({
  gh: { pr: {} as Record<string, unknown>, bare: '', calls: [] as string[], refGone: false }
}))

vi.mock('@main/git/ghBinary', () => ({
  ghAvailable: async () => true,
  resolveGhExecutable: async () => 'gh-fake',
  resetGhBinaryCacheForTests: () => undefined
}))

vi.mock('@main/git/githubAuth', () => ({
  resolveGhTokenForCli: () => undefined,
  setupGithubGitAuth: async () => undefined
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  const util = await import('util')
  const real = util.promisify(actual.execFile)
  const wrapped = Object.assign(
    (...args: Parameters<typeof actual.execFile>) => actual.execFile(...args),
    {
      [util.promisify.custom]: async (bin: string, args: string[], opts: object) => {
        if (bin !== 'gh-fake') return real(bin, args, opts as never)
        gh.calls.push(args.join(' '))
        const notFound = Object.assign(new Error('Command failed: gh api'), { stderr: 'gh: Not Found (HTTP 404)', code: 1 })
        if (args[0] === 'pr' && args[1] === 'view') return { stdout: JSON.stringify(gh.pr), stderr: '' }
        if (args[0] === 'api' && args[1] === '-X' && args[2] === 'DELETE') {
          const branch = args[3]!.replace('repos/{owner}/{repo}/git/refs/heads/', '').split('/').map(decodeURIComponent).join('/')
          actual.execFileSync('git', ['branch', '-D', branch], { cwd: gh.bare, stdio: 'ignore' })
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'api') {
          const branch = args[1]!.replace('repos/{owner}/{repo}/git/ref/heads/', '').split('/').map(decodeURIComponent).join('/')
          if (gh.refGone) throw notFound
          try {
            const sha = actual.execFileSync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: gh.bare, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
            return { stdout: JSON.stringify({ ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } }), stderr: '' }
          } catch {
            throw notFound
          }
        }
        throw new Error(`unexpected gh ${args.join(' ')}`)
      }
    }
  )
  return { ...actual, execFile: wrapped }
})

import { prCleanupMerged } from '@main/git/gh'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function configure(repo: string): void {
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'commit.gpgsign', 'false')
  git(repo, 'config', 'core.autocrlf', 'false')
}

let root = ''
let seq = 0

/**
 * main with one commit; `feat/login` pushed with one more; then a squash of
 * it merged into origin's main from another clone — what GitHub's squash
 * merge leaves behind. The workspace is still on feat/login.
 */
function setup(): { repo: string; bare: string; headOid: string } {
  const dir = join(root, `case-${++seq}`)
  const bare = join(dir, 'remote.git')
  const repo = join(dir, 'repo')
  mkdirSync(bare, { recursive: true })
  mkdirSync(repo)
  git(bare, 'init', '--bare', '--initial-branch=main')
  git(repo, 'init', '--initial-branch=main')
  configure(repo)
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'first')
  git(repo, 'remote', 'add', 'origin', bare)
  git(repo, 'push', '-u', 'origin', 'main')
  git(repo, 'switch', '-c', 'feat/login')
  writeFileSync(join(repo, 'login.txt'), 'login\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'add login')
  git(repo, 'push', '-u', 'origin', 'feat/login')
  const headOid = git(repo, 'rev-parse', 'HEAD').trim()
  // GitHub's side: squash feat/login into main.
  git(dir, 'clone', bare, 'github')
  const github = join(dir, 'github')
  configure(github)
  git(github, 'merge', '--squash', 'origin/feat/login')
  git(github, 'commit', '-m', 'Add login (#12)')
  git(github, 'push', 'origin', 'main')
  gh.bare = bare
  gh.pr = { state: 'MERGED', headRefName: 'feat/login', baseRefName: 'main', headRefOid: headOid, isCrossRepository: false }
  return { repo, bare, headOid }
}

const branches = (repo: string): string[] =>
  git(repo, 'branch', '--all', '--format=%(refname:short)').split('\n').map((b) => b.trim()).filter(Boolean).sort()

describe.skipIf(!canGit)('prCleanupMerged', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'vyotiq-cleanup-test-'))
  })
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })
  beforeEach(() => {
    gh.calls = []
    gh.refGone = false
  })

  it('switches to the base, pulls the merge, and deletes the branch here and on GitHub', async () => {
    const { repo, bare } = setup()
    const result = await prCleanupMerged(repo, 12)
    expect(result).toMatchObject({ switchedTo: 'main', deletedLocal: true, deletedRemote: true })
    expect(result.detail).toMatch(/^Switched to main, deleted feat\/login here and on GitHub\. Pulled 1 commit from origin\/main\.$/)
    expect(git(repo, 'branch', '--show-current').trim()).toBe('main')
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('Add login (#12)')
    expect(branches(repo)).toEqual(['main', 'origin', 'origin/main'])
    expect(git(bare, 'branch', '--format=%(refname:short)').trim()).toBe('main')
    expect(gh.calls).toContain('api -X DELETE repos/{owner}/{repo}/git/refs/heads/feat/login')
  })

  it('refuses to switch while tracked files have uncommitted changes, and changes nothing', async () => {
    const { repo, bare } = setup()
    writeFileSync(join(repo, 'login.txt'), 'edited\n')
    await expect(prCleanupMerged(repo, 12)).rejects.toThrow(/Commit or discard the 1 uncommitted change on feat\/login/)
    expect(git(repo, 'branch', '--show-current').trim()).toBe('feat/login')
    expect(git(bare, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort()).toEqual(['feat/login', 'main'])
  })

  it('keeps a local branch with commits that are not in the pull request', async () => {
    const { repo } = setup()
    writeFileSync(join(repo, 'later.txt'), 'later\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'after the merge')
    const result = await prCleanupMerged(repo, 12)
    expect(result).toMatchObject({ switchedTo: 'main', deletedLocal: false, deletedRemote: true })
    expect(result.detail).toMatch(/Kept the local feat\/login: it has commits that are not in the pull request/)
    expect(branches(repo)).toContain('feat/login')
  })

  it('keeps the GitHub branch when commits were pushed to it after the merge', async () => {
    const { repo, bare } = setup()
    git(repo, 'commit', '--allow-empty', '-m', 'pushed later')
    git(repo, 'push', 'origin', 'feat/login')
    git(repo, 'reset', '--hard', 'HEAD~1')
    const result = await prCleanupMerged(repo, 12)
    expect(result.deletedRemote).toBe(false)
    expect(result.detail).toMatch(/Kept feat\/login on GitHub: it has commits pushed after the merge/)
    expect(git(bare, 'branch', '--format=%(refname:short)')).toMatch(/feat\/login/)
    expect(gh.calls.some((c) => c.includes('DELETE'))).toBe(false)
  })

  it('says so when GitHub already deleted the branch, and drops the stale tracking ref', async () => {
    const { repo } = setup()
    gh.refGone = true
    const result = await prCleanupMerged(repo, 12)
    expect(result).toMatchObject({ deletedLocal: true, deletedRemote: false })
    expect(result.detail).toMatch(/feat\/login was already deleted on GitHub/)
    expect(branches(repo)).not.toContain('origin/feat/login')
  })

  it("never touches a fork's branch", async () => {
    const { repo, bare } = setup()
    gh.pr = { ...gh.pr, isCrossRepository: true }
    const result = await prCleanupMerged(repo, 12)
    expect(result.deletedRemote).toBe(false)
    expect(result.detail).toMatch(/lives on a fork/)
    expect(git(bare, 'branch', '--format=%(refname:short)')).toMatch(/feat\/login/)
    expect(gh.calls.some((c) => c.startsWith('api'))).toBe(false)
  })

  it('stays on the branch when the base is checked out in another worktree', async () => {
    const { repo } = setup()
    const other = join(repo, '..', 'main-worktree')
    git(repo, 'worktree', 'add', other, 'main')
    const result = await prCleanupMerged(repo, 12)
    expect(result).toMatchObject({ switchedTo: null, deletedLocal: false, deletedRemote: true })
    expect(result.detail).toMatch(/main is checked out in another worktree/)
    expect(git(repo, 'branch', '--show-current').trim()).toBe('feat/login')
  })

  it('refuses a pull request that is not merged', async () => {
    const { repo } = setup()
    gh.pr = { ...gh.pr, state: 'OPEN' }
    await expect(prCleanupMerged(repo, 12)).rejects.toThrow(/#12 is not merged/)
    expect(git(repo, 'branch', '--show-current').trim()).toBe('feat/login')
  })
})
