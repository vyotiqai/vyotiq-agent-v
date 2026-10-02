import { describe, expect, it } from 'vitest'
import {
  gitDirsFor,
  orderedRules,
  resolveSandboxPolicy,
  type SandboxFs,
  type SandboxPolicy
} from '@main/agent/sandbox/policy'
import {
  buildSeatbeltProfile,
  bwrapArgv,
  describeSandbox,
  sandboxDenialHint,
  seatbeltArgv,
  SANDBOX_EXEC_PATH,
  wrapSandboxedCommand
} from '@main/agent/sandbox/wrap'
import { AGENT_BUILT_TOOL_SANDBOX_REFUSAL, prepareAgentSandbox } from '@main/agent/sandbox'

/** An in-memory POSIX tree: dirs, files with text, and symlinks. */
function fakeFs(opts: {
  dirs?: string[]
  files?: Record<string, string>
  links?: Record<string, string>
}): SandboxFs {
  const dirs = new Set(opts.dirs ?? [])
  const files = opts.files ?? {}
  const links = opts.links ?? {}
  return {
    exists: (p) => dirs.has(p) || p in files || p in links,
    realpath: (p) => {
      for (const [from, to] of Object.entries(links)) {
        if (p === from || p.startsWith(`${from}/`)) return to + p.slice(from.length)
      }
      if (!dirs.has(p) && !(p in files)) throw new Error(`ENOENT ${p}`)
      return p
    },
    isFile: (p) => p in files,
    readText: (p) => files[p] ?? null
  }
}

const HOME = '/home/ada'
const USER_DATA = '/home/ada/.config/Vyotiq'

describe('resolveSandboxPolicy', () => {
  it('makes a workspace with spaces, its git dir, temp and existing caches writable', () => {
    const ws = '/home/ada/My Projects/app one'
    const policy = resolveSandboxPolicy({
      platform: 'linux',
      workspaceRoots: [ws],
      cwd: `${ws}/src`,
      homeDir: HOME,
      tmpDir: '/tmp',
      userDataDir: USER_DATA,
      network: 'allow',
      fs: fakeFs({
        dirs: [
          ws,
          `${ws}/src`,
          `${ws}/.git`,
          `${ws}/.git/hooks`,
          '/tmp',
          `${HOME}/.npm`,
          `${HOME}/.ssh`,
          USER_DATA
        ],
        files: { [`${ws}/.git/config`]: '[core]' }
      })
    })
    expect(policy.cwd).toBe(`${ws}/src`)
    expect(policy.rules).toEqual([
      { kind: 'write', path: ws },
      { kind: 'write', path: `${ws}/.git` },
      { kind: 'read-only', path: `${ws}/.git/hooks` },
      { kind: 'read-only', path: `${ws}/.git/config` },
      { kind: 'write', path: '/tmp' },
      { kind: 'write', path: `${HOME}/.npm` },
      { kind: 'hidden', path: USER_DATA },
      { kind: 'hidden', path: `${HOME}/.ssh` }
    ])
  })

  it('makes a linked worktree’s git dir and the main checkout’s common dir writable', () => {
    const main = '/repos/app'
    const wt = `${USER_DATA}/task-worktrees/abc/feature`
    const fs = fakeFs({
      dirs: [main, `${main}/.git`, `${main}/.git/worktrees/feature`, `${main}/.git/hooks`, wt, '/tmp'],
      files: {
        [`${wt}/.git`]: `gitdir: ${main}/.git/worktrees/feature\n`,
        [`${main}/.git/worktrees/feature/commondir`]: '../..\n'
      }
    })
    expect(gitDirsFor(wt, fs)).toEqual({ gitDir: `${main}/.git/worktrees/feature`, commonDir: `${main}/.git` })
    const policy = resolveSandboxPolicy({
      platform: 'linux',
      workspaceRoots: [wt],
      cwd: wt,
      homeDir: HOME,
      tmpDir: '/tmp',
      userDataDir: USER_DATA,
      network: 'deny',
      fs: fakeFs({
        dirs: [main, `${main}/.git`, `${main}/.git/worktrees/feature`, `${main}/.git/hooks`, wt, '/tmp', USER_DATA],
        files: {
          [`${wt}/.git`]: `gitdir: ${main}/.git/worktrees/feature\n`,
          [`${main}/.git/worktrees/feature/commondir`]: '../..\n'
        }
      })
    })
    const kinds = Object.fromEntries(policy.rules.map((r) => [r.path, r.kind]))
    expect(kinds[wt]).toBe('write')
    expect(kinds[`${main}/.git`]).toBe('write')
    expect(kinds[`${main}/.git/worktrees/feature`]).toBe('write')
    expect(kinds[`${main}/.git/hooks`]).toBe('read-only')
    expect(kinds[USER_DATA]).toBe('hidden')
    // Not the main checkout's working tree: only its .git.
    expect(kinds[main]).toBeUndefined()
  })

  it('canonicalizes macOS temp and adds the per-user cache sibling', () => {
    const policy = resolveSandboxPolicy({
      platform: 'darwin',
      workspaceRoots: ['/Users/ada/app'],
      cwd: '/Users/ada/app',
      homeDir: '/Users/ada',
      tmpDir: '/var/folders/xy/abc/T/',
      userDataDir: null,
      network: 'allow',
      fs: fakeFs({
        dirs: ['/Users/ada/app', '/private/var/folders/xy/abc/T', '/private/var/folders/xy/abc/C', '/private/tmp'],
        links: { '/var': '/private/var' }
      })
    })
    const writes = policy.rules.filter((r) => r.kind === 'write').map((r) => r.path)
    expect(writes).toContain('/private/var/folders/xy/abc/T')
    expect(writes).toContain('/private/var/folders/xy/abc/C')
    expect(writes).toContain('/private/tmp')
    expect(writes).not.toContain('/var/folders/xy/abc/T/')
  })

  it('leaves out caches and hidden paths that do not exist', () => {
    const policy = resolveSandboxPolicy({
      platform: 'linux',
      workspaceRoots: ['/w'],
      cwd: '/w',
      homeDir: HOME,
      tmpDir: '/tmp',
      userDataDir: USER_DATA,
      network: 'allow',
      fs: fakeFs({ dirs: ['/w', '/tmp'] })
    })
    expect(policy.rules).toEqual([
      { kind: 'write', path: '/w' },
      { kind: 'write', path: '/tmp' }
    ])
  })
})

