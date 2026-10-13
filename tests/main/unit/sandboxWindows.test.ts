import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, win32 } from 'path'
import {
  escapeForCmd,
  icaclsLabelArgs,
  LOW_INTEGRITY_BASH_REFUSAL,
  lowIntegrityArgv,
  lowIntegrityTempDir,
  quoteWindowsArg,
  resolveWindowsSandboxPolicy,
  windowsLabelPlan,
  windowsPathInside
} from '@main/agent/sandbox/windows'
import { applyWindowsLabels, prepareLowIntegrityShells, restoreWindowsLabels } from '@main/agent/sandbox/windowsSetup'
import { prepareAgentSandbox, prepareAgentSandboxReady, WINDOWS_NETWORK_DENY_REASON } from '@main/agent/sandbox'
import { wrappedSpawnOptions, type WrappedCommand } from '@main/agent/sandbox/wrap'
import type { SandboxFs } from '@main/agent/sandbox/policy'

const SHELLS = { cmd: 'C:\\ud\\sandbox\\cmd-low.exe', powershell: 'C:\\ud\\sandbox\\powershell-low.exe' }
const TEMP = 'C:\\Users\\me\\AppData\\LocalLow\\Vyotiq\\sandbox-temp'

function fakeFs(opts: { dirs?: string[]; files?: Record<string, string> }): SandboxFs {
  const dirs = new Set((opts.dirs ?? []).map((d) => d.toLowerCase()))
  const files = new Map(Object.entries(opts.files ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    exists: (p) => dirs.has(p.toLowerCase()) || files.has(p.toLowerCase()),
    realpath: (p) => {
      if (!dirs.has(p.toLowerCase()) && !files.has(p.toLowerCase())) throw new Error('ENOENT')
      return p
    },
    isFile: (p) => files.has(p.toLowerCase()),
    readText: (p) => files.get(p.toLowerCase()) ?? null
  }
}

describe('quoting a command line for Windows', () => {
  it('quotes only what needs it, the way the C runtime reads it back', () => {
    expect(quoteWindowsArg('plain')).toBe('plain')
    expect(quoteWindowsArg('')).toBe('""')
    expect(quoteWindowsArg('two words')).toBe('"two words"')
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""')
    expect(quoteWindowsArg('C:\\my dir\\')).toBe('"C:\\my dir\\\\"')
    expect(quoteWindowsArg('a\\"b')).toBe('"a\\\\\\"b"')
    expect(quoteWindowsArg('C:\\no\\spaces')).toBe('C:\\no\\spaces')
  })

  it('carets every character cmd treats specially, quotes included', () => {
    expect(escapeForCmd('a & b')).toBe('a^ ^&^ b')
    expect(escapeForCmd('"x" | y > z')).toBe('^"x^"^ ^|^ y^ ^>^ z')
    expect(escapeForCmd('%PATH%!')).toBe('^%PATH^%^!')
  })
})

describe('lowIntegrityArgv', () => {
  const writeScript = vi.fn((extension: '.ps1') => `C:\\Users\\me\\AppData\\LocalLow\\Vyotiq\\sandbox-temp\\scripts\\s${extension}`)

  beforeEach(() => writeScript.mockClear())

  it('runs Windows PowerShell and cmd from their own low copies, arguments untouched', () => {
    const ps = lowIntegrityArgv(SHELLS, TEMP, 'powershell', ['-NoProfile', '-Command', 'a\nb'], { writeScript })
    expect(ps).toEqual({ bin: SHELLS.powershell, args: ['-NoProfile', '-Command', 'a\nb'], env: { TEMP, TMP: TEMP } })
    const cmd = lowIntegrityArgv(SHELLS, TEMP, 'cmd.exe', ['/c', 'dir & echo x'], { writeScript })
    expect(cmd).toEqual({ bin: SHELLS.cmd, args: ['/c', 'dir & echo x'], env: { TEMP, TMP: TEMP } })
    expect(writeScript).not.toHaveBeenCalled()
  })

  it('falls back to the cmd copy for PowerShell when there is no PowerShell copy', () => {
    const ps = lowIntegrityArgv({ ...SHELLS, powershell: null }, TEMP, 'powershell', ['-Command', 'x'], { writeScript })
    expect(ps.bin).toBe(SHELLS.cmd)
    expect(ps.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
  })

  it('runs anything else through the cmd copy as one escaped line, verbatim and named cmd', () => {
    const out = lowIntegrityArgv(SHELLS, TEMP, 'C:\\Program Files\\nodejs\\node.exe', ['-e', 'console.log("a & b")'], {
      writeScript
    })
    expect(out.bin).toBe(SHELLS.cmd)
    expect(out.argv0).toBe('cmd')
    expect(out.windowsVerbatimArguments).toBe(true)
    expect(out.args).toEqual([
      '/d',
      '/s',
      '/c',
      `"${escapeForCmd('"C:\\Program Files\\nodejs\\node.exe" -e "console.log(\\"a & b\\")"')}"`
    ])
  })

  it('quotes the program even when its path holds no space', () => {
    const out = lowIntegrityArgv(
      SHELLS,
      TEMP,
      'C:\\hostedtoolcache\\windows\\node\\24.24.0\\x64\\node.exe',
      ['-e', 'x'],
      { writeScript }
    )
    expect(out.args[3]).toBe(
      `"${escapeForCmd('"C:\\hostedtoolcache\\windows\\node\\24.24.0\\x64\\node.exe" -e x')}"`
    )
  })

  it('puts a PowerShell 7 script in a file, since cmd cannot carry its newlines or its length', () => {
    const out = lowIntegrityArgv(SHELLS, TEMP, 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'one\ntwo'], { writeScript })
    expect(writeScript).toHaveBeenCalledWith('.ps1', 'one\ntwo')
    expect(out.args[3]).toContain(escapeForCmd('-ExecutionPolicy Bypass -File'))
    expect(out.args[3]).not.toContain('one')
  })

  it('turns a bash command into one that says bash cannot start at low integrity, and fails', () => {
    for (const bin of ['bash', 'C:\\Program Files\\Git\\bin\\bash.exe', 'wsl']) {
      const out = lowIntegrityArgv(SHELLS, TEMP, bin, ['-lc', 'echo a'], { writeScript })
      expect(out.bin).toBe(SHELLS.cmd)
      expect(out.args).toEqual(['/d', '/s', '/c', `"echo ${escapeForCmd(LOW_INTEGRITY_BASH_REFUSAL)} 1>&2 & exit /b 1"`])
    }
    expect(writeScript).not.toHaveBeenCalled()
  })

  it('lays its options over the caller’s spawn options', () => {
    const wrapped: WrappedCommand = { bin: 'x', args: [], argv0: 'cmd', windowsVerbatimArguments: true, env: { TEMP } }
    expect(wrappedSpawnOptions(wrapped, { PATH: 'p' })).toEqual({
      env: { PATH: 'p', TEMP },
      argv0: 'cmd',
      windowsVerbatimArguments: true
    })
    expect(wrappedSpawnOptions({ bin: 'x', args: [] }, { PATH: 'p' })).toEqual({ env: { PATH: 'p' } })
  })
})

describe('resolveWindowsSandboxPolicy and its labels', () => {
  const HOME = 'C:\\Users\\me'
  const LOCAL = 'C:\\Users\\me\\AppData\\Local'
  const WS = 'D:\\code\\app'
  const UD = 'C:\\Users\\me\\AppData\\Roaming\\Vyotiq'

  const policy = resolveWindowsSandboxPolicy({
    workspaceRoots: [WS],
    cwd: WS,
    homeDir: HOME,
    localAppData: LOCAL,
    userDataDir: UD,
    network: 'allow',
    fs: fakeFs({
      dirs: [WS, `${WS}\\.git`, `${WS}\\.git\\hooks`, `${LOCAL}\\npm-cache`, `${LOCAL}\\pnpm\\store`, 'D:\\.pnpm-store', UD, `${HOME}\\.ssh`],
      files: { [`${WS}\\.git\\config`]: '[core]' }
    })
  })

  it('writes the workspace, its git dir, the low temp folder and the caches that exist', () => {
    expect(policy.rules.filter((r) => r.kind === 'write').map((r) => r.path)).toEqual([
      WS,
      `${WS}\\.git`,
      lowIntegrityTempDir(HOME),
      `${LOCAL}\\npm-cache`,
      `${LOCAL}\\pnpm\\store`,
      'D:\\.pnpm-store'
    ])
    expect(policy.rules.filter((r) => r.kind === 'read-only').map((r) => r.path)).toEqual([
      `${WS}\\.git\\hooks`,
      `${WS}\\.git\\config`
    ])
    expect(policy.rules.filter((r) => r.kind === 'hidden').map((r) => r.path)).toEqual([UD, `${HOME}\\.ssh`])
  })

  it('labels the writable folders low first, shallow to deep, then hooks and config medium', () => {
    const plan = windowsLabelPlan(policy)
    expect(plan.filter((l) => l.level === 'low').map((l) => l.path)[0]).toBe('D:\\.pnpm-store')
    expect(plan.slice(-2)).toEqual([
      { path: `${WS}\\.git\\hooks`, level: 'medium' },
      { path: `${WS}\\.git\\config`, level: 'medium' }
    ])
    // Hidden paths outside every writable folder are medium already.
    expect(plan.some((l) => l.path === UD || l.path === `${HOME}\\.ssh`)).toBe(false)
  })

  it('labels a hidden path medium when the workspace holds it', () => {
    const home = resolveWindowsSandboxPolicy({
      workspaceRoots: [HOME],
      cwd: HOME,
      homeDir: HOME,
      localAppData: null,
      userDataDir: null,
      network: 'allow',
      fs: fakeFs({ dirs: [HOME, `${HOME}\\.ssh`] })
    })
    expect(windowsLabelPlan(home)).toContainEqual({ path: `${HOME}\\.ssh`, level: 'medium' })
  })

  it('passes a folder’s label down to everything inside it, a file’s only to itself', () => {
    expect(icaclsLabelArgs({ path: WS, level: 'low' }, true)).toEqual([WS, '/setintegritylevel', '(OI)(CI)low', '/C', '/Q'])
    expect(icaclsLabelArgs({ path: `${WS}\\.git\\config`, level: 'medium' }, false)).toEqual([
      `${WS}\\.git\\config`,
      '/setintegritylevel',
      'medium',
      '/C',
      '/Q'
    ])
  })

  it('compares Windows paths without case', () => {
    expect(windowsPathInside('C:\\Users\\Me', 'c:\\users\\me\\.ssh')).toBe(true)
    expect(windowsPathInside('C:\\Users\\Me', 'C:\\Users\\Mee')).toBe(false)
  })
})

describe.skipIf(process.platform !== 'win32')('applyWindowsLabels and restoreWindowsLabels', () => {
  let root = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vyotiq-win-labels-'))
  })
  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true })
  })

  it('labels each path once and remembers it, and refuses on the first failure', async () => {
    const ud = join(root, 'ud')
    const home = join(root, 'home')
    const ws = join(root, 'ws')
    mkdirSync(ws, { recursive: true })
    const run = vi.fn(async () => ({ ok: true, detail: '' }))
    const plan = [{ path: ws, level: 'low' as const }, { path: join(root, 'missing'), level: 'low' as const }]

    await applyWindowsLabels(ud, home, plan, run)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith([ws, '/setintegritylevel', '(OI)(CI)low', '/C', '/Q'])
    expect(existsSync(lowIntegrityTempDir(home))).toBe(true)

    await applyWindowsLabels(ud, home, plan, run)
    expect(run).toHaveBeenCalledTimes(1)

    const failing = vi.fn(async () => ({ ok: false, detail: 'Access is denied.' }))
    const other = join(root, 'other')
    mkdirSync(other)
    await expect(applyWindowsLabels(ud, home, [{ path: other, level: 'low' }], failing)).rejects.toThrow(
      `could not label ${other} for the sandbox: Access is denied.`
    )
  })

  it.skipIf(process.platform !== 'win32')('labels a folder again when it was made anew at the same path', async () => {
    const ud = join(root, 'ud')
    const home = join(root, 'home')
    const ws = join(root, 'ws')
    mkdirSync(ws, { recursive: true })
    const run = vi.fn(async () => ({ ok: true, detail: '' }))
    await applyWindowsLabels(ud, home, [{ path: ws, level: 'low' }], run)
    rmSync(ws, { recursive: true, force: true })
    await new Promise((r) => setTimeout(r, 20))
    mkdirSync(ws)
    await applyWindowsLabels(ud, home, [{ path: ws, level: 'low' }], run)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('puts the low labels back to medium when the sandbox is turned off', async () => {
    const ud = join(root, 'ud')
    const ws = join(root, 'ws')
    const config = join(ws, 'config')
    mkdirSync(ws, { recursive: true })
    writeFileSync(config, 'x')
    const run = vi.fn(async () => ({ ok: true, detail: '' }))
    await applyWindowsLabels(ud, join(root, 'home'), [
      { path: ws, level: 'low' },
      { path: config, level: 'medium' }
    ], run)
    run.mockClear()

    await restoreWindowsLabels(ud, run)
    expect(run.mock.calls).toEqual([[[ws, '/setintegritylevel', '(OI)(CI)medium', '/C', '/Q']]])
    expect(JSON.parse(readFileSync(win32.join(ud, 'sandbox', 'labels.json'), 'utf8'))).toEqual({})
  })

  it('puts back only a removed workspace’s labels, and remembers the rest', async () => {
    // A removed workspace kept its low label, writable by any low-integrity
    // process, until the sandbox setting itself was turned off.
    const ud = join(root, 'ud')
    const gone = join(root, 'gone')
    const kept = join(root, 'gone-not')
    mkdirSync(join(gone, 'src'), { recursive: true })
    mkdirSync(kept, { recursive: true })
    const run = vi.fn(async () => ({ ok: true, detail: '' }))
    await applyWindowsLabels(ud, join(root, 'home'), [
      { path: gone, level: 'low' },
      { path: kept, level: 'low' }
    ], run)
    run.mockClear()

    await restoreWindowsLabels(ud, run, gone)
    expect(run.mock.calls).toEqual([[[gone, '/setintegritylevel', '(OI)(CI)medium', '/C', '/Q']]])
    const left = JSON.parse(readFileSync(win32.join(ud, 'sandbox', 'labels.json'), 'utf8')) as Record<string, { path: string }>
    expect(Object.values(left).map((e) => e.path)).toEqual([kept])
  })
})

