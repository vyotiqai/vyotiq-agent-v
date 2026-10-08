import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { discardPaths } from '@main/git/git'
import { canGit } from '../../helpers/canGit'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// One root of our own under the OS temp dir; only it is ever removed.
let root = ''
let seq = 0

/** A repository with two committed files, and a folder standing in for the OS trash. */
function setup(): { repo: string; trashDir: string; trash: (abs: string) => Promise<void>; trashed: () => string[] } {
  const dir = join(root, `case-${++seq}`)
  const repo = join(dir, 'repo')
  const trashDir = join(dir, 'trash')
  mkdirSync(repo, { recursive: true })
  mkdirSync(trashDir)
  git(repo, 'init', '--initial-branch=main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'commit.gpgsign', 'false')
  git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'a.txt'), 'a1\n')
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src', 'b.txt'), 'b1\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'first')
  let n = 0
  return {
    repo,
    trashDir,
    // Like shell.trashItem: the file leaves its folder and lands in the trash.
    trash: async (abs) => {
      renameSync(abs, join(trashDir, `${++n}-${basename(abs)}`))
    },
    trashed: () => readdirSync(trashDir).sort()
  }
}

const read = (repo: string, rel: string): string => readFileSync(join(repo, rel), 'utf8')
const status = (repo: string): string => git(repo, 'status', '--porcelain=v1', '-uall').trim()

describe.skipIf(!canGit)('discardPaths', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'vyotiq-discard-test-'))
  })
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('worktree: drops what is not staged and keeps what is, with a copy in the trash', async () => {
    const { repo, trash, trashDir, trashed } = setup()
    writeFileSync(join(repo, 'a.txt'), 'a2 staged\n')
    git(repo, 'add', 'a.txt')
    writeFileSync(join(repo, 'a.txt'), 'a3 unstaged\n')
    const result = await discardPaths(repo, ['a.txt'], 'worktree', trash)
    expect(result).toMatchObject({ discarded: ['a.txt'], backedUp: 1 })
    expect(read(repo, 'a.txt')).toBe('a2 staged\n')
    expect(status(repo)).toBe('M  a.txt')
    expect(trashed()).toEqual(['1-a.txt'])
    expect(readFileSync(join(trashDir, '1-a.txt'), 'utf8')).toBe('a3 unstaged\n')
  })

  it('all: back to HEAD, staged and unstaged, in a subfolder too', async () => {
    const { repo, trash, trashed } = setup()
    writeFileSync(join(repo, 'src', 'b.txt'), 'b2\n')
    git(repo, 'add', '-A')
    writeFileSync(join(repo, 'src', 'b.txt'), 'b3\n')
    const result = await discardPaths(repo, ['src/b.txt'], 'all', trash)
    expect(result.discarded).toEqual(['src/b.txt'])
    expect(read(repo, 'src/b.txt')).toBe('b1\n')
    expect(status(repo)).toBe('')
    expect(trashed()).toEqual(['1-b.txt'])
  })

  it('moves an untracked file to the trash instead of deleting it', async () => {
    const { repo, trash, trashDir, trashed } = setup()
    writeFileSync(join(repo, 'new.txt'), 'mine\n')
    const result = await discardPaths(repo, ['new.txt'], 'worktree', trash)
    expect(result).toMatchObject({ discarded: ['new.txt'], backedUp: 1 })
    expect(existsSync(join(repo, 'new.txt'))).toBe(false)
    expect(readFileSync(join(trashDir, trashed()[0]!), 'utf8')).toBe('mine\n')
  })

  it('all: a file added in the index but not in HEAD is unstaged and trashed', async () => {
    const { repo, trash, trashed } = setup()
    writeFileSync(join(repo, 'added.txt'), 'new\n')
    git(repo, 'add', 'added.txt')
    await discardPaths(repo, ['added.txt'], 'all', trash)
    expect(existsSync(join(repo, 'added.txt'))).toBe(false)
    expect(status(repo)).toBe('')
    expect(trashed()).toEqual(['1-added.txt'])
  })

  it('brings back a deleted file without needing a copy', async () => {
    const { repo, trash, trashed } = setup()
    rmSync(join(repo, 'a.txt'))
    const result = await discardPaths(repo, ['a.txt'], 'all', trash)
    expect(result).toMatchObject({ discarded: ['a.txt'], backedUp: 0 })
    expect(read(repo, 'a.txt')).toBe('a1\n')
    expect(trashed()).toEqual([])
  })

  it('never overwrites a file whose copy could not be kept', async () => {
    const { repo } = setup()
    writeFileSync(join(repo, 'a.txt'), 'precious\n')
    const refuse = async () => {
      throw new Error('no trash on this system')
    }
    await expect(discardPaths(repo, ['a.txt'], 'all', refuse)).rejects.toThrow(/could not be put in the trash.*no trash/)
    expect(read(repo, 'a.txt')).toBe('precious\n')
  })

  it('works from a workspace opened at a subfolder of the repository', async () => {
    const { repo, trash } = setup()
    writeFileSync(join(repo, 'src', 'b.txt'), 'changed\n')
    const result = await discardPaths(join(repo, 'src'), ['b.txt'], 'all', trash)
    expect(result.discarded).toEqual(['b.txt'])
    expect(read(repo, 'src/b.txt')).toBe('b1\n')
  })

  it('leaves clean, unknown and unsafe paths alone', async () => {
    const { repo, trash, trashed } = setup()
    const result = await discardPaths(repo, ['a.txt', 'missing.txt', '../outside.txt'], 'all', trash)
    expect(result).toEqual({ detail: 'Nothing was discarded', discarded: [], backedUp: 0 })
    expect(trashed()).toEqual([])
  })

  it('handles several files in one call', async () => {
    const { repo, trash } = setup()
    writeFileSync(join(repo, 'a.txt'), 'x\n')
    writeFileSync(join(repo, 'src', 'b.txt'), 'y\n')
    writeFileSync(join(repo, 'c.txt'), 'z\n')
    const result = await discardPaths(repo, ['a.txt', 'src/b.txt', 'c.txt'], 'all', trash)
    expect(result.discarded.sort()).toEqual(['a.txt', 'c.txt', 'src/b.txt'])
    expect(result.backedUp).toBe(3)
    expect(result.detail).toBe('Discarded changes to 3 files · old copies are in the trash')
    expect(status(repo)).toBe('')
  })
})