describe('orderedRules', () => {
  it('puts deeper paths last so they win, and the stricter kind on a tie', () => {
    const policy: SandboxPolicy = {
      cwd: '/w',
      network: 'allow',
      rules: [
        { kind: 'write', path: `${USER_DATA}/task-worktrees/x` },
        { kind: 'hidden', path: USER_DATA },
        { kind: 'write', path: HOME },
        { kind: 'hidden', path: `${HOME}/.ssh` },
        { kind: 'write', path: '/same' },
        { kind: 'hidden', path: '/same' }
      ]
    }
    expect(orderedRules(policy).map((r) => `${r.kind} ${r.path}`)).toEqual([
      'write /same',
      'hidden /same',
      `write ${HOME}`,
      `hidden ${HOME}/.ssh`,
      `hidden ${USER_DATA}`,
      `write ${USER_DATA}/task-worktrees/x`
    ])
  })
})

const POLICY: SandboxPolicy = {
  cwd: '/home/ada/My Projects/app',
  network: 'allow',
  rules: [
    { kind: 'write', path: '/home/ada/My Projects/app' },
    { kind: 'read-only', path: '/home/ada/My Projects/app/.git/hooks' },
    { kind: 'write', path: '/tmp' },
    { kind: 'hidden', path: '/home/ada/.ssh' }
  ]
}

describe('buildSeatbeltProfile', () => {
  it('denies writes, allows the roots back via params, and hides secrets', () => {
    const { profile, params } = buildSeatbeltProfile(POLICY)
    expect(params).toEqual([
      'PATH_0=/tmp',
      'PATH_1=/home/ada/.ssh',
      'PATH_2=/home/ada/My Projects/app',
      'PATH_3=/home/ada/My Projects/app/.git/hooks'
    ])
    expect(profile.split('\n')).toEqual([
      '(version 1)',
      '(allow default)',
      '(deny file-write*)',
      '(allow file-write* (subpath "/dev"))',
      '(allow file-read* file-write* (subpath (param "PATH_0")))',
      '(deny file-read* file-write* (subpath (param "PATH_1")))',
      '(allow file-read* file-write* (subpath (param "PATH_2")))',
      '(allow file-read* (subpath (param "PATH_3")))',
      '(deny file-write* (subpath (param "PATH_3")))'
    ])
    // A path never lands in the profile text, so spaces or quotes cannot change it.
    expect(profile).not.toContain('My Projects')
  })

  it('denies the network but keeps localhost and unix sockets when network is deny', () => {
    const { profile } = buildSeatbeltProfile({ ...POLICY, network: 'deny' })
    expect(profile).toContain('(deny network*)')
    expect(profile).toContain('(allow network* (remote ip "localhost:*"))')
    expect(profile).toContain('(allow network* (remote unix-socket))')
    expect(buildSeatbeltProfile(POLICY).profile).not.toContain('network')
  })

  it('builds the sandbox-exec argv with -D params and the command after --', () => {
    const wrapped = seatbeltArgv(POLICY, '/bin/zsh', ['-lc', 'echo "hi there"'])
    expect(wrapped.bin).toBe(SANDBOX_EXEC_PATH)
    expect(wrapped.args[0]).toBe('-p')
    expect(wrapped.args.slice(2, 4)).toEqual(['-D', 'PATH_0=/tmp'])
    expect(wrapped.args.slice(-4)).toEqual(['--', '/bin/zsh', '-lc', 'echo "hi there"'])
  })
})

