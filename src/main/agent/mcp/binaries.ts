/**
 * Locate the binaries stdio MCP servers shell out to (`npx`, `uvx`, `git`).
 *
 * Two problems this solves:
 *
 * 1. A GUI app launched from Finder/Dock on macOS inherits a minimal
 *    `/usr/bin:/bin:/usr/sbin:/sbin` PATH — not the one from the user's shell
 *    profile. nvm's node and uv's `~/.local/bin` are invisible, so six of the
 *    bundled MCP packages die with `spawn uvx ENOENT` through no fault of the
 *    user. We recover the real PATH from a login shell once at startup.
 * 2. On Windows the executable is `npx.cmd`, not `npx`, so a plain existence
 *    check has to walk PATHEXT to tell "missing" from "named differently".
 *
 * Everything here is best-effort and never throws: a failed probe degrades to
 * the process PATH, which is what the app used before this existed.
 */
import { execFile } from 'child_process'
import { accessSync, constants, statSync } from 'fs'
import { homedir } from 'os'
import { delimiter, isAbsolute, join } from 'path'
import { logger } from '../../../shared/logger'
import type { McpRuntimeRequirement } from '../../../shared/ipc'

/** Where each requirement's binary is looked up, and how to install it. */
const REQUIREMENT_BINARIES: Record<McpRuntimeRequirement, { binary: string; installUrl: string }> = {
  node: { binary: 'npx', installUrl: 'https://nodejs.org/en/download' },
  uv: { binary: 'uvx', installUrl: 'https://docs.astral.sh/uv/getting-started/installation/' },
  git: { binary: 'git', installUrl: 'https://git-scm.com/downloads' }
}

export function mcpRequirementBinary(requirement: McpRuntimeRequirement): string {
  return REQUIREMENT_BINARIES[requirement].binary
}

export function mcpRequirementInstallUrl(requirement: McpRuntimeRequirement): string {
  return REQUIREMENT_BINARIES[requirement].installUrl
}

/**
 * Locations a package manager commonly installs into that a GUI PATH omits.
 * Appended after the real PATH, so a user's own choice always wins.
 */
function fallbackBinDirs(): string[] {
  if (process.platform === 'win32') return []
  const home = homedir()
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.local/bin'),
    join(home, '.cargo/bin'),
    join(home, '.bun/bin'),
    join(home, 'bin')
  ]
}

/** PATH recovered from the user's login shell; null until probed or on failure. */
let loginShellPath: string | null = null

/**
 * Ask the user's login shell for its PATH.
 *
 * macOS only: on Windows the system PATH is already inherited correctly, and on
 * Linux the desktop session exports the profile PATH. Bounded and best-effort —
 * a shell that hangs or prints noise costs us nothing but the default PATH.
 */
export async function primeLoginShellPath(): Promise<void> {
  if (process.platform !== 'darwin') return
  const shell = (process.env.SHELL ?? '').trim() || '/bin/zsh'
  await new Promise<void>((resolve) => {
    execFile(
      shell,
      ['-ilc', 'command echo "__VYOTIQ_PATH__:$PATH"'],
      { timeout: 4_000, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err) {
          logger.warn('Login shell PATH probe failed; using process PATH', {
            scope: 'mcp',
            shell,
            err: err.message
          })
          resolve()
          return
        }
        // Profiles print banners and MOTDs, so pick our marked line rather than
        // assuming the output is only the PATH.
        const line = stdout
          .split('\n')
          .map((l) => l.trim())
          .reverse()
          .find((l) => l.startsWith('__VYOTIQ_PATH__:'))
        const value = line?.slice('__VYOTIQ_PATH__:'.length).trim()
        if (value) {
          loginShellPath = value
          logger.info('Recovered login shell PATH for MCP child processes', {
            scope: 'mcp',
            entries: value.split(delimiter).length
          })
        }
        resolve()
      }
    )
  })
}

/**
 * Forget resolved locations. Call when the user may have just installed a
 * missing binary — otherwise "install uv, then Refresh" would keep reporting it
 * as missing for the rest of the session.
 */
export function clearMcpBinaryCache(): void {
  resolveCache.clear()
}

/** Reset probe state so tests do not leak PATH between cases. */
export function clearLoginShellPathForTests(): void {
  loginShellPath = null
  resolveCache.clear()
}

