import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { readBranchDiff } from '@main/git/git'

const repos: string[] = []
let repo: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })
}

function commit(file: string, content: string, message: string): void {
  writeFileSync(join(repo, file), content, 'utf8')
  git('add', '-A')
  git('commit', '-q', '-m', message)
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'vyotiq-branchdiff-'))
  repos.push(repo)
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.autocrlf', 'false')
  commit('a.txt', 'a0\n', 'first')
})

afterAll(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true })
})

describe('readBranchDiff', () => {
  it('is the branch since it left main, its uncommitted work included — never main’s own later work', async () => {
    git('checkout', '-q', '-b', 'feat/x')
    commit('feature.txt', 'f1\n', 'feature one')
    commit('feature.txt', 'f1\nf2\n', 'feature two')
    writeFileSync(join(repo, 'a.txt'), 'a0\nuncommitted\n', 'utf8')
    // main moves on after the branch left it.
    git('stash', 'push', '-q', '-m', 'hold')
    git('checkout', '-q', 'main')
    commit('main-only.txt', 'm\n', 'main later')
    git('checkout', '-q', 'feat/x')
    git('stash', 'pop', '-q')

    const res = await readBranchDiff(repo)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data).toMatchObject({ branch: 'feat/x', base: 'main', commits: 2 })
    expect(res.data.content).toContain('+++ b/feature.txt')
    expect(res.data.content).toContain('+uncommitted')
    expect(res.data.content).not.toContain('main-only.txt')
  })

  it('on the base branch itself, it is the uncommitted changes, and says there is no base', async () => {
    writeFileSync(join(repo, 'a.txt'), 'a0\nmine\n', 'utf8')
    const res = await readBranchDiff(repo)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data).toMatchObject({ branch: 'main', base: null, commits: 0 })
    expect(res.data.content).toContain('+mine')
  })

  it('refuses a folder that is not a repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'vyotiq-branchdiff-plain-'))
    repos.push(plain)
    expect(await readBranchDiff(plain)).toEqual({ ok: false, error: 'Not a git repository' })
  })
})
