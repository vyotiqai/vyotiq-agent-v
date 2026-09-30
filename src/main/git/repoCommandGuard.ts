import { execFile as execFileCb } from 'child_process'
import { createHash } from 'crypto'
import { readFileSync, statSync } from 'fs'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { promisify } from 'util'
import { app } from 'electron'
import { atomicWriteJson } from '../storage/atomicWrite'

const execFile = promisify(execFileCb)

/**
 * A repository's own git config can name programs, and git runs them during
 * the plain reads the app does on its own: `status` runs `core.fsmonitor` and
 * every `filter.<driver>.clean`, `diff`/`log -p`/`blame` run `diff.external`
 * and `diff.<driver>.textconv`, and a merge runs `merge.<driver>.driver`. A
 * folder someone hands you is enough — its `.git/config` travels with it — so
 * opening it would run their code without a click.
 *
 * Every git command the app runs itself goes through `guardGitInvocation`,
 * which switches those settings off unless the person allowed this exact set
 * for this repository. Settings from the user's own global or system config
 * (git-lfs, say) are theirs and never touched. The agent's terminal is not
 * guarded: those are the agent's commands, and approvals cover them.
 */

/** A repo-scoped setting that names a program. */
export type RepoCommand = { key: string; value: string }

type GitConfigRecord = { scope: string; origin: string; key: string; value: string | null }

type Neutralizer = { config: Array<[string, string]>; diffFlags: boolean }

type RepoCommandScan = {
  /** The repository's shared git dir — the same for all of its worktrees. */
  trustKey: string | null
  blocked: RepoCommand[]
  fingerprint: string
  config: Array<[string, string]>
  diffFlags: boolean
  /** Files whose change means the scan is stale. */
  watch: string[]
}

const SCAN_TIMEOUT_MS = 10_000
const SCAN_MAX_BUFFER = 4 * 1024 * 1024
/** Backstop for what file stats cannot see, such as `includeIf "onbranch:"` after a checkout. */
const SCAN_TTL_MS = 60_000
/** Git's own three-way text merge, the result a merge gets without a custom driver. */
const NEUTRAL_MERGE_DRIVER = 'git merge-file %A %O %B'
const REPO_SCOPES = new Set(['local', 'worktree'])
const BOOLEAN_WORDS = new Set(['true', 'false', 'yes', 'no', 'on', 'off', '1', '0', ''])

/** Parse `git config --list --show-scope --show-origin -z`: `scope\0origin\0key[\nvalue]\0`. */
export function parseGitConfigList(out: string): GitConfigRecord[] {
  const parts = out.split('\0')
  const records: GitConfigRecord[] = []
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const entry = parts[i + 2]!
    const nl = entry.indexOf('\n')
    records.push({
      scope: parts[i]!,
      origin: parts[i + 1]!,
      key: nl === -1 ? entry : entry.slice(0, nl),
      value: nl === -1 ? null : entry.slice(nl + 1)
    })
  }
  return records
}

/**
 * How to switch one setting off, or null when it runs nothing. Section and
 * variable names arrive lowercased from git; the driver name keeps its case.
 * Empty filter commands mean "no filter", but an empty diff program makes git
 * fail to spawn "", so diff programs are switched off with flags instead.
 */
export function neutralizerFor(key: string, value: string | null): Neutralizer | null {
  if (key === 'core.fsmonitor') {
    // A boolean selects git's built-in daemon, which is git's own code.
    if (value === null || BOOLEAN_WORDS.has(value.trim().toLowerCase())) return null
    return { config: [['core.fsmonitor', 'false']], diffFlags: false }
  }
  if (key === 'diff.external') return { config: [], diffFlags: true }
  const filter = /^filter\.(.+)\.(clean|smudge|process)$/.exec(key)
  if (filter) {
    return {
      config: [
        [key, ''],
        [`filter.${filter[1]}.required`, 'false']
      ],
      diffFlags: false
    }
  }
  if (/^diff\..+\.(textconv|command)$/.test(key)) return { config: [], diffFlags: true }
  if (/^merge\..+\.driver$/.test(key)) return { config: [[key, NEUTRAL_MERGE_DRIVER]], diffFlags: false }
  return null
}

type GitDirs = { gitDir: string; commonDir: string }

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Where git will find this directory's repository, the way git discovers it:
 * the nearest `.git` directory or `gitdir:` file, or a bare repository's own
 * layout. Null when git would find none — then it reads no repo config.
 */