/** PATH used to spawn MCP children: process PATH, the login shell's, then fallbacks. */
export function mcpSearchPath(source: NodeJS.ProcessEnv = process.env): string {
  const base = source.PATH ?? source.Path ?? ''
  const parts = [base, loginShellPath ?? '']
    .flatMap((p) => p.split(delimiter))
    .map((p) => p.trim())
    .filter(Boolean)
  for (const dir of fallbackBinDirs()) {
    if (!parts.includes(dir)) parts.push(dir)
  }
  const seen = new Set<string>()
  return parts.filter((p) => (seen.has(p) ? false : (seen.add(p), true))).join(delimiter)
}

/** True when `path` is a real file the OS will run (not a directory). */
export function isExecutableMcpBinary(path: string): boolean {
  return isExecutableFile(path.trim())
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
  } catch {
    return false
  }
  if (process.platform === 'win32') return true
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Windows resolves `npx` through PATHEXT — `npx.cmd`, `npx.exe`, and so on. */
function candidateNames(command: string): string[] {
  if (process.platform !== 'win32') return [command]
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean)
  // An explicit extension is used as-is; otherwise try each PATHEXT variant.
  if (exts.some((e) => command.toLowerCase().endsWith(e.toLowerCase()))) return [command]
  return [command, ...exts.map((e) => `${command}${e}`)]
}

const resolveCache = new Map<string, string | null>()

/**
 * Absolute path to `command`, or null when it is not on the MCP search path.
 * An absolute or explicitly relative command is checked directly — those are
 * the user's own choice, not something to look up.
 */
export function resolveMcpBinary(
  command: string,
  source: NodeJS.ProcessEnv = process.env
): string | null {
  const name = command.trim()
  if (!name) return null

  if (isAbsolute(name) || name.startsWith('./') || name.startsWith('../')) {
    return isExecutableFile(name) ? name : null
  }

  const cached = resolveCache.get(name)
  if (cached !== undefined) return cached

  let found: string | null = null
  const dirs = mcpSearchPath(source).split(delimiter).filter(Boolean)
  outer: for (const dir of dirs) {
    for (const candidate of candidateNames(name)) {
      const full = join(dir, candidate)
      if (isExecutableFile(full)) {
        found = full
        break outer
      }
    }
  }
  resolveCache.set(name, found)
  return found
}

export type MissingMcpBinary = {
  /** The binary that could not be found, e.g. `uvx`. */
  binary: string
  /** The requirement it belongs to, when the manifest declared one. */
  requirement?: McpRuntimeRequirement
  installUrl?: string
}

/**
 * First unmet requirement for a stdio server, or null when it can be spawned.
 *
 * Checks the declared `requires` first so the message names the thing the user
 * actually needs to install ("uv"), then the launch command itself, which
 * covers manually added servers that declare nothing.
 */
export function findMissingMcpBinary(
  server: {
    command?: string
    requires?: McpRuntimeRequirement[]
    binaryPath?: string
  },
  source: NodeJS.ProcessEnv = process.env
): MissingMcpBinary | null {
  for (const requirement of server.requires ?? []) {
    const binary = mcpRequirementBinary(requirement)
    // A located binary satisfies only the requirement it implements.
    const satisfied =
      server.binaryPath && commandMatchesBinary(server.binaryPath, binary)
        ? isExecutableFile(server.binaryPath)
        : resolveMcpBinary(binary, source) !== null
    if (!satisfied) {
      return { binary, requirement, installUrl: mcpRequirementInstallUrl(requirement) }
    }
  }

  const command = (server.command ?? '').trim()
  if (!command) return null
  if (server.binaryPath && isExecutableFile(server.binaryPath)) return null
  if (resolveMcpBinary(command, source) !== null) return null
  return { binary: command }
}

/** True when an absolute path points at (a variant of) the named binary. */
function commandMatchesBinary(path: string, binary: string): boolean {
  const base = path.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  const target = binary.toLowerCase()
  return base === target || base.startsWith(`${target}.`)
}

export function missingMcpBinaryMessage(missing: MissingMcpBinary): string {
  const what = missing.requirement
    ? `${missing.binary} (${missing.requirement})`
    : missing.binary
  return (
    `${what} was not found on PATH, so this MCP server cannot start. ` +
    (missing.installUrl
      ? `Install it, or point Vyotiq at an existing copy.`
      : `Install it, or correct the command.`)
  )
}