describe('prepareAgentSandbox on Windows', () => {
  const capability = {
    available: true,
    mechanism: 'low-integrity' as const,
    reason: null,
    executable: SHELLS.cmd,
    shells: SHELLS
  }
  const deps = {
    capability,
    platform: 'win32' as const,
    fs: fakeFs({ dirs: ['D:\\w'] }),
    homeDir: 'C:\\Users\\me',
    userDataDir: 'C:\\ud',
    localAppData: null
  }

  it('refuses Network: Deny rather than ignoring it', () => {
    const prepared = prepareAgentSandbox({ workspace: 'D:\\w', settings: { mode: 'workspace-write', network: 'deny' } }, deps)
    expect(prepared.state).toBe('unavailable')
    if (prepared.state !== 'unavailable') return
    expect(prepared.message).toContain(WINDOWS_NETWORK_DENY_REASON)
  })

  it('returns a low-integrity launch that labels before its first command', async () => {
    const prepared = prepareAgentSandbox({ workspace: 'D:\\w', settings: { mode: 'workspace-write', network: 'allow' } }, deps)
    expect(prepared.state).toBe('on')
    if (prepared.state !== 'on') return
    expect(prepared.launch.label).toBe('workspace-write via low integrity, network allowed')
    expect(prepared.launch.wrap('powershell', ['-Command', 'x']).bin).toBe(SHELLS.powershell)
    expect(typeof prepared.launch.ready).toBe('function')
  })

  it('refuses the command when getting ready fails', async () => {
    // A home folder that is a file: the low temp folder cannot be made inside it.
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-win-ready-'))
    const homeFile = join(root, 'home')
    writeFileSync(homeFile, 'not a folder')
    try {
      const prepared = await prepareAgentSandboxReady(
        { workspace: win32.join(root, 'ws'), settings: { mode: 'workspace-write', network: 'allow' } },
        { ...deps, fs: fakeFs({}), homeDir: homeFile, userDataDir: join(root, 'ud') }
      )
      expect(prepared.state).toBe('unavailable')
      if (prepared.state !== 'unavailable') return
      expect(prepared.message).toContain('Sandbox unavailable: this command was not run.')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

type Ran = { code: number | null; out: string; err: string }

/**
 * The environment a wrapped command runs in.
 *
 * `pnpm test:coverage` puts `NODE_V8_COVERAGE` in this process, and node writes
 * a coverage file of its own as it exits whenever it inherits that var. A
 * low-integrity child cannot write the folder the var names — the write fails
 * and takes the process down with exit code 1, after the command ran exactly as
 * asked, which reads as a broken sandbox rather than a broken harness. The
 * child is not what this file measures, so it runs without the var at all and
 * its exit code keeps meaning what the assertions say it means.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'NODE_V8_COVERAGE') continue
    env[key] = value
  }
  return env
}

function runWrapped(wrapped: WrappedCommand, cwd: string): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(wrapped.bin, wrapped.args, {
      cwd,
      windowsHide: true,
      ...wrappedSpawnOptions(wrapped, childEnv())
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('close', (code) => resolve({ code, out, err }))
  })
}

/** The real thing: copies, labels and commands on this machine. */
describe.skipIf(process.platform !== 'win32')('the low-integrity sandbox on this Windows machine', () => {
  let root = ''
  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true })
  })

  it('writes inside the workspace, is denied outside it and in git config, and passes arguments exactly', async () => {
    root = mkdtempSync(join(tmpdir(), 'vyotiq-win-sandbox-'))
    const ud = join(root, 'user data')
    const home = join(root, 'home')
    const ws = join(root, 'ws')
    const outside = join(root, 'outside')
    for (const dir of [ud, home, join(ws, '.git'), outside]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(ws, '.git', 'config'), '[core]\n')
    // LocalLow is labelled low by Windows; the test's stand-in has to be labelled by hand.
    mkdirSync(join(home, 'AppData', 'LocalLow'), { recursive: true })

    const shells = prepareLowIntegrityShells(ud)
    expect(shells.ok ? 'ok' : shells.detail).toBe('ok')
    if (!shells.ok) return
    const policy = resolveWindowsSandboxPolicy({
      workspaceRoots: [ws],
      cwd: ws,
      homeDir: home,
      localAppData: null,
      userDataDir: ud,
      network: 'allow',
      fs: {
        exists: existsSync,
        realpath: (p) => p,
        isFile: (p) => {
          try {
            return readFileSync(p) !== null
          } catch {
            return false
          }
        },
        readText: (p) => {
          try {
            return readFileSync(p, 'utf8')
          } catch {
            return null
          }
        }
      }
    })
    await applyWindowsLabels(ud, home, windowsLabelPlan(policy))
    const wrap = (bin: string, args: string[]): WrappedCommand =>
      lowIntegrityArgv(shells.shells, lowIntegrityTempDir(home), bin, args, {
        writeScript: () => {
          throw new Error('no script expected')
        }
      })

    const inside = await runWrapped(wrap('cmd.exe', ['/c', 'echo in> inside.txt']), ws)
    expect(inside.code).toBe(0)
    expect(readFileSync(join(ws, 'inside.txt'), 'utf8').trim()).toBe('in')

    const denied = await runWrapped(wrap('cmd.exe', ['/c', `echo out> "${join(outside, 'x.txt')}"`]), ws)
    expect(denied.code).not.toBe(0)
    expect(existsSync(join(outside, 'x.txt'))).toBe(false)

    const config = await runWrapped(wrap('cmd.exe', ['/c', 'echo evil>> .git\\config']), ws)
    expect(config.code).not.toBe(0)
    expect(readFileSync(join(ws, '.git', 'config'), 'utf8')).toBe('[core]\n')

    if (shells.shells.powershell) {
      const ps = await runWrapped(
        wrap('powershell', ['-NoProfile', '-NonInteractive', '-Command', "Set-Content ps.txt 'one'\nexit 3"]),
        ws
      )
      expect(ps.code).toBe(3)
      expect(readFileSync(join(ws, 'ps.txt'), 'utf8').trim()).toBe('one')
    }

    const tricky = ['a b', 'say "hi"', 'x & y | z', '%PATH%', 'C:\\dir with space\\', '']
    const echoed = await runWrapped(
      wrap(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...tricky]),
      ws
    )
    expect(echoed.code, echoed.err).toBe(0)
    expect(JSON.parse(echoed.out)).toEqual(tricky)
  }, 60_000)
})
