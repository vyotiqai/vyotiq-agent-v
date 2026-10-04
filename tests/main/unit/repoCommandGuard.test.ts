import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const userData = mkdtempSync(join(tmpdir(), 'vyotiq-git-trust-'))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? userData : tmpdir()) }
}))

import {
  allowRepoCommands,
  guardGitInvocation,
  hooksPathLeavesRepo,
  neutralizerFor,
  parseGitConfigList,
  readBlockedRepoCommands,
  resetRepoCommandGuardForTests,
  withDiffProgramsOff,
  withPackProgramsReset
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

/**
 * The settings fetch, push and commit reach: each program drops a marker,
 * and the user's own (global) value is a different marker that must still run.
 */
describe('repo command guard on network and write commands', () => {
  /** A program git runs directly (not through a shell): a script on disk. */
  function script(name: string, tail: string): string {
    const path = join(root, `${name}.sh`)
    writeFileSync(path, `#!/bin/sh\necho ran >> "${markers.replace(/\\/g, '/')}/${name}"\n${tail}\n`, { mode: 0o755 })
    return path.replace(/\\/g, '/')
  }

  function setGlobal(key: string, value: string): void {
    git(['config', '--file', env.GIT_CONFIG_GLOBAL!, '--add', key, value])
  }

  /** Run git through the guard, feeding `input`; failures are fine, what ran is what matters. */
  async function guardedRun(args: string[], input = ''): Promise<string[]> {
    const call = await guardGitInvocation(args, repo, env)
    try {
      execFileSync('git', call.args, { cwd: repo, env: call.env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 20_000 })
    } catch {
      // expected for most: the remote is not there
    }
    return ran()
  }

  function unguardedRun(args: string[], input = ''): string[] {
    try {
      execFileSync('git', args, { cwd: repo, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 20_000 })
    } catch {
      // as above
    }
    return ran()
  }

  const CREDENTIAL_QUERY = 'protocol=https\nhost=example.com\n\n'

  beforeEach(() => {
    // The machine's own ssh/askpass/proxy settings would mask what the repo's do.
    for (const name of ['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_PROXY_COMMAND']) delete env[name]
  })

  it('picks out only programs that came with the repository', () => {
    const inherited = (...keys: string[]): string | undefined => (keys.includes('core.sshcommand') ? 'ssh -i ~/.ssh/k' : undefined)
    // Bare names are installed software: `git credential-manager`, gpg2 on PATH.
    expect(neutralizerFor('credential.helper', 'manager')).toBeNull()
    expect(neutralizerFor('credential.helper', '')).toBeNull()
    expect(neutralizerFor('credential.https://h.example.helper', '!f() { evil; }; f')?.special).toBe('credential')
    expect(neutralizerFor('gpg.program', 'gpg2')).toBeNull()
    expect(neutralizerFor('gpg.program', './tools/gpg')?.config).toEqual([
      ['gpg.program', 'gpg'],
      ['gpg.openpgp.program', 'gpg']
    ])
    expect(neutralizerFor('core.sshcommand', 'sh -c evil', inherited)?.config).toEqual([['core.sshCommand', 'ssh -i ~/.ssh/k']])
    expect(neutralizerFor('core.sshcommand', 'sh -c evil')?.special).toBe('sshDefault')
    expect(neutralizerFor('core.gitproxy', 'none for example.com')).toBeNull()
    expect(neutralizerFor('core.gitproxy', './proxy for example.com')?.special).toBe('gitProxy')
    expect(neutralizerFor('protocol.allow', 'never')).toBeNull()
    expect(neutralizerFor('protocol.ext.allow', 'always')?.config).toEqual([['protocol.ext.allow', 'never']])
    expect(neutralizerFor('remote.origin.uploadpack', 'git-upload-pack')).toBeNull()
    expect(neutralizerFor('remote.origin.receivepack', '/tmp/x')?.special).toBe('packPrograms')
    expect(withPackProgramsReset(['fetch', '--all'])).toEqual(['fetch', '--upload-pack=git-upload-pack', '--all'])
    expect(withPackProgramsReset(['push', 'origin', 'main'])).toEqual(['push', '--receive-pack=git-receive-pack', 'origin', 'main'])
    expect(withPackProgramsReset(['status'])).toEqual(['status'])

    const dirs = { gitDir: join(repo, '.git'), commonDir: join(repo, '.git'), workTree: repo }
    expect(hooksPathLeavesRepo('.husky/_', dirs)).toBe(false)
    expect(hooksPathLeavesRepo(join(repo, '.git', 'hooks'), dirs)).toBe(false)
    expect(hooksPathLeavesRepo('../elsewhere', dirs)).toBe(true)
    expect(hooksPathLeavesRepo(join(root, 'hooks-out'), dirs)).toBe(true)
    expect(hooksPathLeavesRepo('~/hooks', dirs)).toBe(true)
  })

  it('counts hooks inside the repository as inside, however its path is spelled', () => {
    // A checkout reached through an alias is the same repository: a macOS
    // runner's `/var` for `/private/var`, a Windows runner's 8.3 TEMP. Hooks
    // under it did come with the folder, so they are not the repo reaching out.
    const alias = join(root, 'alias')
    symlinkSync(repo, alias, 'junction')
    const dirs = { gitDir: join(alias, '.git'), commonDir: join(alias, '.git'), workTree: alias }
    expect(hooksPathLeavesRepo('.husky/_', dirs)).toBe(false)
    expect(hooksPathLeavesRepo(join(alias, '.git', 'hooks'), dirs)).toBe(false)
    // Still leaves, spelled either way: outside the checkout, or beside it.
    expect(hooksPathLeavesRepo('../elsewhere', dirs)).toBe(true)
    expect(hooksPathLeavesRepo(join(root, 'hooks-out'), dirs)).toBe(true)
    expect(hooksPathLeavesRepo(join(alias, '..', 'hooks-out'), dirs)).toBe(true)
  })

  it('keeps the user’s credential helpers and drops the repository’s', async () => {
    setGlobal('credential.https://example.com.helper', `!${marker('global-url-helper', 'true')}`)
    // Helpers that answer nothing, so git asks every one of them.
    setGlobal('credential.helper', `!${marker('global-helper', 'true')}`)
    git(['config', 'credential.helper', `!${marker('repo-helper', 'true')}`])
    git(['config', 'credential.https://example.com.helper', `!${marker('repo-url-helper', 'true')}`])

    expect(unguardedRun(['credential', 'fill'], CREDENTIAL_QUERY)).toEqual(
      expect.arrayContaining(['repo-helper', 'repo-url-helper'])
    )
    clearRan()
    // Both of the user's, URL-scoped one included, in git's order; none of the repo's.
    expect(await guardedRun(['credential', 'fill'], CREDENTIAL_QUERY)).toEqual(['global-helper', 'global-url-helper'])
    clearRan()
    expect(await guardedRun(['credential', 'fill'], 'protocol=https\nhost=other.example\n\n')).toEqual(['global-helper'])
  })

  it('switches off a repository ssh command and askpass, and puts the user’s ssh command back', async () => {
    setGlobal('core.sshCommand', marker('global-ssh', 'exit 1'))
    git(['config', 'core.sshCommand', marker('repo-ssh', 'exit 1')])
    git(['config', 'core.askPass', script('repo-askpass', 'echo x')])

    expect(unguardedRun(['ls-remote', 'ssh://nobody@127.0.0.1:9/x'])).toEqual(['repo-ssh'])
    clearRan()
    expect(await guardedRun(['ls-remote', 'ssh://nobody@127.0.0.1:9/x'])).toEqual(['global-ssh'])
    clearRan()
    expect(unguardedRun(['-c', 'credential.helper=', 'credential', 'fill'], CREDENTIAL_QUERY)).toEqual(['repo-askpass'])
    clearRan()
    expect(await guardedRun(['credential', 'fill'], CREDENTIAL_QUERY)).toEqual([])
    expect((await readBlockedRepoCommands(repo, env))?.blocked.map((c) => c.key).sort()).toEqual([
      'core.askpass',
      'core.sshcommand'
    ])
  })

  it('treats a file the repository includes as the repository’s own', async () => {
    const included = join(root, 'included.gitconfig')
    git(['config', '--file', included, 'core.sshCommand', marker('included-ssh', 'exit 1')])
    git(['config', 'include.path', included.replace(/\\/g, '/')])
    expect((await readBlockedRepoCommands(repo, env))?.blocked).toEqual([
      { key: 'core.sshcommand', value: expect.stringContaining('included-ssh') }
    ])
    setGlobal('core.sshCommand', marker('global-ssh', 'exit 1'))
    resetRepoCommandGuardForTests()
    expect(await guardedRun(['ls-remote', 'ssh://nobody@127.0.0.1:9/x'])).toEqual(['global-ssh'])
  })

  function addOrigin(): void {
    const remote = join(root, 'remote.git')
    git(['init', '-q', '--bare', remote], root)
    git(['remote', 'add', 'origin', remote])
    git(['push', '-q', 'origin', 'main'])
  }

  it('runs no repository pack program or proxy', async () => {
    addOrigin()
    git(['config', 'remote.origin.uploadpack', script('repo-uploadpack', 'exec git-upload-pack "$@"')])
    git(['config', 'remote.origin.receivepack', script('repo-receivepack', 'exec git-receive-pack "$@"')])
    expect(unguardedRun(['fetch', '--all'])).toEqual(['repo-uploadpack'])
    clearRan()
    expect(await guardedRun(['fetch', '--all'])).toEqual([])
    expect(await guardedRun(['fetch'])).toEqual([])
    git(['commit', '-q', '--allow-empty', '-m', 'more'])
    expect(await guardedRun(['push', 'origin', 'main'])).toEqual([])

    git(['config', 'core.gitProxy', script('repo-proxy', 'exit 1')])
    expect(await guardedRun(['ls-remote', 'git://127.0.0.1:9/x'])).toEqual([])
  })

  it('runs no repository alternate-refs command or ext:: remote', async () => {
    addOrigin()
    const alt = join(root, 'alt')
    git(['init', '-q', alt], root)
    git(['commit', '-q', '--allow-empty', '-m', 'alt'], alt)
    writeFileSync(join(repo, '.git', 'objects', 'info', 'alternates'), `${join(alt, '.git', 'objects').replace(/\\/g, '/')}\n`)
    git(['config', 'core.alternateRefsCommand', marker('repo-altrefs', 'true')])
    expect(unguardedRun(['fetch', 'origin'])).toEqual(['repo-altrefs'])
    clearRan()
    expect(await guardedRun(['fetch', 'origin'])).toEqual([])
    git(['config', '--unset', 'core.alternateRefsCommand'])

    // ext:: stays off with nothing else blocked, even where the user's own config allows it.
    setGlobal('protocol.ext.allow', 'always')
    git(['remote', 'add', 'evil', `ext::sh -c echo% ran% >>${markers.replace(/\\/g, '/')}/ext`])
    expect(unguardedRun(['fetch', 'evil'])).toEqual(['ext'])
    clearRan()
    expect(await guardedRun(['fetch', 'evil'])).toEqual([])
  })

  it('signs with the user’s gpg, not the repository’s', async () => {
    setGlobal('gpg.program', script('global-gpg', 'exit 1'))
    git(['config', 'gpg.program', script('repo-gpg', 'exit 1')])
    git(['config', 'commit.gpgSign', 'true'])
    expect(await guardedRun(['commit', '--allow-empty', '-m', 'signed'])).toEqual(['global-gpg'])
  })

  it('runs the repository’s own hooks but not a hooks path outside it', async () => {
    const hook = (dir: string, name: string): void => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'post-commit'), `#!/bin/sh\necho ran >> "${markers.replace(/\\/g, '/')}/${name}"\n`, { mode: 0o755 })
    }
    hook(join(repo, '.git', 'hooks'), 'git-dir-hook')
    hook(join(root, 'hooks-out'), 'outside-hook')
    hook(join(repo, '.githooks'), 'inside-hook')

    git(['config', 'core.hooksPath', join(root, 'hooks-out').replace(/\\/g, '/')])
    expect(await guardedRun(['commit', '--allow-empty', '-m', 'a'])).toEqual(['git-dir-hook'])
    clearRan()

    git(['config', 'core.hooksPath', '.githooks'])
    expect(await readBlockedRepoCommands(repo, env)).toBeNull()
    expect(await guardedRun(['commit', '--allow-empty', '-m', 'b'])).toEqual(['inside-hook'])
  })
})
