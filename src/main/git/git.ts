import { execFile as execFileCb } from 'child_process'
import { existsSync, statSync, readFileSync, writeFileSync, mkdtempSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { promisify } from 'util'
import type {
  GitBlameLine,
  GitBlameResult,
  GitChangedFile,
  GitStatus,
  GitStatusResult
} from '../../shared/ipc'
import { namedGitBranch } from '../../shared/utils/gitBranch'
import { isSafeWorkspaceRelPath } from '../../shared/utils/workspacePath'
import { resolveInsideWorkspace } from '../workspace/safePath'
import { sanitizedTerminalEnv } from '../agent/tools/terminal'

const execFile = promisify(execFileCb)

const READ_TIMEOUT_MS = 5000
const WRITE_TIMEOUT_MS = 20_000
const PUSH_TIMEOUT_MS = 120_000
const MAX_BUFFER = 4 * 1024 * 1024
const GIT_PROBE_TTL_MS = 60_000

let gitBinaryCache: { ok: boolean; bin: string | null; checkedAt: number } | null = null

/**
 * Common Git for Windows install locations that are frequently missing from
 * PATH (winget/nsis per-user installs, scoop shims). Probing these keeps
 * git_status/git_diff/git_commit/worktrees functional without a machine-wide
 * PATH entry.
 */
function wellKnownGitBinaries(): string[] {
  if (process.platform !== 'win32') return []
  const out: string[] = []
  const programFiles = process.env['ProgramFiles']
  const programFilesX86 = process.env['ProgramFiles(x86)']
  const localAppData = process.env['LOCALAPPDATA']
  const userProfile = process.env['USERPROFILE']
  if (programFiles) out.push(join(programFiles, 'Git', 'cmd', 'git.exe'))
  if (programFilesX86) out.push(join(programFilesX86, 'Git', 'cmd', 'git.exe'))
  if (localAppData) out.push(join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe'))
  if (userProfile) out.push(join(userProfile, 'scoop', 'shims', 'git.exe'))
  return out
}

async function probeGitBinary(bin: string): Promise<boolean> {
  try {
    await execFile(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      env: buildGitEnv()
    })
    return true
  } catch {
    return false
  }
}

/**
 * Resolve a usable git binary: PATH first, then well-known Windows install
 * locations. Cached briefly so chrome does not spam `--version`.
 */
export async function resolveGitBinary(): Promise<string | null> {
  const now = Date.now()
  if (gitBinaryCache && now - gitBinaryCache.checkedAt < GIT_PROBE_TTL_MS) {
    return gitBinaryCache.ok ? gitBinaryCache.bin : null
  }
  if (await probeGitBinary('git')) {
    gitBinaryCache = { ok: true, bin: 'git', checkedAt: now }
    return 'git'
  }
  for (const candidate of wellKnownGitBinaries()) {
    if (!existsSync(candidate)) continue
    if (await probeGitBinary(candidate)) {
      gitBinaryCache = { ok: true, bin: candidate, checkedAt: now }
      return candidate
    }
  }
  gitBinaryCache = { ok: false, bin: null, checkedAt: now }
  return null
}

/** Whether a usable git binary was found (PATH or a known install location). */
export async function gitAvailable(): Promise<boolean> {
  return (await resolveGitBinary()) != null
}

/** @internal */
export function resetGitAvailableCacheForTests(): void {
  gitBinaryCache = null
}

/** Counting lines means reading the file, so only do it for plausible source. */
const UNTRACKED_LINE_COUNT_MAX_BYTES = 512 * 1024

/**
 * Git never runs interactively here. A credential or editor prompt in a process
 * with no terminal would hang until the timeout instead of failing cleanly.
 * Env matches terminal/MCP scrubbing so main-process secrets are not inherited.
 * `GIT_PAGER=cat` keeps `git log` / `git show` from blocking on a pager.
 */
function buildGitEnv(): NodeJS.ProcessEnv {
  return {
    ...sanitizedTerminalEnv(),
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GCM_INTERACTIVE: 'never',
    GIT_PAGER: 'cat'
  }
}

/**
 * Git discovers the nearest ancestor .git from cwd; match that here, or a
 * workspace opened at a repo subdirectory is misreported as a non-repo.
 * A `.git` file (git worktree checkout) counts too.
 */
export function isGitRepo(cwd: string): boolean {
  let dir = resolve(cwd)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/** Current local branch, or null for a detached HEAD / non-repository. */
export async function currentGitBranch(cwd: string): Promise<string | null> {
  if (!isGitRepo(cwd)) return null
  const raw = await gitQuiet(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd, READ_TIMEOUT_MS)
  const branch = raw?.trim()
  return branch || null
}

/** Whether the repository has at least one commit. */
export async function hasGitCommits(cwd: string): Promise<boolean> {
  if (!isGitRepo(cwd)) return false
  return (await gitQuiet(['rev-parse', '--verify', 'HEAD'], cwd, READ_TIMEOUT_MS)) != null
}

async function git(args: string[], cwd: string, timeout: number): Promise<string> {
  // Use the resolved binary so installs missing from PATH still work.
  const bin = (await resolveGitBinary()) ?? 'git'
  const { stdout } = await execFile(bin, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    env: buildGitEnv()
  })
  return stdout
}

/**
 * Like `git`, but keeps stdout when the process exits 1.
 * `git diff --no-index` implies `--exit-code` and exits 1 whenever the files differ
 * (see git-diff docs) — that is success for our purposes.
 */
async function gitDiffStdout(args: string[], cwd: string, timeout: number): Promise<string> {
  try {
    return await git(args, cwd, timeout)
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: unknown }).code === 1 &&
      'stdout' in err &&
      typeof (err as { stdout?: unknown }).stdout === 'string'
    ) {
      return (err as { stdout: string }).stdout
    }
    throw err
  }
}

