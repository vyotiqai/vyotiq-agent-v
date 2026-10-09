/**
 * The Windows command sandbox: low integrity.
 *
 * Windows starts a program at the lower of the user's integrity level and the
 * mandatory label on its executable file, and every child inherits it. A
 * low-integrity process cannot write anything labelled medium — which every
 * file is unless labelled otherwise. So a sandboxed command runs under a copy
 * of cmd.exe (or powershell.exe) whose file is labelled low, and the folders
 * it may write to (the workspace, a temp folder, the package caches that
 * exist) are labelled low first; git hooks and config inside them are
 * labelled medium again so they stay read-only.
 *
 * What it cannot do, and says so: block reads (a low process reads what a
 * medium one can) or the network, or run bash — Git Bash and WSL's launcher
 * both die at low integrity (MSYS cannot create its shared objects there), so
 * a bash command fails at once with the reason. Nothing here needs a native
 * dependency — only `icacls`, which ships with Windows.
 */
import { win32 } from 'path'
import { randomUUID } from 'crypto'
import type { AgentSandboxNetwork } from '../../../shared/ipc'
import type { SandboxFs, SandboxPolicy, SandboxRule, SandboxRuleKind } from './policy'
import type { WrappedCommand } from './wrap'

/** The SID of the low mandatory level, the same in every Windows language. */
export const LOW_INTEGRITY_SID = 'S-1-16-4096'

/** Where the low-labelled shell copies live, under the app's data folder. */
export function lowIntegrityShellPaths(userDataDir: string): { dir: string; cmd: string; powershell: string } {
  const dir = win32.join(userDataDir, 'sandbox')
  return { dir, cmd: win32.join(dir, 'cmd-low.exe'), powershell: win32.join(dir, 'powershell-low.exe') }
}

/**
 * The temp folder sandboxed commands get (TEMP and TMP point here). LocalLow
 * is labelled low by Windows itself, so a folder made inside it is too.
 */
export function lowIntegrityTempDir(homeDir: string): string {
  return win32.join(homeDir, 'AppData', 'LocalLow', 'Vyotiq', 'sandbox-temp')
}

/** Caches under %LOCALAPPDATA% a build or install writes to. */
const LOCAL_APPDATA_CACHE_DIRS = [
  'npm-cache',
  'pnpm\\store',
  'pnpm-cache',
  'Yarn\\Cache',
  'pip\\Cache',
  'go-build',
  'node-gyp\\Cache',
  'uv\\cache'
]

/** Caches under the home folder. */
const HOME_CACHE_DIRS = [
  '.pnpm-store',
  '.yarn\\berry\\cache',
  '.bun\\install\\cache',
  '.cargo\\registry',
  '.cargo\\git',
  'go\\pkg\\mod',
  '.gradle\\caches',
  '.m2\\repository'
]

const HIDDEN_HOME_DIRS = ['.ssh']

function trimSep(path: string): string {
  return path.length > 3 ? path.replace(/[\\/]+$/, '') : path
}

/** Case-insensitive "is `child` the same as or inside `parent`" for Windows paths. */
export function windowsPathInside(parent: string, child: string): boolean {
  const p = trimSep(win32.resolve(parent)).toLowerCase()
  const c = trimSep(win32.resolve(child)).toLowerCase()
  return c === p || c.startsWith(p.endsWith('\\') ? p : `${p}\\`)
}

/** A workspace's git dirs, as policy.ts reads them, with Windows paths. */
function windowsGitDirs(root: string, fs: SandboxFs): { gitDir: string; commonDir: string } | null {
  const dotGit = win32.join(root, '.git')
  if (!fs.exists(dotGit)) return null
  if (!fs.isFile(dotGit)) return { gitDir: dotGit, commonDir: dotGit }
  const text = fs.readText(dotGit)
  const match = text ? /^gitdir:\s*(.+?)\s*$/m.exec(text) : null
  if (!match?.[1]) return null
  const gitDir = win32.resolve(root, match[1])
  const common = fs.readText(win32.join(gitDir, 'commondir'))?.trim()
  return { gitDir, commonDir: common ? win32.resolve(gitDir, common) : gitDir }
}

