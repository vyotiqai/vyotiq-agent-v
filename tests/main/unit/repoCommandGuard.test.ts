import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const userData = mkdtempSync(join(tmpdir(), 'vyotiq-git-trust-'))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? userData : tmpdir()) }
}))

import {
  allowRepoCommands,
  guardGitInvocation,
  neutralizerFor,
  parseGitConfigList,
  readBlockedRepoCommands,
  resetRepoCommandGuardForTests,
  withDiffProgramsOff
} from '@main/git/repoCommandGuard'

/**
 * Real git against a repository whose own .git/config names programs. Each
 * program only drops a marker file, so "it ran" is a file on disk, not a mock.
 */
let root: string
let repo: string
let markers: string
let env: NodeJS.ProcessEnv

function git(args: string[], cwd = repo, extraEnv: NodeJS.ProcessEnv = env): string {
  return execFileSync('git', args, { cwd, env: extraEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** A program that records `name` in the markers dir; `tail` is what it does after. */
function marker(name: string, tail: string): string {
  return `sh -c 'echo ran >> "${markers.replace(/\\/g, '/')}/${name}"; ${tail}'`
}

function ran(): string[] {
  return existsSync(markers) ? readdirSync(markers).sort() : []
}

function clearRan(): void {
  rmSync(markers, { recursive: true, force: true })
  mkdirSync(markers)
}

/** Run git the way the app does: through the guard. */
async function guarded(args: string[], cwd = repo): Promise<{ code: number; stdout: string }> {
  const call = await guardGitInvocation(args, cwd, env)
  try {
    return { code: 0, stdout: git(call.args, cwd, call.env) }
  } catch (err) {
    return { code: (err as { status?: number }).status ?? -1, stdout: '' }
  }
}

beforeEach(() => {
  resetRepoCommandGuardForTests()
  rmSync(join(userData, 'git-command-trust.json'), { force: true })
  root = mkdtempSync(join(tmpdir(), 'vyotiq-repo-guard-'))
  repo = join(root, 'repo')
  markers = join(root, 'markers')
  mkdirSync(repo)
  mkdirSync(markers)
  const globalConfig = join(root, 'global.gitconfig')
  writeFileSync(globalConfig, '[user]\n\tname = t\n\temail = t@t\n[init]\n\tdefaultBranch = main\n')
  env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0'
  }
  git(['init', '-q', '.'])
  writeFileSync(join(repo, '.gitattributes'), 'a.txt filter=x diff=y\nm.txt merge=m\n')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  writeFileSync(join(repo, 'm.txt'), 'l1\nl2\nl3\nl4\nl5\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'init'])
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function armRepo(): void {
  git(['config', 'core.fsmonitor', marker('fsmonitor', 'false')])
  git(['config', 'filter.x.clean', marker('clean', 'cat')])
  git(['config', 'filter.x.smudge', marker('smudge', 'cat')])
  git(['config', 'filter.x.required', 'true'])
  git(['config', 'diff.y.textconv', marker('textconv', 'cat "$0"')])
  git(['config', 'diff.external', marker('external', 'true')])
  git(['config', 'merge.m.driver', marker('merge', 'exit 1')])
}

describe('repo command guard', () => {
  it('parses a config listing and picks out the settings that name programs', () => {
    const records = parseGitConfigList(
      'local\0file:.git/config\0core.fsmonitor\ntrue\0local\0file:.git/config\0filter.Crypt.clean\ngit-crypt clean\0'
    )
    expect(records).toEqual([
      { scope: 'local', origin: 'file:.git/config', key: 'core.fsmonitor', value: 'true' },
      { scope: 'local', origin: 'file:.git/config', key: 'filter.Crypt.clean', value: 'git-crypt clean' }
    ])
    // git's built-in fsmonitor daemon is git's own code.
    expect(neutralizerFor('core.fsmonitor', 'true')).toBeNull()
    expect(neutralizerFor('core.fsmonitor', '.git/hooks/query-watchman')).toEqual({
      config: [['core.fsmonitor', 'false']],
      diffFlags: false
    })
    expect(neutralizerFor('filter.Crypt.clean', 'x')?.config).toEqual([
      ['filter.Crypt.clean', ''],
      ['filter.Crypt.required', 'false']
    ])
    expect(neutralizerFor('diff.y.textconv', 'x')).toEqual({ config: [], diffFlags: true })
    expect(neutralizerFor('user.name', 'x')).toBeNull()
  })

  it('inserts the diff-program flags after the subcommand only', () => {
    expect(withDiffProgramsOff(['diff', '--numstat', '--', 'a'])).toEqual([
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--numstat',
      '--',
      'a'
    ])
    expect(withDiffProgramsOff(['-c', 'k=v', 'log', '-p'])).toEqual(['-c', 'k=v', 'log', '--no-ext-diff', '--no-textconv', '-p'])
    expect(withDiffProgramsOff(['blame', 'a.txt'])).toEqual(['blame', '--no-textconv', 'a.txt'])
    expect(withDiffProgramsOff(['status', '-z'])).toEqual(['status', '-z'])
  })

  it('runs none of the repository programs on the reads the app does', async () => {
    armRepo()
    // Same size as 'one\n': git has to re-read it, which is when clean runs.
    writeFileSync(join(repo, 'a.txt'), 'two\n')

    // Unguarded, a plain status runs the repo's programs: the attack is real.
    try {
      git(['status', '--porcelain'])
    } catch {
      // the armed filter may fail; what ran is what matters
    }
    expect(ran()).toEqual(expect.arrayContaining(['clean', 'fsmonitor']))
    clearRan()

    const status = await guarded(['status', '--porcelain=v1', '-z', '-uall', '--no-renames'])
    expect(status.code).toBe(0)
    expect(status.stdout).toContain('a.txt')
    const diff = await guarded(['diff', '--', 'a.txt'])
    expect(diff.code).toBe(0)
    expect(diff.stdout).toContain('+two')
    expect((await guarded(['diff', '--numstat', '-z'])).code).toBe(0)
    expect((await guarded(['log', '-p', '-1'])).code).toBe(0)
    expect((await guarded(['blame', 'a.txt'])).code).toBe(0)
    expect(ran()).toEqual([])

    expect(await readBlockedRepoCommands(repo, env)).toEqual({
      blocked: expect.arrayContaining([
        { key: 'core.fsmonitor', value: expect.stringContaining('fsmonitor') },
        { key: 'filter.x.clean', value: expect.stringContaining('clean') },
        { key: 'merge.m.driver', value: expect.stringContaining('merge') }
      ]),
      canAllow: true
    })
  })

  it('merges with git’s own text merge instead of the repository driver', async () => {
    git(['checkout', '-qb', 'side'])
    writeFileSync(join(repo, 'm.txt'), 'S1\nl2\nl3\nl4\nl5\n')
    git(['commit', '-qam', 'side'])
    git(['checkout', '-q', 'main'])
    writeFileSync(join(repo, 'm.txt'), 'l1\nl2\nl3\nl4\nM5\n')
    git(['commit', '-qam', 'main'])
    git(['config', 'merge.m.driver', marker('merge', 'exit 1')])

    const merge = await guarded(['merge', '--no-edit', 'side'])
    expect(merge.code).toBe(0)
    expect(git(['show', 'HEAD:m.txt']).replace(/\r\n/g, '\n')).toBe('S1\nl2\nl3\nl4\nM5\n')
    expect(ran()).toEqual([])
  })

  it('leaves the user’s own global settings alone', async () => {
    // git config quotes the value for the file; written raw, git would strip its quotes.
    git(['config', '--file', env.GIT_CONFIG_GLOBAL!, 'filter.x.clean', marker('global-clean', 'cat')])
    // Same size as 'one\n', so git has to re-read the file — that is when clean runs.
    writeFileSync(join(repo, 'a.txt'), 'uno\n')
    expect(await readBlockedRepoCommands(repo, env)).toBeNull()
    expect((await guarded(['status', '--porcelain'])).code).toBe(0)
    expect(ran()).toEqual(['global-clean'])
  })

  it('runs them once allowed, for this exact set, in the repo and its worktrees', async () => {
    armRepo()
    await expect(allowRepoCommands(repo, env)).resolves.toEqual({ allowed: 6 })
    expect(await readBlockedRepoCommands(repo, env)).toBeNull()
    writeFileSync(join(repo, 'a.txt'), 'dos\n')
    await guarded(['status', '--porcelain'])
    expect(ran()).toEqual(expect.arrayContaining(['clean', 'fsmonitor']))

    // A worktree shares the repository's settings and its allowance.
    const worktree = join(root, 'wt')
    git(['worktree', 'add', '-q', worktree, 'HEAD'], repo, (await guardGitInvocation([], repo, env)).env)
    expect(await readBlockedRepoCommands(worktree, env)).toBeNull()

    // A new program is a different set: switched off again until allowed.
    git(['config', 'filter.z.clean', marker('new-clean', 'cat')])
    const blocked = await readBlockedRepoCommands(repo, env)
    expect(blocked?.blocked).toEqual(expect.arrayContaining([{ key: 'filter.z.clean', value: expect.any(String) }]))
    clearRan()
    await guarded(['status', '--porcelain'])
    expect(ran()).toEqual([])
  })

  it('does not spawn git for a folder with no repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'vyotiq-no-repo-'))
    try {
      // A bad binary would throw if the guard tried to scan.
      const call = await guardGitInvocation(['status'], plain, env, join(plain, 'no-such-git'))
      expect(call.args).toEqual(['status'])
      expect(call.env).toBe(env)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})