async function gitQuiet(args: string[], cwd: string, timeout: number): Promise<string | null> {
  try {
    return await git(args, cwd, timeout)
  } catch {
    return null
  }
}

/**
 * Apply a unified diff to the workspace via `git apply` (or `--check` for a dry
 * run). The patch is written to a temp file so git parses it the same way it
 * would from disk. Fails when not a git repo or the patch does not apply.
 */
export async function applyGitPatch(
  cwd: string,
  patch: string,
  opts: { check?: boolean }
): Promise<{ ok: boolean; error?: string; applied?: string[] }> {
  if (patch.trim().length === 0) return { ok: false, error: 'Empty patch' }
  if (!isGitRepo(cwd)) return { ok: false, error: 'Not a git repository' }
  const tmp = join(mkdtempSync(join(tmpdir(), 'vyotiq-patch-')), 'patch.diff')
  writeFileSync(tmp, patch, 'utf8')
  const args = opts.check
    ? ['apply', '--check', '--whitespace=nowarn', tmp]
    : ['apply', '--whitespace=nowarn', tmp]
  try {
    await git(args, cwd, WRITE_TIMEOUT_MS)
    return { ok: true, applied: [] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message || 'git apply failed' }
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      // best-effort cleanup
    }
  }
}

/** Split NUL-delimited git output, dropping the trailing empty field. */
function splitNul(out: string): string[] {
  return out.split('\0').filter((part) => part.length > 0)
}

const GIT_OBJECT_ID_RE = /^[0-9a-fA-F]{7,64}$/

/** Accept only hex object ids so values like `--output=` cannot become git options. */
export function parseGitObjectId(raw: string | null | undefined): string | null {
  const sha = raw?.trim() ?? ''
  return GIT_OBJECT_ID_RE.test(sha) ? sha : null
}

function countFileLines(cwd: string, relPath: string): number {
  try {
    // Directory placeholders from `git status -unormal` (e.g. `node_modules/`).
    if (relPath.endsWith('/') || relPath.endsWith('\\')) return 0
    const full = resolveInsideWorkspace(cwd, relPath)
    const stat = statSync(full)
    if (!stat.isFile() || stat.size > UNTRACKED_LINE_COUNT_MAX_BYTES) return 0
    const text = readFileSync(full, 'utf8')
    if (!text) return 0
    const lines = text.split('\n')
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    return lines.length
  } catch {
    return 0
  }
}

/** Skip sync reads for dependency trees and other junk that blows up chrome status. */
function shouldCountUntrackedLines(relPath: string): boolean {
  if (relPath.endsWith('/') || relPath.endsWith('\\')) return false
  return !isNoisePath(relPath)
}

/** Paths we never surface in status chrome (untracked dependency / build trees). */
function isNoisePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').toLowerCase()
  const parts = normalized.split('/')
  for (const part of parts) {
    if (
      part === 'node_modules' ||
      part === '.git' ||
      part === 'dist' ||
      part === 'build' ||
      part === 'coverage' ||
      part === '.next' ||
      part === 'target' ||
      part === '__pycache__'
    ) {
      return true
    }
  }
  return false
}

/**
 * Parse `git diff --numstat -z` into path → line deltas.
 */
async function numstatMap(cwd: string, args: string[]): Promise<Map<string, {
  added: number
  removed: number
  binary: boolean
}>> {
  const out = new Map<string, { added: number; removed: number; binary: boolean }>()
  const stdout = await gitQuiet(args, cwd, READ_TIMEOUT_MS)
  if (!stdout) return out
  for (const record of splitNul(stdout)) {
    const parts = record.split('\t')
    if (parts.length < 3) continue
    const [addedRaw, removedRaw, path] = parts as [string, string, string]
    const added = addedRaw === '-' ? 0 : Number(addedRaw)
    const removed = removedRaw === '-' ? 0 : Number(removedRaw)
    out.set(path, {
      added: Number.isFinite(added) ? added : 0,
      removed: Number.isFinite(removed) ? removed : 0,
      binary: addedRaw === '-'
    })
  }
  return out
}

