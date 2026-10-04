import { execFile as execFileCb } from 'child_process'
import { createHash } from 'crypto'
import { readFileSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
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
 * The network and write commands the app runs reach further: fetch and push
 * run `core.sshCommand`, `core.gitProxy`, `credential.helper`, `core.askPass`,
 * a remote's `uploadpack`/`receivepack` and `core.alternateRefsCommand`, a
 * signed commit or `log.showSignature` runs `gpg.*program`, a commit runs the
 * hooks under `core.hooksPath`, and `protocol.ext.allow` lets a remote URL be
 * a shell command. Included files (`include.path`, `includeIf`) report the
 * scope of the file that included them, so a repo's include is the repo's.
 *
 * Every git command the app runs itself goes through `guardGitInvocation`,
 * which switches those settings off unless the person allowed this exact set
 * for this repository. Settings from the user's own global or system config
 * (git-lfs, say) are theirs and never touched: where a repo setting replaces
 * one of theirs, the override puts theirs back. The agent's terminal is not
 * guarded: those are the agent's commands, and approvals cover them.
 *
 * Not covered, on purpose: `.git/hooks` itself (the app's commit runs the
 * repo's hooks the way git does; only a `core.hooksPath` leading out of the
 * repository is switched off), and `core.editor`/`core.pager`, which git only
 * starts on a terminal the app never gives it. `uploadpack.packObjectsHook`
 * is ignored by git itself in repository config.
 */

/** A repo-scoped setting that names a program. */
export type RepoCommand = { key: string; value: string }

type GitConfigRecord = { scope: string; origin: string; key: string; value: string | null }

/**
 * How one setting is switched off. `special` marks the ones `-c` cannot
 * override on its own: credential helpers are a list (rebuilt whole),
 * `core.gitProxy` keeps its first value (the environment wins instead), a
 * remote's pack programs keep their first value (flags and no local transport),
 * and `core.sshCommand` with nothing of the user's to put back defers to the
 * environment's `GIT_SSH`.
 */
type Neutralizer = {
  config: Array<[string, string]>
  diffFlags: boolean
  special?: 'credential' | 'gitProxy' | 'packPrograms' | 'sshDefault'
}

type RepoCommandScan = {
  /** Whether git found a repository here at all. */
  inRepo: boolean
  /** The repository's shared git dir — the same for all of its worktrees. */
  trustKey: string | null
  blocked: RepoCommand[]
  fingerprint: string
  config: Array<[string, string]>
  diffFlags: boolean
  /** Specials from `Neutralizer`, applied at call time. */
  gitProxyOff: boolean
  packPrograms: boolean
  sshDefault: boolean
  /** Files whose change means the scan is stale. */
  watch: string[]
}

/** Looks up the user's own (system, global or command-line) value: the last one among `keys`. */
type Inherited = (...keys: string[]) => string | undefined

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
 * A bare program name, such as `manager`, `gpg2` or `plink`: git finds it on
 * PATH (or as `git credential-<name>`), so it is installed software, not
 * something that came with the folder. A path, arguments or shell syntax are not.
 */
function isBareProgramName(value: string): boolean {
  return /^[A-Za-z0-9][\w.+-]*$/.test(value.trim())
}

const NO_INHERITED: Inherited = () => undefined

/** gpg programs and what git runs when none is set. */
const GPG_PROGRAMS: Record<string, { keys: string[]; fallback: string }> = {
  'gpg.program': { keys: ['gpg.program', 'gpg.openpgp.program'], fallback: 'gpg' },
  'gpg.openpgp.program': { keys: ['gpg.program', 'gpg.openpgp.program'], fallback: 'gpg' },
  'gpg.x509.program': { keys: ['gpg.x509.program'], fallback: 'gpgsm' },
  'gpg.ssh.program': { keys: ['gpg.ssh.program'], fallback: 'ssh-keygen' }
}

/**
 * Prints nothing, whatever argument git appends: no alternate's refs are
 * offered as "haves", which only costs a fetch some efficiency.
 */
const NEUTRAL_ALTERNATE_REFS = 'true #'

/**
 * How to switch one setting off, or null when it runs nothing. Section and
 * variable names arrive lowercased from git; the driver name keeps its case.
 * Empty filter commands mean "no filter", but an empty diff program makes git
 * fail to spawn "", so diff programs are switched off with flags instead.
 * `inherited` finds the user's own value to put back where git keeps one.
 */
export function neutralizerFor(
  key: string,
  value: string | null,
  inherited: Inherited = NO_INHERITED
): Neutralizer | null {
  if (key === 'credential.helper' || /^credential\..+\.helper$/.test(key)) {
    // Empty resets the list; a bare name is `git credential-<name>`.
    if (value === null || value.trim() === '' || isBareProgramName(value)) return null
    return { config: [], diffFlags: false, special: 'credential' }
  }
  if (key === 'core.sshcommand') {
    if (value === null || isBareProgramName(value)) return null
    const own = inherited('core.sshcommand')
    return own === undefined
      ? { config: [], diffFlags: false, special: 'sshDefault' }
      : { config: [['core.sshCommand', own]], diffFlags: false }
  }
  if (key === 'core.askpass') {
    if (value === null || value.trim() === '' || isBareProgramName(value)) return null
    // Empty means no askpass program; the app never prompts anyway.
    return { config: [['core.askPass', inherited('core.askpass') ?? '']], diffFlags: false }
  }
  if (key === 'core.gitproxy') {
    // `command [for domain]`; "none" turns the proxy off.
    const command = value?.trim().split(/\s+for\s+/i)[0]?.trim() ?? ''
    if (!command || command.toLowerCase() === 'none' || isBareProgramName(command)) return null
    return { config: [], diffFlags: false, special: 'gitProxy' }
  }
  const gpg = GPG_PROGRAMS[key]
  if (gpg) {
    if (value === null || value.trim() === '' || isBareProgramName(value)) return null
    const program = inherited(...gpg.keys) ?? gpg.fallback
    return { config: gpg.keys.map((k): [string, string] => [k, program]), diffFlags: false }
  }
  if (key === 'gpg.ssh.defaultkeycommand') {
    if (value === null || value.trim() === '') return null
    return { config: [['gpg.ssh.defaultKeyCommand', inherited(key) ?? '']], diffFlags: false }
  }
  if (key === 'core.alternaterefscommand') {
    if (value === null || value.trim() === '') return null
    return { config: [['core.alternateRefsCommand', inherited(key) ?? NEUTRAL_ALTERNATE_REFS]], diffFlags: false }
  }
  if (/^remote\..+\.(uploadpack|receivepack)$/.test(key)) {
    if (value === null || isBareProgramName(value)) return null
    return { config: [], diffFlags: false, special: 'packPrograms' }
  }
  if (key === 'protocol.allow' || key === 'protocol.ext.allow') {
    // `ext::` runs its URL as a command; git's own default for it is never.
    if (value === null || value.trim().toLowerCase() === 'never') return null
    return { config: [['protocol.ext.allow', 'never']], diffFlags: false }
  }
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

/** `workTree` is the checkout git found the repository from; null for a bare one. */
type GitDirs = { gitDir: string; commonDir: string; workTree?: string | null }

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
    if (isDir(dotGit)) return { gitDir: dotGit, commonDir: dotGit, workTree: dir }
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
      return { gitDir, commonDir, workTree: dir }
    }
    if (isFile(join(dir, 'HEAD')) && isDir(join(dir, 'objects')) && isDir(join(dir, 'refs'))) {
      return { gitDir: dir, commonDir: dir, workTree: null }
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

/**
 * One key per repository, whichever way its path is spelled. A repository
 * found from the caller's path keeps that spelling, while a worktree's git
 * dir comes from the pointer git wrote, which is the real path: /var against
 * /private/var on macOS, a long name against an 8.3 short one on Windows.
 * Without the real path a worktree would not share its repository's allowance.
 */
function trustKeyOf(dir: string): string {
  let real = resolve(dir)
  try {
    real = realpathSync.native(real)
  } catch {
    // A directory that is gone keeps its resolved spelling.
  }
  const normalized = real.replace(/[\\/]+$/, '')
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

/**
 * The path as the filesystem sees it. A hooks path need not exist yet, so
 * realpath the deepest part that does and put the rest back on the end:
 * comparing it against a real root otherwise spells one side through an alias
 * (`/var` for `/private/var`, a Windows runner's 8.3 TEMP) and the other not,
 * and a folder inside the repository reads as outside it.
 */
function realOrResolved(path: string): string {
  const resolved = resolve(path)
  let dir = resolved
  const tail: string[] = []
  for (;;) {
    try {
      return tail.length === 0 ? realpathSync.native(dir) : join(realpathSync.native(dir), ...tail)
    } catch {
      const parent = dirname(dir)
      if (parent === dir) return resolved
      tail.unshift(basename(dir))
      dir = parent
    }
  }
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Whether a repo-set `core.hooksPath` leads out of the repository: its git
 * dirs and checkouts. Hooks inside it came with the folder the way
 * `.git/hooks` does (husky's `.husky/_`, say) and run like those; one
 * elsewhere — another folder, a network share — is the repo reaching out.
 */
export function hooksPathLeavesRepo(value: string, dirs: GitDirs): boolean {
  const raw = value.trim()
  if (!raw) return false
  // `%(prefix)/` is git's install; `~` is the user's home: neither is the repo's.
  if (raw.startsWith('%(prefix)')) return true
  const expanded = /^~(?=[\\/]|$)/.test(raw) ? join(homedir(), raw.slice(1)) : raw
  const base = dirs.workTree ?? dirs.gitDir
  const target = realOrResolved(isAbsolute(expanded) ? expanded : resolve(base, expanded))
  const roots = [dirs.gitDir, dirs.commonDir, dirs.workTree ?? null]
  if (basename(dirs.commonDir) === '.git') roots.push(dirname(dirs.commonDir))
  return !roots.some((root) => root != null && isInside(realOrResolved(root), target))
}

function isCredentialHelperKey(key: string): boolean {
  return key === 'credential.helper' || /^credential\..+\.helper$/.test(key)
}

/** Build the scan from a config listing. Exported for tests. */
export function scanFromConfigList(out: string, cwd: string, dirs: GitDirs | null): RepoCommandScan {
  const records = parseGitConfigList(out)
  const inherited: Inherited = (...keys) => {
    let found: string | undefined
    for (const record of records) {
      if (!REPO_SCOPES.has(record.scope) && record.value !== null && keys.includes(record.key)) found = record.value
    }
    return found
  }
  const blocked: RepoCommand[] = []
  const blockedRecords = new Set<GitConfigRecord>()
  const config = new Map<string, string>()
  let diffFlags = false
  let credential = false
  let gitProxyOff = false
  let packPrograms = false
  let sshDefault = false
  const watch = new Set<string>()
  let firstLocalConfig: string | null = null
  for (const record of records) {
    if (!REPO_SCOPES.has(record.scope)) continue
    const origin = originPath(record.origin, cwd)
    if (origin) {
      watch.add(origin)
      if (!firstLocalConfig && record.scope === 'local' && basename(origin) === 'config') {
        firstLocalConfig = origin
      }
    }
    let neutral: Neutralizer | null
    if (record.key === 'core.hookspath') {
      neutral =
        dirs && record.value !== null && hooksPathLeavesRepo(record.value, dirs)
          ? { config: [['core.hooksPath', inherited('core.hookspath') ?? join(dirs.commonDir, 'hooks')]], diffFlags: false }
          : null
    } else {
      neutral = neutralizerFor(record.key, record.value, inherited)
    }
    if (!neutral) continue
    blocked.push({ key: record.key, value: record.value ?? '' })
    blockedRecords.add(record)
    for (const [key, value] of neutral.config) config.set(key, value)
    diffFlags ||= neutral.diffFlags
    credential ||= neutral.special === 'credential'
    gitProxyOff ||= neutral.special === 'gitProxy'
    packPrograms ||= neutral.special === 'packPrograms'
    sshDefault ||= neutral.special === 'sshDefault'
  }
  if (dirs) for (const file of repoFiles(dirs)) watch.add(file)
  const trustRoot = dirs?.commonDir ?? (firstLocalConfig ? dirname(firstLocalConfig) : null)
  // Helpers are a list, and an empty value empties it: empty it, then
  // rebuild it in git's own order without the blocked ones, so the user's
  // helpers (URL-scoped ones under their own keys) work as before.
  const helpers: Array<[string, string]> = []
  if (credential) {
    helpers.push(['credential.helper', ''])
    for (const record of records) {
      if (isCredentialHelperKey(record.key) && record.value !== null && !blockedRecords.has(record)) {
        helpers.push([record.key, record.value])
      }
    }
  }
  if (packPrograms) config.set('protocol.file.allow', 'never')
  return {
    inRepo: true,
    trustKey: trustRoot ? trustKeyOf(trustRoot) : null,
    blocked,
    fingerprint: fingerprintOf(blocked),
    config: [...config.entries(), ...helpers],
    diffFlags,
    gitProxyOff,
    packPrograms,
    sshDefault,
    watch: [...watch]
  }
}

const EMPTY_SCAN: RepoCommandScan = {
  inRepo: false,
  trustKey: null,
  blocked: [],
  fingerprint: fingerprintOf([]),
  config: [],
  diffFlags: false,
  gitProxyOff: false,
  packPrograms: false,
  sshDefault: false,
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

/** Index of the subcommand: the first argument that is not a global option. */
function subcommandIndex(args: readonly string[]): number {
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
  return i
}

/** Insert `--no-ext-diff`/`--no-textconv` after the subcommand of a diff-producing call. */
export function withDiffProgramsOff(args: readonly string[]): string[] {
  const i = subcommandIndex(args)
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
 * Name git's own pack programs on a fetch or push: a remote's `uploadpack`
 * and `receivepack` keep their first value, so `-c` cannot replace a repo's.
 * A flag reaches only that one command, not the per-remote children of
 * `fetch --all`; `protocol.file.allow=never` stops those running a local one.
 */
export function withPackProgramsReset(args: readonly string[]): string[] {
  const i = subcommandIndex(args)
  const sub = args[i]
  const flag =
    sub === 'fetch' || sub === 'pull' || sub === 'ls-remote'
      ? '--upload-pack=git-upload-pack'
      : sub === 'push'
        ? '--receive-pack=git-receive-pack'
        : null
  if (!flag) return [...args]
  return [...args.slice(0, i + 1), flag, ...args.slice(i + 1)]
}

/** A value `sh` reads as one word. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
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
  if (!scan.inRepo || (scan.blocked.length > 0 && isAllowed(scan))) return { args: [...args], env: baseEnv }
  // `ext::` remotes stay off in every repository, whoever's config allows them.
  const env = withConfigEnv(baseEnv, [...scan.config, ['protocol.ext.allow', 'never']])
  if (scan.gitProxyOff && env.GIT_PROXY_COMMAND === undefined) env.GIT_PROXY_COMMAND = ''
  if (scan.sshDefault && env.GIT_SSH_COMMAND === undefined) {
    // The environment beats any config; GIT_SSH is what git would use next.
    env.GIT_SSH_COMMAND = env.GIT_SSH ? shellQuote(env.GIT_SSH) : 'ssh'
  }
  let guardedArgs = scan.diffFlags ? withDiffProgramsOff(args) : [...args]
  if (scan.packPrograms) guardedArgs = withPackProgramsReset(guardedArgs)
  return { args: guardedArgs, env }
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