export type ResolveWindowsSandboxPolicyInput = {
  workspaceRoots: readonly string[]
  cwd: string
  homeDir: string
  /** %LOCALAPPDATA%; null when unknown. */
  localAppData: string | null
  userDataDir: string | null
  network: AgentSandboxNetwork
  fs: SandboxFs
}

/**
 * The same rules policy.ts builds for macOS and Linux, with Windows paths:
 * the workspace, its git dirs, the low temp folder and existing caches are
 * writable; git hooks and config are read-only. "Hidden" paths stay in the
 * list for the record, but low integrity cannot hide them from reads; where
 * one sits inside a writable folder it is labelled medium so it stays
 * unwritable.
 */
export function resolveWindowsSandboxPolicy(input: ResolveWindowsSandboxPolicyInput): SandboxPolicy {
  const { fs } = input
  const canon = (path: string): string => {
    try {
      return trimSep(fs.realpath(path))
    } catch {
      return trimSep(win32.resolve(path))
    }
  }
  const rules: SandboxRule[] = []
  const add = (kind: SandboxRuleKind, path: string, mustExist = true): void => {
    if (!path || (mustExist && !fs.exists(path))) return
    const canonical = canon(path)
    if (rules.some((r) => r.kind === kind && r.path.toLowerCase() === canonical.toLowerCase())) return
    rules.push({ kind, path: canonical })
  }
  for (const root of input.workspaceRoots) {
    add('write', root, false)
    const git = windowsGitDirs(canon(root), fs)
    if (git) {
      add('write', git.commonDir)
      if (git.gitDir.toLowerCase() !== git.commonDir.toLowerCase()) add('write', git.gitDir)
      add('read-only', win32.join(git.commonDir, 'hooks'))
      add('read-only', win32.join(git.commonDir, 'config'))
    }
  }
  add('write', lowIntegrityTempDir(input.homeDir), false)
  if (input.localAppData) {
    for (const rel of LOCAL_APPDATA_CACHE_DIRS) add('write', win32.join(input.localAppData, rel))
  }
  for (const rel of HOME_CACHE_DIRS) add('write', win32.join(input.homeDir, rel))
  // pnpm keeps its store on the project's drive, at its root, so it can hard-link.
  for (const root of input.workspaceRoots) {
    const drive = win32.parse(win32.resolve(root)).root
    if (drive) add('write', win32.join(drive, '.pnpm-store'))
  }
  if (input.userDataDir) add('hidden', input.userDataDir)
  for (const rel of HIDDEN_HOME_DIRS) add('hidden', win32.join(input.homeDir, rel))
  return { rules, network: input.network, cwd: canon(input.cwd) }
}

export type IntegrityLabel = { path: string; level: 'low' | 'medium' }

/**
 * The labels a policy needs, in the order to apply them: writable folders low
 * first, then the read-only paths inside them medium, so the deeper label is
 * the one that stays. A hidden path is labelled only when a writable folder
 * holds it — elsewhere it is medium already.
 */
export function windowsLabelPlan(policy: SandboxPolicy): IntegrityLabel[] {
  const writes = policy.rules.filter((r) => r.kind === 'write').map((r) => r.path)
  const depth = (p: string): number => p.split(/[\\/]+/).filter(Boolean).length
  const lows = [...writes].sort((a, b) => depth(a) - depth(b))
  const mediums = policy.rules
    .filter((r) => r.kind === 'read-only' || (r.kind === 'hidden' && writes.some((w) => windowsPathInside(w, r.path))))
    .map((r) => r.path)
    .sort((a, b) => depth(a) - depth(b))
  return [
    ...lows.map((path) => ({ path, level: 'low' as const })),
    ...mediums.map((path) => ({ path, level: 'medium' as const }))
  ]
}