describe('bwrapArgv', () => {
  it('binds root read-only and mounts each rule in depth order', () => {
    const wrapped = bwrapArgv(POLICY, '/bin/sh', ['-c', 'make test'], '/usr/bin/bwrap')
    expect(wrapped).toEqual({
      bin: '/usr/bin/bwrap',
      args: [
        '--ro-bind', '/', '/',
        '--dev', '/dev',
        '--proc', '/proc',
        '--bind', '/tmp', '/tmp',
        '--tmpfs', '/home/ada/.ssh',
        '--bind', '/home/ada/My Projects/app', '/home/ada/My Projects/app',
        '--ro-bind', '/home/ada/My Projects/app/.git/hooks', '/home/ada/My Projects/app/.git/hooks',
        '--unshare-pid',
        '--die-with-parent', '--new-session',
        '--chdir', '/home/ada/My Projects/app',
        '--', '/bin/sh', '-c', 'make test'
      ]
    })
  })

  it('unshares the network only when network is deny', () => {
    expect(bwrapArgv(POLICY, 'true', []).args).not.toContain('--unshare-net')
    expect(bwrapArgv({ ...POLICY, network: 'deny' }, 'true', []).args).toContain('--unshare-net')
  })

  it('wrapSandboxedCommand picks the backend by mechanism', () => {
    expect(wrapSandboxedCommand('seatbelt', POLICY, 'ls', []).bin).toBe(SANDBOX_EXEC_PATH)
    expect(wrapSandboxedCommand('bubblewrap', POLICY, 'ls', [], '/opt/bwrap').bin).toBe('/opt/bwrap')
  })
})

describe('sandboxDenialHint', () => {
  it('names a blocked write from EPERM / EROFS output', () => {
    expect(sandboxDenialHint("touch: /etc/x: Operation not permitted", 'allow')).toMatch(/^\[sandbox\].*a write outside the workspace/)
    expect(sandboxDenialHint("mkdir: cannot create directory '/opt/x': Read-only file system", 'allow')).toMatch(
      /^\[sandbox\]/
    )
  })

  it('names the network only when the network is denied', () => {
    const out = 'curl: (6) Could not resolve host: example.com'
    expect(sandboxDenialHint(out, 'allow')).toBeNull()
    expect(sandboxDenialHint(out, 'deny')).toMatch(/a network connection.*with no network/)
  })

  it('stays quiet on ordinary failures', () => {
    expect(sandboxDenialHint('FAIL tests/a.test.ts > adds\nexpected 2 to be 3', 'deny')).toBeNull()
  })

  it('describes the sandbox for the result header', () => {
    expect(describeSandbox('bubblewrap', 'deny')).toBe('workspace-write via bubblewrap, network denied')
  })
})

describe('prepareAgentSandbox', () => {
  const capability = {
    available: true,
    mechanism: 'bubblewrap' as const,
    reason: null,
    executable: '/usr/bin/bwrap'
  }
  const deps = {
    capability,
    platform: 'linux' as const,
    fs: fakeFs({ dirs: ['/w', '/tmp'] }),
    homeDir: HOME,
    tmpDir: '/tmp',
    userDataDir: null
  }

  it('is off when the setting is off or missing', () => {
    expect(prepareAgentSandbox({ workspace: '/w', settings: undefined }, deps).state).toBe('off')
    expect(prepareAgentSandbox({ workspace: '/w', settings: { mode: 'off', network: 'deny' } }, deps).state).toBe('off')
  })

  it('refuses rather than running unsandboxed when the machine cannot sandbox', () => {
    const prepared = prepareAgentSandbox(
      { workspace: '/w', settings: { mode: 'workspace-write', network: 'allow' } },
      { ...deps, platform: 'win32', capability: { available: false, mechanism: null, reason: 'No sandbox on Windows.', executable: null } }
    )
    expect(prepared.state).toBe('unavailable')
    if (prepared.state !== 'unavailable') return
    expect(prepared.message).toContain('Sandbox unavailable')
    expect(prepared.message).toContain('No sandbox on Windows.')
    expect(prepared.message).toContain('turn the sandbox off')
  })

  it('returns a launch that wraps the command in bwrap', () => {
    const prepared = prepareAgentSandbox(
      { workspace: '/w', cwd: '/w', settings: { mode: 'workspace-write', network: 'deny' } },
      deps
    )
    expect(prepared.state).toBe('on')
    if (prepared.state !== 'on') return
    expect(prepared.launch.label).toBe('workspace-write via bubblewrap, network denied')
    const wrapped = prepared.launch.wrap('/bin/sh', ['-c', 'ls'])
    expect(wrapped.bin).toBe('/usr/bin/bwrap')
    expect(wrapped.args).toContain('--unshare-net')
    expect(wrapped.args.slice(-3)).toEqual(['/bin/sh', '-c', 'ls'])
  })

  it('explains why agent-built tools are refused', () => {
    expect(AGENT_BUILT_TOOL_SANDBOX_REFUSAL).toMatch(/cannot run inside the command sandbox/)
  })
})
