import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readGitStatus, stageAll } from '@main/git/git'
import { canGit } from '../../helpers/canGit'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

describe.skipIf(!canGit)('readGitStatus noise filtering', () => {
  let repo: string

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'vyotiq-git-noise-'))
    git(repo, 'init', '--initial-branch=main')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(repo, 'kept.txt'), 'one\n', 'utf8')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'first')

    writeFileSync(join(repo, 'app.js'), 'console.log(1)\n', 'utf8')
    mkdirSync(join(repo, 'node_modules', 'left-pad'), { recursive: true })
    for (let i = 0; i < 80; i++) {
      writeFileSync(join(repo, 'node_modules', 'left-pad', `f${i}.js`), `module.exports=${i}\n`, 'utf8')
    }
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('omits node_modules from status while keeping real untracked files', async () => {
    const t0 = performance.now()
    const result = await readGitStatus(repo)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    const status = result.status
    const ms = performance.now() - t0
    expect(status.files.some((f) => f.path === 'app.js')).toBe(true)
    expect(status.files.some((f) => f.path.includes('node_modules'))).toBe(false)
    expect(status.fileCount).toBe(1)
    expect(ms).toBeLessThan(5_000)
  })

  it('stageAll does not stage untracked node_modules', async () => {
    writeFileSync(join(repo, 'visible.js'), 'ok\n', 'utf8')
    const result = await stageAll(repo)
    expect(result.staged).toBe(true)
    const porcelain = execFileSync('git', ['status', '--porcelain=v1', '-z', '-uall'], {
      cwd: repo,
      encoding: 'utf8'
    })
    expect(porcelain).toContain('visible.js')
    // Still untracked (??) rather than staged (A )
    expect(porcelain).toMatch(/\?\?.*node_modules|node_modules.*\?\?/)
    // Or simply: node_modules entries still start with ??
    const records = porcelain.split('\0').filter(Boolean)
    const nm = records.filter((r) => r.includes('node_modules'))
    expect(nm.length).toBeGreaterThan(0)
    expect(nm.every((r) => r.startsWith('??'))).toBe(true)
  })

  it('does not invent phantom paths for staged renames', async () => {
    writeFileSync(join(repo, 'rename-me.txt'), 'hello\n', 'utf8')
    git(repo, 'add', 'rename-me.txt')
    git(repo, 'commit', '-m', 'add rename-me')
    git(repo, 'mv', 'rename-me.txt', 'renamed.txt')
    const result = await readGitStatus(repo)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    const paths = result.status.files.map((f) => f.path)
    expect(paths).not.toContain('.txt')
    expect(paths.some((p) => p === 'renamed.txt' || p === 'rename-me.txt')).toBe(true)
  })
})