/** The `icacls` argv that sets one label; folders pass it down to everything inside. */
export function icaclsLabelArgs(label: IntegrityLabel, isDirectory: boolean): string[] {
  const level = isDirectory ? `(OI)(CI)${label.level}` : label.level
  return [label.path, '/setintegritylevel', level, '/C', '/Q']
}

/**
 * Quote one argument the way the C runtime (and Node, through libuv) reads a
 * Windows command line: only when it needs quoting, backslashes doubled only
 * before a quote.
 */
export function quoteWindowsArg(arg: string): string {
  if (arg === '') return '""'
  if (!/[ \t"]/.test(arg)) return arg
  let out = '"'
  let backslashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1
      continue
    }
    if (ch === '"') {
      out += `${'\\'.repeat(backslashes * 2 + 1)}"`
    } else {
      out += `${'\\'.repeat(backslashes)}${ch}`
    }
    backslashes = 0
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`
}

/**
 * Escape a command line for `cmd /d /s /c "…"`: every character cmd treats
 * specially gets a caret, the quote too, so cmd never enters quote mode and
 * passes the program exactly the line it would have got unsandboxed. The
 * shape cross-spawn uses.
 */
export function escapeForCmd(line: string): string {
  return line.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1')
}

export type LowIntegrityShells = { cmd: string; powershell: string | null }

export type WindowsWrapDeps = {
  /** Write a script for a shell to run; returns its path. */
  writeScript: (extension: '.ps1', text: string) => string
}

/** What a bash command prints instead of running, at low integrity. */
export const LOW_INTEGRITY_BASH_REFUSAL =
  'Not run: the Windows sandbox runs commands at low integrity, where bash (Git Bash or WSL) cannot start. Set the agent shell to PowerShell or cmd in Settings > Tools > Terminal, or turn the sandbox off in Settings > Tools > Sandbox.'

function shellName(bin: string): string {
  return win32.basename(bin).toLowerCase().replace(/\.exe$/, '')
}

/**
 * Run `bin args` at low integrity. Windows PowerShell and cmd run from their
 * own low copies with their arguments untouched. Anything else runs through
 * the low cmd, whose command line cannot hold a newline and stops at 8,191
 * characters, so a PowerShell 7 script goes into a file first. bash cannot
 * start at low integrity: it becomes a command that says so and fails.
 */
export function lowIntegrityArgv(
  shells: LowIntegrityShells,
  tempDir: string,
  bin: string,
  args: readonly string[],
  deps: WindowsWrapDeps
): WrappedCommand {
  const env = { TEMP: tempDir, TMP: tempDir }
  const name = shellName(bin)
  if (name === 'powershell' && shells.powershell) return { bin: shells.powershell, args: [...args], env }
  if (name === 'cmd') return { bin: shells.cmd, args: [...args], env }
  if (name === 'bash' || name === 'sh' || name === 'wsl') {
    return {
      bin: shells.cmd,
      args: ['/d', '/s', '/c', `"echo ${escapeForCmd(LOW_INTEGRITY_BASH_REFUSAL)} 1>&2 & exit /b 1"`],
      argv0: 'cmd',
      windowsVerbatimArguments: true,
      env
    }
  }
  let finalArgs = [...args]
  if (name === 'pwsh') {
    const at = finalArgs.indexOf('-Command')
    const script = at >= 0 ? finalArgs[at + 1] : undefined
    if (script !== undefined) {
      const file = deps.writeScript('.ps1', script)
      finalArgs = [...finalArgs.slice(0, at), '-ExecutionPolicy', 'Bypass', '-File', file, ...finalArgs.slice(at + 2)]
    }
  }
  const line = [bin, ...finalArgs].map(quoteWindowsArg).join(' ')
  return {
    bin: shells.cmd,
    args: ['/d', '/s', '/c', `"${escapeForCmd(line)}"`],
    // The copy's own path may hold spaces; with verbatim arguments nothing would quote it.
    argv0: 'cmd',
    windowsVerbatimArguments: true,
    env
  }
}

/** A script file name no two commands share. */
export function sandboxScriptName(extension: '.ps1'): string {
  return `vyotiq-command-${randomUUID()}${extension}`
}