export function resolveGitDirs(cwd: string): GitDirs | null {
  let dir = resolve(cwd)
  for (;;) {
    const dotGit = join(dir, '.git')
    if (isDir(dotGit)) return { gitDir: dotGit, commonDir: dotGit }
    if (isFile(dotGit)) {
      let pointer: RegExpExecArray | null = null
      try {
        pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'))
      } catch {
        pointer = null
      }
      if (!pointer) return null
      const gitDir = resolve(dir, pointer[1]!)
      let commonDir = gitDir
      try {
        const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim()
        if (common) commonDir = resolve(gitDir, common)
      } catch {
        // A main checkout's gitdir has no commondir file.
      }
      return { gitDir, commonDir }
    }
    if (isFile(join(dir, 'HEAD')) && isDir(join(dir, 'objects')) && isDir(join(dir, 'refs'))) {
      return { gitDir: dir, commonDir: dir }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** The repo's own config files, and HEAD for `includeIf "onbranch:"`. */
function repoFiles(dirs: GitDirs): string[] {
  return [join(dirs.commonDir, 'config'), join(dirs.gitDir, 'config.worktree'), join(dirs.gitDir, 'HEAD')]
}

function trustKeyOf(dir: string): string {
  const normalized = resolve(dir).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function originPath(origin: string, cwd: string): string | null {
  if (!origin.startsWith('file:')) return null
  const path = origin.slice('file:'.length)
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path)
}

function fingerprintOf(blocked: RepoCommand[]): string {
  const sorted = [...blocked].sort((a, b) =>
    a.key === b.key ? a.value.localeCompare(b.value) : a.key.localeCompare(b.key)
  )
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex')
}

/** Build the scan from a config listing. Exported for tests. */
export function scanFromConfigList(out: string, cwd: string, dirs: GitDirs | null): RepoCommandScan {
  const blocked: RepoCommand[] = []
  const config = new Map<string, string>()
  let diffFlags = false
  const watch = new Set<string>()
  let firstLocalConfig: string | null = null
  for (const record of parseGitConfigList(out)) {
    if (!REPO_SCOPES.has(record.scope)) continue
    const origin = originPath(record.origin, cwd)
    if (origin) {
      watch.add(origin)
      if (!firstLocalConfig && record.scope === 'local' && basename(origin) === 'config') {
        firstLocalConfig = origin
      }
    }
    const neutral = neutralizerFor(record.key, record.value)
    if (!neutral) continue
    blocked.push({ key: record.key, value: record.value ?? '' })
    for (const [key, value] of neutral.config) config.set(key, value)
    diffFlags ||= neutral.diffFlags
  }
  if (dirs) for (const file of repoFiles(dirs)) watch.add(file)
  const trustRoot = dirs?.commonDir ?? (firstLocalConfig ? dirname(firstLocalConfig) : null)
  return {
    trustKey: trustRoot ? trustKeyOf(trustRoot) : null,
    blocked,
    fingerprint: fingerprintOf(blocked),
    config: [...config.entries()],
    diffFlags,
    watch: [...watch]
  }
}

const EMPTY_SCAN: RepoCommandScan = {
  trustKey: null,
  blocked: [],
  fingerprint: fingerprintOf([]),
  config: [],
  diffFlags: false,
  watch: []
}

// ── Allowed repositories ────────────────────────────────────────────────────

type TrustFile = { version: 1; repos: Record<string, string> }

let trustCache: TrustFile | null = null

function trustPath(): string {
  return join(app.getPath('userData'), 'git-command-trust.json')
}

function readTrust(): TrustFile {
  if (trustCache) return trustCache
  try {
    const raw = JSON.parse(readFileSync(trustPath(), 'utf8')) as Partial<TrustFile>
    const repos: Record<string, string> = {}
    if (raw && raw.version === 1 && raw.repos && typeof raw.repos === 'object') {
      for (const [key, value] of Object.entries(raw.repos)) {
        if (typeof value === 'string') repos[key] = value
      }
    }
    trustCache = { version: 1, repos }
  } catch {
    // Missing or unreadable: nothing is allowed, which fails safe.
    trustCache = { version: 1, repos: {} }
  }
  return trustCache
}

function isAllowed(scan: RepoCommandScan): boolean {
  return scan.trustKey != null && readTrust().repos[scan.trustKey] === scan.fingerprint
}

// ── Scanning, cached per directory ──────────────────────────────────────────

type CacheEntry = { scan: RepoCommandScan; at: number; signature: string }

const scans = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<RepoCommandScan>>()

function signatureOf(files: readonly string[]): string {
  return files
    .map((file) => {
      try {
        const s = statSync(file)
        return `${file}:${s.mtimeMs}:${s.size}`
      } catch {
        return `${file}:-`
      }
    })
    .join('|')
}

/** Guard env without our own overrides, so a scan reads the repo's real settings. */
function scanEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  for (const name of Object.keys(env)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(name)) delete env[name]
  }
  return env
}

async function scanRepo(cwd: string, bin: string, baseEnv: NodeJS.ProcessEnv): Promise<RepoCommandScan> {
  const dirs = resolveGitDirs(cwd)
  if (!dirs && !baseEnv.GIT_DIR) return EMPTY_SCAN
  const { stdout } = await execFile(bin, ['config', '--list', '--show-scope', '--show-origin', '-z'], {
    cwd,
    encoding: 'utf8',
    timeout: SCAN_TIMEOUT_MS,
    maxBuffer: SCAN_MAX_BUFFER,
    windowsHide: true,
    env: scanEnv(baseEnv)
  })
  return scanFromConfigList(stdout, cwd, dirs)
}

async function currentScan(
  cwd: string,
  bin: string,
  baseEnv: NodeJS.ProcessEnv,
  fresh = false
): Promise<RepoCommandScan> {
  const key = resolve(cwd)
  const cached = scans.get(key)
  if (
    !fresh &&
    cached &&
    Date.now() - cached.at < SCAN_TTL_MS &&
    signatureOf(cached.scan.watch) === cached.signature
  ) {
    return cached.scan
  }
  const running = inflight.get(key)
  if (running && !fresh) return running
  const task = (async () => {
    // Stat before the read: a config write racing the scan must not be
    // cached as if the scan had seen it.
    const dirs = resolveGitDirs(cwd)
    const before = dirs ? signatureOf(repoFiles(dirs)) : ''
    const scan = await scanRepo(cwd, bin, baseEnv)
    const raced = dirs != null && signatureOf(repoFiles(dirs)) !== before
    if (!raced) scans.set(key, { scan, at: Date.now(), signature: signatureOf(scan.watch) })
    return scan
  })()
  inflight.set(key, task)
  try {
    return await task
  } finally {
    if (inflight.get(key) === task) inflight.delete(key)
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Add `pairs` as `GIT_CONFIG_*` entries after any the environment already holds. */
function withConfigEnv(env: NodeJS.ProcessEnv, pairs: Array<[string, string]>): NodeJS.ProcessEnv {
  if (pairs.length === 0) return env
  const existing = Number(env.GIT_CONFIG_COUNT)
  const start = Number.isInteger(existing) && existing > 0 ? existing : 0
  const next: NodeJS.ProcessEnv = { ...env }
  pairs.forEach(([key, value], i) => {
    next[`GIT_CONFIG_KEY_${start + i}`] = key
    next[`GIT_CONFIG_VALUE_${start + i}`] = value
  })
  next.GIT_CONFIG_COUNT = String(start + pairs.length)
  return next
}

/** Insert `--no-ext-diff`/`--no-textconv` after the subcommand of a diff-producing call. */
export function withDiffProgramsOff(args: readonly string[]): string[] {
  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (arg === '-c' || arg === '-C') {
      i += 2
      continue
    }
    if (arg.startsWith('-')) {
      i += 1
      continue
    }
    break
  }
  const sub = args[i]
  const flags =
    sub === 'diff' || sub === 'log' || sub === 'show'
      ? ['--no-ext-diff', '--no-textconv']
      : sub === 'blame'
        ? ['--no-textconv']
        : null
  if (!flags) return [...args]
  return [...args.slice(0, i + 1), ...flags, ...args.slice(i + 1)]
}

/**
 * The args and env for a git command the app runs itself in `cwd`: the
 * repository's programs switched off unless the person allowed them. Throws
 * when git cannot read the repo's config, as the command itself would.
 */
export async function guardGitInvocation(
  args: readonly string[],
  cwd: string,
  baseEnv: NodeJS.ProcessEnv,
  bin = 'git'
): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
  const scan = await currentScan(cwd, bin, baseEnv)
  if (scan.blocked.length === 0 || isAllowed(scan)) return { args: [...args], env: baseEnv }
  return {
    args: scan.diffFlags ? withDiffProgramsOff(args) : [...args],
    env: withConfigEnv(baseEnv, scan.config)
  }
}

/** What this repository's settings would run and the app skips, or null when nothing is skipped. */
export async function readBlockedRepoCommands(
  cwd: string,
  baseEnv: NodeJS.ProcessEnv,
  bin = 'git'
): Promise<{ blocked: RepoCommand[]; canAllow: boolean } | null> {
  const scan = await currentScan(cwd, bin, baseEnv)
  if (scan.blocked.length === 0 || isAllowed(scan)) return null
  return { blocked: scan.blocked, canAllow: scan.trustKey != null }
}

/**
 * Let the app's git run this repository's programs — exactly the set there
 * now. A later change to them is a different set and is switched off again.
 */
export async function allowRepoCommands(
  cwd: string,
  baseEnv: NodeJS.ProcessEnv,
  bin = 'git'
): Promise<{ allowed: number }> {
  const scan = await currentScan(cwd, bin, baseEnv, true)
  if (scan.blocked.length === 0) return { allowed: 0 }
  if (!scan.trustKey) throw new Error('Could not tell which repository this is, so nothing was allowed.')
  const trust = readTrust()
  const next: TrustFile = { version: 1, repos: { ...trust.repos, [scan.trustKey]: scan.fingerprint } }
  atomicWriteJson(trustPath(), next, 0o600)
  trustCache = next
  return { allowed: scan.blocked.length }
}

export function resetRepoCommandGuardForTests(): void {
  scans.clear()
  inflight.clear()
  trustCache = null
}