function statusFor(code: string): GitChangedFile['status'] {
  if (code.includes('U') || code === 'AA' || code === 'DD') return 'conflicted'
  if (code.includes('D')) return 'deleted'
  if (code.includes('A')) return 'added'
  return 'modified'
}

/** Map porcelain XY columns to staged / unstaged sides. */
function flagsFromPorcelain(code: string): { staged: boolean; unstaged: boolean } {
  if (code === '??' || code === '!!') {
    return { staged: false, unstaged: true }
  }
  const x = code[0] ?? ' '
  const y = code[1] ?? ' '
  if (
    x === 'U' ||
    y === 'U' ||
    code === 'DD' ||
    code === 'AU' ||
    code === 'UD' ||
    code === 'UA' ||
    code === 'DU' ||
    code === 'AA'
  ) {
    return { staged: true, unstaged: true }
  }
  return { staged: x !== ' ', unstaged: y !== ' ' }
}

function emptyFile(path: string, status: GitChangedFile['status']): GitChangedFile {
  return {
    path,
    status,
    added: 0,
    removed: 0,
    addedStaged: 0,
    removedStaged: 0,
    addedUnstaged: 0,
    removedUnstaged: 0,
    binary: false,
    staged: false,
    unstaged: false
  }
}

export async function readGitStatus(cwd: string): Promise<GitStatusResult> {
  if (!(await gitAvailable())) {
    return { kind: 'unavailable', detail: 'Git is not installed or not on PATH' }
  }
  if (!isGitRepo(cwd)) return { kind: 'not_repo' }

  const branchRaw = await gitQuiet(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, READ_TIMEOUT_MS)
  const branch = namedGitBranch(branchRaw)
  const hasCommits = await hasGitCommits(cwd)

  const stagedArgs = hasCommits
    ? ['diff', '--numstat', '--no-renames', '-z', '--cached', 'HEAD']
    : ['diff', '--numstat', '--no-renames', '-z', '--cached']
  const unstagedArgs = ['diff', '--numstat', '--no-renames', '-z']
  const [stagedMap, unstagedMap] = await Promise.all([
    numstatMap(cwd, stagedArgs),
    numstatMap(cwd, unstagedArgs)
  ])

  const tracked = new Map<string, GitChangedFile>()
  const ensure = (path: string, status: GitChangedFile['status'] = 'modified'): GitChangedFile => {
    let file = tracked.get(path)
    if (!file) {
      file = emptyFile(path, status)
      tracked.set(path, file)
    }
    return file
  }

  for (const [path, delta] of stagedMap) {
    const file = ensure(path)
    file.addedStaged = delta.added
    file.removedStaged = delta.removed
    file.binary = file.binary || delta.binary
  }
  for (const [path, delta] of unstagedMap) {
    const file = ensure(path)
    file.addedUnstaged = delta.added
    file.removedUnstaged = delta.removed
    file.binary = file.binary || delta.binary
  }

  // Prefer `-uall` so real project files under new dirs stay visible (e.g. `sub/new.txt`).
  // Skip dependency trees — home workspace had 637× `node_modules/**` untracked with no
  // .gitignore; sync line-counting them made git:status multi-second under startup load.
  // `--no-renames`: porcelain -z rename/copy records are two NUL fields
  // (`R new\0old\0`); without this, the old path is parsed as `XY + path`
  // and invents ghosts like `.txt` from `old.txt`.
  const porcelain = await gitQuiet(
    ['status', '--porcelain=v1', '-z', '-uall', '--no-renames'],
    cwd,
    READ_TIMEOUT_MS
  )
  if (porcelain != null) {
    for (const record of splitNul(porcelain)) {
      const code = record.slice(0, 2)
      const path = record.slice(3)
      if (!path) continue
      if (isNoisePath(path)) continue
      const flags = flagsFromPorcelain(code)

      if (code === '??') {
        const canCount = shouldCountUntrackedLines(path)
        const added = canCount ? countFileLines(cwd, path) : 0
        tracked.set(path, {
          ...emptyFile(path, 'untracked'),
          added,
          addedUnstaged: added,
          binary: false,
          ...flags
        })
        continue
      }
      const existing = ensure(path, statusFor(code))
      existing.status = statusFor(code)
      existing.staged = flags.staged
      existing.unstaged = flags.unstaged
    }
  }

  for (const file of tracked.values()) {
    // Porcelain may mark staged/unstaged even when numstat is empty (mode-only).
    if (!file.staged && (file.addedStaged > 0 || file.removedStaged > 0)) file.staged = true
    if (!file.unstaged && (file.addedUnstaged > 0 || file.removedUnstaged > 0)) file.unstaged = true
    file.added = file.addedStaged + file.addedUnstaged
    file.removed = file.removedStaged + file.removedUnstaged
  }

  // Numstat can still list noise paths if they were already tracked/staged;
  // keep chrome aligned with the porcelain filter.
  const all = [...tracked.values()]
    .filter((file) => !isNoisePath(file.path))
    .sort((a, b) => a.path.localeCompare(b.path))
  const files = all

  let added = 0
  let removed = 0
  for (const file of all) {
    added += file.added
    removed += file.removed
  }

  const remote = await gitQuiet(['remote'], cwd, READ_TIMEOUT_MS)

  const status: GitStatus = {
    branch,
    files,
    truncated: all.length > files.length,
    fileCount: all.length,
    added,
    removed,
    hasRemote: Boolean(remote?.trim()),
    hasCommits
  }
  return { kind: 'ok', status }
}

export type GitDiffOptions = {
  path?: string
  staged?: boolean
  ignoreWhitespace?: boolean
  sha?: string
  vsHead?: boolean
}

function capDiff(text: string): string {
  return text
}

/**
 * Untracked paths are invisible to plain `git diff` / `git diff --cached`.
 * Compare against `/dev/null` via `--no-index` (Git for Windows accepts this path).
 * https://git-scm.com/docs/git-diff
 */
async function readUntrackedFileDiff(
  cwd: string,
  relPath: string,
  ignoreWhitespace?: boolean
): Promise<string | null> {
  const normalized = relPath.replace(/\\/g, '/').trim()
  if (!normalized || normalized.includes('\0')) return null

  let abs: string
  try {
    abs = resolveInsideWorkspace(cwd, normalized)
  } catch {
    return null
  }

  try {
    const stat = statSync(abs)
    if (!stat.isFile()) return null
  } catch {
    return null
  }

  const tracked = await gitQuiet(['ls-files', '--', normalized], cwd, READ_TIMEOUT_MS)
  if (tracked?.trim()) return null

  const args = ['diff', '--no-index', '--no-color', '--no-ext-diff']
  if (ignoreWhitespace) args.push('-w')
  args.push('--', '/dev/null', normalized)

  try {
    const stdout = await gitDiffStdout(args, cwd, READ_TIMEOUT_MS)
    const text = stdout.trimEnd()
    return text || null
  } catch {
    return null
  }
}

/** Unified diff against HEAD (or staged index / commit). Capped for tool output. */
export async function readGitDiff(
  cwd: string,
  opts: GitDiffOptions = {}
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  if (!isGitRepo(cwd)) return { ok: false, error: 'Not a git repository' }

  // Reject abs/UNC/drive/`..` paths like stage/unstage do — never pass raw input to git.
  const requestedPath = opts.path?.trim()
  const path = requestedPath ? sanitizeRelativePaths([requestedPath])[0] : undefined
  if (requestedPath && !path) return { ok: false, error: 'Invalid path' }

  const sha = opts.sha ? parseGitObjectId(opts.sha) : null
  if (opts.sha && !sha) return { ok: false, error: 'Invalid commit' }
  if (sha) {
    const args = ['show', '--no-color', '--no-ext-diff', '--pretty=format:', '--patch']
    if (opts.ignoreWhitespace) args.push('-w')
    args.push('--end-of-options', sha)
    if (path) args.push('--', path)
    try {
      const stdout = await gitDiffStdout(args, cwd, READ_TIMEOUT_MS)
      const text = stdout.trimEnd()
      if (!text) return { ok: true, content: '(no changes in commit)' }
      return { ok: true, content: capDiff(text) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  }

  const hasCommits = await hasGitCommits(cwd)
  if (opts.vsHead && !hasCommits) {
    const [staged, unstaged] = await Promise.all([
      readGitDiff(cwd, { ...opts, staged: true, vsHead: false }),
      readGitDiff(cwd, { ...opts, staged: false, vsHead: false })
    ])
    if (!staged.ok) return staged
    if (!unstaged.ok) return unstaged
    const parts = [staged.content, unstaged.content].filter(
      (content) => !/^\(no (?:staged|unstaged|uncommitted) changes\)$/i.test(content.trim())
    )
    const combined = parts.join('\n\n')
    return {
      ok: true,
      content: combined ? capDiff(combined) : '(no uncommitted changes)'
    }
  }

  const args = ['diff', '--no-color', '--no-ext-diff']
  if (opts.ignoreWhitespace) args.push('-w')
  if (opts.vsHead && hasCommits) {
    args.push('HEAD')
  } else if (opts.staged) {
    args.push('--cached')
  }
  if (path) {
    args.push('--', path)
  }

  try {
    const stdout = await git(args, cwd, READ_TIMEOUT_MS)
    const text = stdout.trimEnd()
    if (text) return { ok: true, content: capDiff(text) }

    // Untracked files never appear in worktree/index diffs — synthesize a full add.
    if (path && !opts.staged) {
      const untracked = await readUntrackedFileDiff(cwd, path, opts.ignoreWhitespace)
      if (untracked) return { ok: true, content: capDiff(untracked) }
    }

    return {
      ok: true,
      content: opts.vsHead
        ? '(no uncommitted changes)'
        : opts.staged
          ? '(no staged changes)'
          : '(no unstaged changes)',
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

const GIT_BLAME_MAX_LINES = 20_000

type BlameCursor = {
  sha: string
  author: string
  date: string
  finalLine: number
  remaining: number
}

function blameDate(raw: string): string {
  const seconds = Number(raw)
  if (!Number.isFinite(seconds)) return ''
  return new Date(seconds * 1_000).toISOString()
}

/** Read bounded line ownership metadata without exposing raw git process output. */
export async function readGitBlame(cwd: string, relPath: string): Promise<GitBlameResult> {
  if (!(await gitAvailable())) {
    return { kind: 'unavailable', detail: 'Git is not installed or not on PATH' }
  }
  if (!isGitRepo(cwd)) {
    return { kind: 'not_repo', detail: 'This workspace is not a git repository' }
  }
  const path = sanitizeRelativePaths([relPath])[0]
  if (!path) return { kind: 'unavailable', detail: 'Invalid workspace-relative path' }

  let stdout: string
  try {
    stdout = await git(['blame', '--line-porcelain', '--', path], cwd, READ_TIMEOUT_MS)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return {
      kind: 'unavailable',
      detail: /not a valid object name|no such path|cannot stat/i.test(detail)
        ? 'Git blame is unavailable until this file has a committed history'
        : detail
    }
  }

  const lines: GitBlameLine[] = []
  let cursor: BlameCursor | null = null
  for (const rawLine of stdout.split(/\r?\n/)) {
    const header = /^([0-9a-f]{7,64}) \d+ (\d+)(?: (\d+))?$/.exec(rawLine)
    if (header) {
      cursor = {
        sha: header[1]!,
        author: '',
        date: '',
        finalLine: Number(header[2]),
        remaining: Math.max(1, Number(header[3] ?? 1))
      }
      continue
    }
    if (!cursor) continue
    if (rawLine.startsWith('author ')) {
      cursor.author = rawLine.slice('author '.length)
      continue
    }
    if (rawLine.startsWith('author-time ')) {
      cursor.date = blameDate(rawLine.slice('author-time '.length))
      continue
    }
    if (!rawLine.startsWith('\t')) continue
    if (lines.length >= GIT_BLAME_MAX_LINES) break
    const sha = /^0+$/.test(cursor.sha) ? null : cursor.sha
    lines.push({
      line: lines.length + 1,
      sha,
      shortSha: sha ? sha.slice(0, 7) : null,
      author: cursor.author || 'Unknown author',
      date: cursor.date,
      text: rawLine.slice(1)
    })
    cursor.finalLine += 1
    cursor.remaining -= 1
    if (cursor.remaining <= 0) cursor = null
  }

  return {
    kind: 'ok',
    path,
    lines,
    truncated: lines.length >= GIT_BLAME_MAX_LINES
  }
}

export type GitLogEntry = {
  sha: string
  shortSha: string
  subject: string
  author: string
  relativeDate: string
}

function isEmptyHistoryError(message: string): boolean {
  return /does not have any commits|bad default revision|ambiguous argument 'HEAD'/i.test(
    message
  )
}

/** Unit-separator fields so a tab in the subject cannot shift columns. */
const GIT_LOG_FORMAT = '%H%x1f%h%x1f%s%x1f%an%x1f%cr'

export async function readGitLog(cwd: string, limit = 40): Promise<GitLogEntry[]> {
  if (!isGitRepo(cwd)) return []
  const capped = Math.min(Math.max(1, limit), 100)
  let stdout: string
  try {
    stdout = await git(
      [
        '-c',
        'log.showSignature=false',
        'log',
        `--max-count=${capped}`,
        '--no-decorate',
        `--format=${GIT_LOG_FORMAT}`
      ],
      cwd,
      READ_TIMEOUT_MS
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (isEmptyHistoryError(message)) return []
    throw err
  }
  if (!stdout.trim()) return []
  const out: GitLogEntry[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim()) continue
    const [shaRaw, shortSha, subject, author, relativeDate] = line.split('\x1f')
    const sha = parseGitObjectId(shaRaw)
    if (!sha || !shortSha) continue
    out.push({
      sha,
      shortSha,
      subject: subject ?? '',
      author: author ?? '',
      relativeDate: relativeDate ?? ''
    })
  }
  return out
}

function commitFileFromNumstat(record: string): GitChangedFile | null {
  const parts = record.split('\t')
  if (parts.length < 3) return null
  const addedRaw = parts[0] ?? ''
  const removedRaw = parts[1] ?? ''
  const path = parts.slice(2).join('\t').replace(/^"(.*)"$/, '$1').trim()
  if (!path) return null
  const added = addedRaw === '-' ? 0 : Number(addedRaw)
  const removed = removedRaw === '-' ? 0 : Number(removedRaw)
  const binary = addedRaw === '-'
  const addedN = Number.isFinite(added) ? added : 0
  const removedN = Number.isFinite(removed) ? removed : 0
  let status: GitChangedFile['status'] = 'modified'
  if (!binary && addedN > 0 && removedN === 0) status = 'added'
  if (!binary && addedN === 0 && removedN > 0) status = 'deleted'
  return {
    path,
    status,
    added: addedN,
    removed: removedN,
    addedStaged: 0,
    removedStaged: 0,
    addedUnstaged: addedN,
    removedUnstaged: removedN,
    binary,
    staged: false,
    unstaged: false
  }
}

/** Files changed in a single commit (numstat). */
export async function readGitCommitFiles(cwd: string, sha: string): Promise<GitChangedFile[]> {
  if (!isGitRepo(cwd)) return []
  const id = parseGitObjectId(sha)
  if (!id) throw new Error('Invalid commit')
  const stdout = await git(
    [
      'show',
      '--numstat',
      '--pretty=format:',
      '--no-renames',
      '-z',
      '--end-of-options',
      id
    ],
    cwd,
    READ_TIMEOUT_MS
  )
  if (!stdout.trim()) return []
  const out: GitChangedFile[] = []
  for (const record of splitNul(stdout)) {
    const file = commitFileFromNumstat(record)
    if (file) out.push(file)
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export type CommitOutcome = { committed: boolean; pushed: boolean; detail: string }
export type CommitMode = 'all' | 'staged'

/** Dirty paths from porcelain, excluding chrome noise trees (node_modules, etc.). */
async function listNonNoiseDirtyPaths(cwd: string): Promise<string[]> {
  const porcelain = await gitQuiet(
    ['status', '--porcelain=v1', '-z', '-uall', '--no-renames'],
    cwd,
    READ_TIMEOUT_MS
  )
  if (!porcelain?.trim()) return []
  const paths: string[] = []
  for (const record of splitNul(porcelain)) {
    const path = record.slice(3)
    if (!path || isNoisePath(path)) continue
    paths.push(path)
  }
  return paths
}

const STAGE_PATH_BATCH = 64

async function stageNonNoisePaths(cwd: string, paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += STAGE_PATH_BATCH) {
    const chunk = paths.slice(i, i + STAGE_PATH_BATCH)
    // `-A` with pathspecs stages adds, mods, and deletions for those paths only.
    await git(['add', '-A', '--', ...chunk], cwd, WRITE_TIMEOUT_MS)
  }
}

/** Commit whatever is staged and optionally push. Shared by commitAll/commitPaths. */
async function commitStagedAndMaybePush(
  cwd: string,
  message: string,
  push: boolean
): Promise<CommitOutcome> {
  const staged = await gitQuiet(['diff', '--cached', '--name-only'], cwd, READ_TIMEOUT_MS)
  if (!staged?.trim()) {
    return { committed: false, pushed: false, detail: 'Nothing to commit' }
  }

  await git(['commit', '-m', message], cwd, WRITE_TIMEOUT_MS)
  if (!push) return { committed: true, pushed: false, detail: 'Committed' }

  const remote = await gitQuiet(['remote'], cwd, READ_TIMEOUT_MS)
  if (!remote?.trim()) {
    return { committed: true, pushed: false, detail: 'Committed. No remote to push to.' }
  }

  // A first push on a fresh branch has no upstream, so set one rather than fail.
  const pushArgs = await resolvePushArgs(cwd)
  await git(pushArgs, cwd, PUSH_TIMEOUT_MS)
  return { committed: true, pushed: true, detail: 'Committed and pushed' }
}

function parseRemoteNames(raw: string | null): string[] {
  if (!raw) return []
  return raw
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && !name.startsWith('-'))
}

async function resolvePushArgs(cwd: string): Promise<string[]> {
  const branch = (await gitQuiet(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, READ_TIMEOUT_MS))?.trim()
  if (!branch || branch === 'HEAD') return ['push']

  const upstream = await gitQuiet(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    cwd,
    READ_TIMEOUT_MS
  )
  if (upstream?.trim()) return ['push']

  const remotes = parseRemoteNames(await gitQuiet(['remote'], cwd, READ_TIMEOUT_MS))
  const remote = remotes.includes('origin') ? 'origin' : remotes[0]
  if (!remote) return ['push']
  return ['push', '--set-upstream', remote, branch]
}

/** Whether this repository has at least one configured remote. */
export async function hasGitRemote(cwd: string): Promise<boolean> {
  if (!isGitRepo(cwd)) return false
  return parseRemoteNames(await gitQuiet(['remote'], cwd, READ_TIMEOUT_MS)).length > 0
}

function normalizeRemoteName(remote: string): string {
  const name = remote.trim()
  if (!name || name.startsWith('-') || /[\s\\]/.test(name)) {
    throw new Error('Invalid git remote name')
  }
  return name
}

async function readGitRemoteUrl(cwd: string, name: string): Promise<string | null> {
  return (await gitQuiet(['remote', 'get-url', name], cwd, READ_TIMEOUT_MS))?.trim() || null
}

/** URL for one configured remote, or null when the remote does not exist. */
export async function gitRemoteUrl(cwd: string, remote = 'origin'): Promise<string | null> {
  if (!isGitRepo(cwd)) return null
  return readGitRemoteUrl(cwd, normalizeRemoteName(remote))
}

/** Add a GitHub HTTPS remote without replacing an existing remote. */
export async function addGitRemote(
  cwd: string,
  url: string,
  remote = 'origin'
): Promise<void> {
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')
  const name = normalizeRemoteName(remote)
  const target = url.trim()
  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    throw new Error('GitHub repository returned an invalid remote URL')
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') {
    throw new Error('GitHub repository returned an unsupported remote URL')
  }
  const existing = await readGitRemoteUrl(cwd, name)
  if (existing) {
    const comparable = (value: string) =>
      value.trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase()
    if (comparable(existing) === comparable(target)) return
    throw new Error(`Git remote "${name}" already exists`)
  }
  await git(['remote', 'add', name, target], cwd, WRITE_TIMEOUT_MS)
}

function validBranchName(name: string): boolean {
  return Boolean(name) && !name.startsWith('-') && !name.includes('..') && !/[\s\\]/.test(name)
}

/** Create and check out a new local topic branch without touching the worktree. */
export async function createBranch(cwd: string, branch: string): Promise<{ detail: string }> {
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')
  const name = branch.trim()
  if (!validBranchName(name)) throw new Error('Invalid branch name')
  const checked = await gitQuiet(['check-ref-format', '--branch', name], cwd, READ_TIMEOUT_MS)
  if (!checked?.trim()) throw new Error('Invalid branch name')
  const exists = await gitQuiet(
    ['show-ref', '--verify', '--quiet', `refs/heads/${name}`],
    cwd,
    READ_TIMEOUT_MS
  )
  if (exists !== null) throw new Error(`Branch already exists: ${name}`)
  await git(['switch', '--create', name], cwd, WRITE_TIMEOUT_MS)
  return { detail: `Created and checked out ${name}` }
}

/** Push the current branch, setting an upstream when needed. */
export async function pushCurrentBranch(cwd: string): Promise<void> {
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')
  if (!(await hasGitRemote(cwd))) {
    throw new Error('No git remote configured. Add a GitHub remote before pushing.')
  }
  await git(await resolvePushArgs(cwd), cwd, PUSH_TIMEOUT_MS)
}

export async function commitAll(
  cwd: string,
  message: string,
  push: boolean,
  mode: CommitMode = 'all'
): Promise<CommitOutcome> {
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')

  if (mode === 'all') {
    // Never `git add -A`: that stages hidden noise the Changes UI filters out.
    const paths = await listNonNoiseDirtyPaths(cwd)
    await stageNonNoisePaths(cwd, paths)
  }

  return commitStagedAndMaybePush(cwd, message, push)
}

/** Create a baseline commit when a newly connected repository has no history. */
export async function commitEmpty(cwd: string, message: string): Promise<void> {
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')
  const trimmed = message.trim()
  if (!trimmed) throw new Error('Commit message is required')
  await git(['commit', '--allow-empty', '--only', '-m', trimmed], cwd, WRITE_TIMEOUT_MS)
}

export type CommitPathsOutcome = CommitOutcome & {
  /** Dirty paths intentionally left uncommitted (not touched by the agent). */
  skipped: string[]
}

/**
 * Commit only the given relative paths — unrelated dirty files stay uncommitted.
 * Paths already staged by the user remain staged and are committed too.
 */
export async function commitPaths(
  cwd: string,
  message: string,
  push: boolean,
  paths: string[]
): Promise<CommitPathsOutcome> {
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')

  const dirty = new Set(await listNonNoiseDirtyPaths(cwd))
  const wanted = sanitizeRelativePaths(paths)
  const toStage = wanted.filter((path) => dirty.has(path))
  if (toStage.length > 0) {
    await stageNonNoisePaths(cwd, toStage)
  }

  const outcome = await commitStagedAndMaybePush(cwd, message, push)
  const skipped = [...dirty].filter((path) => !toStage.includes(path)).sort()
  return { ...outcome, skipped }
}

/** Stage every visible unstaged / untracked path (excludes chrome noise trees). */
export async function stageAll(cwd: string): Promise<{ staged: boolean; detail: string }> {
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')
  const paths = await listNonNoiseDirtyPaths(cwd)
  if (paths.length === 0) {
    return { staged: false, detail: 'Nothing to stage' }
  }
  await stageNonNoisePaths(cwd, paths)
  return { staged: true, detail: 'Staged all changes' }
}

/** @internal Exported for unit tests — rejects abs/UNC/drive/`..` like isSafeWorkspaceRelPath. */
export function sanitizeRelativePaths(paths: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of paths) {
    const path = raw.replace(/\\/g, '/').trim()
    if (!isSafeWorkspaceRelPath(path) || isNoisePath(path)) continue
    if (seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

/** Stage specific relative paths (noise trees rejected). */
export async function stagePaths(
  cwd: string,
  paths: string[]
): Promise<{ staged: boolean; detail: string }> {
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')
  const clean = sanitizeRelativePaths(paths)
  if (clean.length === 0) {
    return { staged: false, detail: 'Nothing to stage' }
  }
  await stageNonNoisePaths(cwd, clean)
  return {
    staged: true,
    detail: clean.length === 1 ? `Staged ${clean[0]}` : `Staged ${clean.length} paths`
  }
}

/** Unstage specific relative paths (`git restore --staged`). */
export async function unstagePaths(
  cwd: string,
  paths: string[]
): Promise<{ unstaged: boolean; detail: string }> {
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')
  const clean = sanitizeRelativePaths(paths)
  if (clean.length === 0) {
    return { unstaged: false, detail: 'Nothing to unstage' }
  }
  for (let i = 0; i < clean.length; i += STAGE_PATH_BATCH) {
    const chunk = clean.slice(i, i + STAGE_PATH_BATCH)
    await git(['restore', '--staged', '--', ...chunk], cwd, WRITE_TIMEOUT_MS)
  }
  return {
    unstaged: true,
    detail: clean.length === 1 ? `Unstaged ${clean[0]}` : `Unstaged ${clean.length} paths`
  }
}

export type GitBranchEntry = {
  name: string
  current: boolean
}

/** Local branches (`git branch --list`). */
export async function listLocalBranches(cwd: string): Promise<GitBranchEntry[]> {
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')
  const raw = await git(['branch', '--list', '--format=%(refname:short)%09%(HEAD)'], cwd, READ_TIMEOUT_MS)
  const out: GitBranchEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trimEnd()
    if (!trimmed) continue
    const [name, head] = trimmed.split('\t')
    if (!name?.trim()) continue
    out.push({ name: name.trim(), current: head?.trim() === '*' })
  }
  out.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return out
}

/** Check out an existing local branch. */
export async function checkoutBranch(
  cwd: string,
  branch: string
): Promise<{ detail: string }> {
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')
  const name = branch.trim()
  if (!name || name.startsWith('-') || name.includes('..') || /[\s\\]/.test(name)) {
    throw new Error('Invalid branch name')
  }
  const listed = await listLocalBranches(cwd)
  const match = listed.find((entry) => entry.name === name)
  if (!match) throw new Error(`Unknown branch: ${name}`)
  await git(['checkout', match.name], cwd, WRITE_TIMEOUT_MS)
  return { detail: `Checked out ${match.name}` }
}

/** Read merge-conflict stages (`:1:` base, `:2:` ours, `:3:` theirs) plus the working copy. */
export async function readConflictFile(
  cwd: string,
  relPath: string
): Promise<{ ours: string; theirs: string; base: string; working: string }> {
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')
  if (!isSafeWorkspaceRelPath(relPath)) throw new Error('Invalid path')
  const ours = (await gitQuiet(['show', `:2:${relPath}`], cwd, READ_TIMEOUT_MS)) ?? ''
  const theirs = (await gitQuiet(['show', `:3:${relPath}`], cwd, READ_TIMEOUT_MS)) ?? ''
  const base = (await gitQuiet(['show', `:1:${relPath}`], cwd, READ_TIMEOUT_MS)) ?? ''
  let working = ''
  try {
    working = readFileSync(resolveInsideWorkspace(cwd, relPath), 'utf8')
  } catch {
    /* unmerged path may be missing on disk */
  }
  return { ours, theirs, base, working }
}

/** Write the resolved file and `git add` it. */
export async function resolveConflict(
  cwd: string,
  relPath: string,
  content: string
): Promise<{ detail: string }> {
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')
  if (!isSafeWorkspaceRelPath(relPath)) throw new Error('Invalid path')
  writeFileSync(resolveInsideWorkspace(cwd, relPath), content, 'utf8')
  await git(['add', '--', relPath], cwd, WRITE_TIMEOUT_MS)
  return { detail: `Resolved ${relPath}` }
}
