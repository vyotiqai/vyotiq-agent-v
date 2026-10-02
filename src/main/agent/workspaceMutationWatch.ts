import { copyFile, lstat, mkdir, readdir, rm, stat, writeFile } from 'fs/promises'
import { createReadStream, existsSync, type Stats } from 'fs'
import { spawn } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { canonicalizeWorkspacePath } from '../../shared/utils/workspacePath'
import { mapLimit } from '../../shared/utils/mapLimit'
import { IGNORED_DIRS, yieldToEventLoop } from './tools/walk'
import { getWriteCheckpoint, type InvokeWriteCheckpoint } from './checkpoints'
import { guardedGitCommand } from '../git/git'
import { logger } from '../../shared/logger'
import { extraRootDisplayPath } from '../../shared/extraRoots'

export type WorkspaceFileFingerprint = {
  rel: string
  full: string
  mtimeMs: number
  size: number
  contentHash?: string
  /** Absolute path to a prior-content blob when snapshotted. */
  blobPath?: string
}

export type WorkspaceSnapshot = {
  root: string
  files: Map<string, WorkspaceFileFingerprint>
  blobDir: string
  /** Wall clock before the pre-walk — anything newer was written during the watch. */
  startedAtMs: number
  /** The pre-walk hit the file cap, so `files` covers only a prefix of the tree. */
  truncated: boolean
  /**
   * Set when the snapshot came from `git status` instead of a walk. `files`
   * then holds only the paths git reported changed or untracked before the
   * command — the ones git cannot give back — and every clean tracked file's
   * prior content is read from git after the command, for the files it changed.
   */
  git?: GitBaseline
  /**
   * Set when `root` is one of the task's added folders (extraRoots.ts): its
   * changes are recorded under absolute checkpoint keys, as edits there are.
   */
  extraRoot?: string
}

/** What the git path knew before the command. See startGitWatch. */
type GitBaseline = {
  /** The workspace root relative to the repository top, `/`-terminated ('' at the top). */
  prefix: string
  /** HEAD before the command; null on an unborn branch. */
  headOid: string | null
  /** Workspace-relative paths git reported changed or untracked before the command. */
  dirty: Set<string>
  /** Dirty tracked paths with no file on disk (deleted in the worktree) before the command. */
  absent: Set<string>
  /** Dirty paths past the fingerprint cap: no fingerprint and no copy. */
  unfingerprinted: Set<string>
  /** Prior content read back from git after the command, by workspace-relative path. */
  headBlobs: Map<string, string>
}

export type WorkspaceDiff = {
  created: string[]
  modified: string[]
  deleted: string[]
}

const SNAPSHOT_BLOB_FILE_MAX_BYTES = 8 * 1024 * 1024
/** Only small, source-sized files get revert blobs; everything else is hash-only. */
/** Bound total snapshot disk usage so a huge opaque run can't fill the drive. */
const SNAPSHOT_BLOB_TOTAL_MAX_BYTES = 64 * 1024 * 1024
/** Files above this size are never content-hashed — mtime/size diff only. */
const SNAPSHOT_HASH_MAX_BYTES = 32 * 1024 * 1024
/** Bound total hashed bytes per snapshot pass — mirrors SNAPSHOT_BLOB_TOTAL_MAX_BYTES. */
const SNAPSHOT_HASH_TOTAL_MAX_BYTES = 64 * 1024 * 1024
const SNAPSHOT_FILE_CAP = 5_000
const YIELD_EVERY_DIRS = 64
/** Files copied/hashed/compared at once: keeps the disk busy without flooding the thread pool. */
const CAPTURE_CONCURRENCY = 8

/** Effective walk cap — overridable by tests so truncation is reachable cheaply. */
let snapshotFileCap = SNAPSHOT_FILE_CAP

/**
 * Roots already reported as over the cap. Truncation is a property of the tree,
 * not of the step, and both walks of every mutating tool call re-derive it — 25
 * of one session's 49 warnings were this one line repeating. Say it once per
 * root so it stays findable.
 */
const truncationWarnedRoots = new Set<string>()

/** @internal Test hook. */
export function setSnapshotFileCapForTests(cap: number | null): void {
  snapshotFileCap = cap ?? SNAPSHOT_FILE_CAP
  truncationWarnedRoots.clear()
  uncapturedWarnedRoots.clear()
}

/** Whether a workspace inside a git repository is snapshotted through `git status`. */
let gitSnapshotEnabled = true

/** @internal Test hook: false forces the capped walk even inside a repository. */
export function setGitSnapshotEnabledForTests(enabled: boolean | null): void {
  gitSnapshotEnabled = enabled ?? true
}

/** Roots already reported as having changed files with no undo copy before the command. */
const uncapturedWarnedRoots = new Set<string>()

/** Bound on `git status` / `git diff --raw` output; past it the git path gives up. */
const GIT_LIST_MAX_BYTES = 32 * 1024 * 1024
/** A status on a large repository can take seconds; past this, fall back or give up. */
const GIT_TIMEOUT_MS = 30_000
/**
 * Slack for "this file appeared during the watch": filesystem timestamps can
 * be coarser than the wall clock (FAT 2 s, HFS+ 1 s).
 */
const CREATED_SLACK_MS = 2_000

/**
 * Dependency/cache directories that dominate snapshot cost (the venv-heavy
 * "~17 GB disk I/O per terminal-heavy run" case) but whose mutations the
 * write-checkpoint system cannot meaningfully restore anyway. Layered on top
 * of the shared walk ignore list without changing agent search semantics.
 */
const SNAPSHOT_SKIP_DIRS = new Set([
  '.venv',
  'venv',
  'env',
  '.tox',
  'site-packages',
  '__pycache__',
  '.gradle',
  '.m2',
  '.cargo',
  '.cache',
  '.nox',
  '.pixi',
  'target',
  // .NET build output (bin/Debug|Release) — not agent-edited source.
  'bin'
])

function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/')
}

function hashFile(path: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', () => resolve(undefined))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

type WalkResult = {
  files: WorkspaceFileFingerprint[]
  /** The cap stopped the walk — the result covers only a prefix of the tree. */
  truncated: boolean
}

async function walkWorkspace(root: string, cap: number): Promise<WalkResult> {
  const realRoot = canonicalizeWorkspacePath(root)
  const out: WorkspaceFileFingerprint[] = []
  const queue: Array<{ dir: string; relDir: string }> = [{ dir: realRoot, relDir: '' }]
  let dirsVisited = 0
  let truncated = false

  while (queue.length > 0 && out.length < cap) {
    const next = queue.shift()!
    dirsVisited += 1
    if (dirsVisited % YIELD_EVERY_DIRS === 0) await yieldToEventLoop()
    let entries
    try {
      entries = await readdir(next.dir, { withFileTypes: true })
    } catch {
      continue
    }
    // Sort so the cap frontier is a function of the tree, not of readdir order.
    // Two walks of the same tree then truncate at the same place, which is what
    // makes a truncated diff comparable at all.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (out.length >= cap) {
        truncated = true
        break
      }
      if (IGNORED_DIRS.has(entry.name)) continue
      if (SNAPSHOT_SKIP_DIRS.has(entry.name)) continue
      if (entry.isSymbolicLink()) continue
      const full = join(next.dir, entry.name)
      const childRel = normalizeRel(next.relDir ? `${next.relDir}/${entry.name}` : entry.name)
      if (entry.isDirectory()) {
        queue.push({ dir: full, relDir: childRel })
        continue
      }
      if (!entry.isFile()) continue
      try {
        const st = await stat(full)
        out.push({
          rel: childRel,
          full,
          mtimeMs: st.mtimeMs,
          size: st.size
        })
      } catch {
        // skip unreadable entries
      }
    }
  }
  // Directories still queued are directories never walked. Testing `out.length`
  // instead flagged a tree of exactly `cap` files, which the walk covered in
  // full, as partial — and a partial diff suppresses genuine creates.
  if (queue.length > 0) truncated = true
  if (truncated && !truncationWarnedRoots.has(realRoot)) {
    truncationWarnedRoots.add(realRoot)
    logger.warn('Workspace snapshot file cap reached; checkpoint diff may be incomplete', {
      scope: 'workspaceMutationWatch',
      cap
    })
  }
  return { files: out, truncated }
}

/**
 * Take a pre-mutation fingerprint (with prior blobs for small files) of the
 * workspace, or with `extraRoot` of one of the task's added folders.
 */
export async function startWatch(
  workspaceRoot: string,
  opts: { extraRoot?: boolean } = {}
): Promise<WorkspaceSnapshot> {
  const snap = await startRootWatch(workspaceRoot)
  return opts.extraRoot ? { ...snap, extraRoot: workspaceRoot } : snap
}

async function startRootWatch(workspaceRoot: string): Promise<WorkspaceSnapshot> {
  const blobDir = join(tmpdir(), `vyotiq-ws-snap-${process.pid}-${randomUUID()}`)
  await mkdir(blobDir, { recursive: true })
  // Read the clock before the walk: a file written while the walk is still
  // running must count as created, not be dated before the watch began.
  const startedAtMs = Date.now()
  if (gitSnapshotEnabled) {
    const viaGit = await startGitWatch(workspaceRoot, blobDir, startedAtMs).catch((err: unknown) => {
      logger.warn('Git workspace snapshot failed; walking the tree instead', {
        scope: 'workspaceMutationWatch',
        err
      })
      return null
    })
    if (viaGit) return viaGit
  }
  const files = new Map<string, WorkspaceFileFingerprint>()
  const { files: walked, truncated } = await walkWorkspace(workspaceRoot, snapshotFileCap)
  await captureFingerprints(walked, blobDir, files)
  return { root: workspaceRoot, files, blobDir, startedAtMs, truncated }
}

/**
 * Copy (bounded) and hash (bounded) each file into `files`, in the given
 * order — the first files to fit the budgets are the ones that get a copy.
 * Returns how many had no copy kept.
 */
async function captureFingerprints(
  ordered: WorkspaceFileFingerprint[],
  blobDir: string,
  files: Map<string, WorkspaceFileFingerprint>
): Promise<number> {
  // Spend the budgets in order first, so which files get a copy depends only
  // on the order and the sizes; then do the I/O a few files at a time.
  let totalBlobBytes = 0
  let totalHashBytes = 0
  const plan = ordered.map((fp) => {
    const copy =
      fp.size <= SNAPSHOT_BLOB_FILE_MAX_BYTES && totalBlobBytes + fp.size <= SNAPSHOT_BLOB_TOTAL_MAX_BYTES
    if (copy) totalBlobBytes += fp.size
    // Hash small files for same-size rewrite detection (build runners touch
    // files exactly this way), bounded by SNAPSHOT_HASH_TOTAL_MAX_BYTES like
    // the blob budget: the walk order is BFS (root files before subdirs), so
    // the first files to fit are also the most checkpoint-relevant. A
    // same-size in-place rewrite of a budget-exhausted file is mtime/size
    // diff only — the trade the blob budget already makes.
    const hash = fp.size <= SNAPSHOT_HASH_MAX_BYTES && totalHashBytes + fp.size <= SNAPSHOT_HASH_TOTAL_MAX_BYTES
    if (hash) totalHashBytes += fp.size
    return { fp, copy, hash }
  })
  const captured = await mapLimit(plan, CAPTURE_CONCURRENCY, async ({ fp, copy, hash }) => {
    let blobPath: string | undefined
    if (copy) {
      try {
        const dest = join(blobDir, ...fp.rel.split('/'))
        await mkdir(dirname(dest), { recursive: true })
        await copyFile(fp.full, dest)
        blobPath = dest
      } catch {
        blobPath = undefined
      }
    }
    const contentHash = hash ? await hashFile(fp.full) : undefined
    return { ...fp, blobPath, contentHash }
  })
  let uncaptured = 0
  for (const fp of captured) {
    if (!fp.blobPath) uncaptured += 1
    files.set(fp.rel, fp)
  }
  return uncaptured
}

export async function diffSince(snapshot: WorkspaceSnapshot): Promise<WorkspaceDiff> {
  if (snapshot.git) return diffGitWatch(snapshot, snapshot.git)
  const { files: walked, truncated: nowTruncated } = await walkWorkspace(
    snapshot.root,
    snapshotFileCap
  )
  const current = new Map(walked.map((f) => [f.rel, f] as const))
  const created: string[] = []
  const modified: string[] = []
  const deleted: string[] = []

  /**
   * Either walk stopping at the cap means the two cover different prefixes of
   * the tree, so set membership alone no longer implies the file appeared or
   * vanished during the step — it may only have crossed the frontier. Undo
   * *deletes* files recorded as created, so a file wrongly classified that way
   * destroys work the agent never touched. Fall back to evidence that does not
   * depend on coverage: an mtime inside the watch window, and, for deletions,
   * the file actually being gone.
   *
   * This can miss a genuine create whose mtime predates the watch (`unzip`,
   * `tar -x` and `cp -p` restore recorded timestamps). Under truncation the
   * diff is already incomplete by construction — the warning says so — and a
   * missed undo entry only leaves a file in place, which is the safe direction.
   */
  const partial = snapshot.truncated || nowTruncated

  for (const [rel, now] of current) {
    const before = snapshot.files.get(rel)
    if (!before) {
      if (!partial || now.mtimeMs >= snapshot.startedAtMs) created.push(rel)
      continue
    }
    if (before.mtimeMs !== now.mtimeMs || before.size !== now.size) {
      modified.push(rel)
      continue
    }
    if (before.contentHash && now.size <= SNAPSHOT_HASH_MAX_BYTES) {
      // Only re-hash files small enough to hash cheaply. Larger files are only
      // reported as modified when mtime/size changes — bounding per-diff CPU/IO
      // during the agent loop (content-hash edits without size change are rare).
      const contentHash = await hashFile(now.full)
      if (contentHash && contentHash !== before.contentHash) modified.push(rel)
    }
  }
  for (const [rel, before] of snapshot.files) {
    if (current.has(rel)) continue
    // `before.full` is the path the walk resolved, so this re-checks exactly
    // the file that was fingerprinted — no second root canonicalization.
    if (partial && (await stillExists(before.full))) continue
    deleted.push(rel)
  }
  return { created, modified, deleted }
}

/** Does this path still have a file on disk? Used to confirm a truncated-walk deletion. */
async function stillExists(full: string): Promise<boolean> {
  try {
    return (await stat(full)).isFile()
  } catch {
    return false
  }
}

export async function disposeWatch(snapshot: WorkspaceSnapshot): Promise<void> {
  try {
    // Async delete: performance.mdc rule 3 — no sync recursive fs on main-thread hot paths.
    await rm(snapshot.blobDir, { recursive: true, force: true })
  } catch (err) {
    logger.warn('Failed to dispose workspace mutation snapshot', {
      scope: 'agent',
      err
    })
  }
}

/**
 * Apply a post-tool workspace diff onto the active write checkpoint, using
 * pre-mutation blobs from the snapshot for modified/deleted paths.
 */
export async function applyWatchDiffToCheckpoint(
  snapshot: WorkspaceSnapshot,
  diff: WorkspaceDiff,
  context: { runDir?: string; skipWriteCheckpoint?: boolean }
): Promise<void> {
  if (context.skipWriteCheckpoint || !context.runDir) return
  const cp = getWriteCheckpoint(context.runDir)
  if (!cp) return

  // An added folder's files are keyed by their absolute path; the workspace's stay relative.
  const extraRoot = snapshot.extraRoot
  const keyOf = (rel: string): string => (extraRoot ? extraRootDisplayPath(extraRoot, rel) : rel)
  for (const rel of diff.created) {
    await cp.recordObservedMutation(keyOf(rel), 'created')
  }
  // No prior copy means the checkpoint records the path as not undoable,
  // which the review and rewind surfaces show as "no copy kept".
  const priorBlob = (rel: string): string | undefined =>
    snapshot.files.get(rel)?.blobPath ?? snapshot.git?.headBlobs.get(rel)
  for (const rel of diff.modified) {
    await cp.recordObservedMutation(keyOf(rel), 'modified', priorBlob(rel))
  }
  for (const rel of diff.deleted) {
    await cp.recordObservedMutation(keyOf(rel), 'deleted', priorBlob(rel))
  }
}

/**
 * Snapshot the workspace and the added folders a command could write in
 * (`extraRootsForCommand`), all at once: each is a `git status` or a walk, and
 * on this machine a process costs ~250 ms, so they overlap rather than queue.
 */
export async function startWatches(workspaceRoot: string, extraRoots: readonly string[] = []): Promise<WorkspaceSnapshot[]> {
  const [workspace, ...extras] = await Promise.allSettled([
    startWatch(workspaceRoot),
    ...extraRoots.map((root) => startWatch(root, { extraRoot: true }))
  ])
  const snaps: WorkspaceSnapshot[] = []
  for (const result of extras) {
    if (result.status === 'fulfilled') snaps.push(result.value)
    else {
      logger.warn('Snapshot of an added folder before a command failed; its writes there are not undoable', {
        scope: 'workspaceMutationWatch',
        err: result.reason
      })
    }
  }
  // The workspace's snapshot failing fails the command, as it always has.
  if (workspace!.status === 'rejected') {
    await Promise.all(snaps.map((snap) => disposeWatch(snap)))
    throw workspace!.reason
  }
  return [workspace!.value, ...snaps]
}

/** Diff every snapshot `startWatches` took, record what changed on the checkpoint, and dispose them. */
export async function finishWatches(
  snaps: readonly WorkspaceSnapshot[],
  context: { runDir?: string; skipWriteCheckpoint?: boolean }
): Promise<void> {
  const diffs = await Promise.all(
    snaps.map((snap) =>
      diffSince(snap).catch((err: unknown) => {
        logger.warn('Diff after a command failed; its writes there are not undoable', {
          scope: 'workspaceMutationWatch',
          err
        })
        return null
      })
    )
  )
  try {
    // One root at a time: the checkpoint persists after each recorded path.
    for (let i = 0; i < snaps.length; i++) {
      const diff = diffs[i]
      if (diff) await applyWatchDiffToCheckpoint(snaps[i]!, diff, context)
    }
  } finally {
    await Promise.all(snaps.map((snap) => disposeWatch(snap)))
  }
}

// ── Git path ────────────────────────────────────────────────────────────────
//
// The walk above stops at SNAPSHOT_FILE_CAP files, so on a large repository a
// command's writes past the frontier were never seen, let alone undoable. In a
// repository, `git status` answers "what differs from HEAD" for the whole tree
// in one process, honouring .gitignore (node_modules and build output never
// appear). Before the command only the paths status lists — changed or
// untracked — need their content copied, because git cannot give it back;
// every other tracked file is clean, so its prior content is HEAD's blob and
// is read from git after the command, only for the files the command changed.

type GitPathState = {
  untracked: boolean
  /** A directory entry: an untracked nested repository (`? dir/`). */
  dir: boolean
  /** Status XY of an ordinary tracked entry (not set for unmerged ones). */
  xy?: string
  /** HEAD-side blob and mode of a tracked entry (`1` hH/mH, `u` stage 2). */
  headOid?: string
  headMode?: string
}

type GitStatusRead = { headOid: string | null; paths: Map<string, GitPathState> }

const STATUS_ARGS = [
  'status',
  '--porcelain=v2',
  '-z',
  '--untracked-files=all',
  '--no-renames',
  '--branch',
  // Each submodule's dirtiness is a nested `git status`; their files are not
  // snapshotted either way.
  '--ignore-submodules=all'
]

const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const EMPTY_TREE_SHA256 = '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'

function isZeroOid(oid: string | undefined): boolean {
  return !oid || /^0+$/.test(oid)
}

/** A plain file in git's eyes — not a symlink (120000) or submodule (160000). */
function isRegularMode(mode: string | undefined): boolean {
  return mode === '100644' || mode === '100755'
}

/**
 * The directory holding `.git` (a dir, or a worktree's `gitdir:` file) at or
 * above `root`, the way git discovers it, and `root` relative to it.
 */
function findWorkTree(root: string): { top: string; prefix: string } | null {
  let dir = root
  for (;;) {
    if (existsSync(join(dir, '.git'))) break
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  const rest = root
    .slice(dir.length)
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
  return { top: dir, prefix: rest ? `${rest}/` : '' }
}

function samePathPrefix(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Repo-relative → workspace-relative, or null when git listed a path outside the workspace. */
function toWorkspaceRel(repoPath: string, prefix: string): string | null {
  if (!prefix) return repoPath
  return samePathPrefix(repoPath.slice(0, prefix.length), prefix) ? repoPath.slice(prefix.length) : null
}

/** Untracked paths under a dependency/cache dir are left out, as the walk leaves them out. */
function inSkippedDir(rel: string, isDir: boolean): boolean {
  const segments = rel.split('/')
  if (!isDir) segments.pop()
  return segments.some((s) => IGNORED_DIRS.has(s) || SNAPSHOT_SKIP_DIRS.has(s))
}

/** Split `count` space-separated fields off the front; the rest is the path (which may hold spaces). */
function splitFields(record: string, count: number): { fields: string[]; path: string } | null {
  const fields: string[] = []
  let at = 0
  for (let i = 0; i < count; i++) {
    const sp = record.indexOf(' ', at)
    if (sp === -1) return null
    fields.push(record.slice(at, sp))
    at = sp + 1
  }
  return { fields, path: record.slice(at) }
}

/** Parse `status --porcelain=v2 -z --branch`. Null when the listing is not what was asked for. */
export function parseGitStatusV2(out: string, prefix: string): GitStatusRead | null {
  let headOid: string | null = null
  const paths = new Map<string, GitPathState>()
  for (const record of out.split('\0')) {
    if (!record) continue
    if (record.startsWith('# ')) {
      if (record.startsWith('# branch.oid ')) {
        const oid = record.slice('# branch.oid '.length)
        headOid = oid === '(initial)' ? null : oid
      }
      continue
    }
    let repoPath: string
    let state: GitPathState
    const kind = record[0]
    if (kind === '1') {
      // 1 XY sub mH mI mW hH hI path
      const parsed = splitFields(record, 8)
      if (!parsed) return null
      repoPath = parsed.path
      const [, xy, , mH, , , hH] = parsed.fields
      state = {
        untracked: false,
        dir: false,
        xy,
        ...(isZeroOid(hH) ? {} : { headOid: hH, headMode: mH })
      }
    } else if (kind === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path — stage 2 is "ours", HEAD's side.
      const parsed = splitFields(record, 10)
      if (!parsed) return null
      repoPath = parsed.path
      // No `xy`: an unmerged `UD` still has the file on disk.
      const [, , , , m2, , , , h2] = parsed.fields
      state = {
        untracked: false,
        dir: false,
        ...(isZeroOid(h2) ? {} : { headOid: h2, headMode: m2 })
      }
    } else if (kind === '?') {
      repoPath = record.slice(2)
      state = { untracked: true, dir: false }
    } else if (kind === '!') {
      // Asked for only to see whether the workspace root itself is ignored by
      // an enclosing repository: then status lists nothing under it at all.
      const ignored = record.slice(2)
      if (prefix && ignored.endsWith('/') && samePathPrefix(prefix.slice(0, ignored.length), ignored)) {
        return null
      }
      continue
    } else {
      // `2` (a rename) cannot appear with --no-renames; anything else is unknown.
      return null
    }
    const relRaw = toWorkspaceRel(repoPath, prefix)
    if (relRaw == null) return null
    const dir = relRaw.endsWith('/')
    const rel = dir ? relRaw.slice(0, -1) : relRaw
    if (!rel) continue
    const prev = paths.get(rel)
    // `git rm --cached` lists one path twice: a staged delete and untracked.
    paths.set(rel, prev ? { ...prev, ...state, untracked: prev.untracked || state.untracked, dir: dir || prev.dir } : { ...state, dir })
  }
  return { headOid, paths }
}

/**
 * Run git through the app's guard (`guardedGitCommand`), streaming stdout to
 * `onStdout` (return false to stop). Resolves the exit code, or null when the
 * process could not start, was stopped or timed out.
 */
async function spawnGit(
  args: string[],
  cwd: string,
  opts: { input?: string; onStdout: (chunk: Buffer) => boolean }
): Promise<number | null> {
  const cmd = await guardedGitCommand(args, cwd).catch(() => null)
  if (!cmd) return null
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(code)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd.bin, cmd.args, {
        cwd,
        env: cmd.env,
        windowsHide: true,
        stdio: [opts.input == null ? 'ignore' : 'pipe', 'pipe', 'ignore']
      })
    } catch {
      finish(null)
      return
    }
    timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, GIT_TIMEOUT_MS)
    child.on('error', () => finish(null))
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      if (!opts.onStdout(chunk)) {
        child.kill()
        finish(null)
      }
    })
    child.on('close', (code) => finish(code))
    if (opts.input != null && child.stdin) {
      // git exiting early closes the pipe; the exit code reports that.
      child.stdin.on('error', () => {})
      child.stdin.end(opts.input)
    }
  })
}

/** Run git and collect stdout, bounded by GIT_LIST_MAX_BYTES. Null on any failure. */
async function gitListing(args: string[], cwd: string): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  const code = await spawnGit(args, cwd, {
    onStdout: (chunk) => {
      size += chunk.length
      if (size > GIT_LIST_MAX_BYTES) return false
      chunks.push(chunk)
      return true
    }
  })
  return code === 0 ? Buffer.concat(chunks).toString('utf8') : null
}

async function readGitStatusV2(root: string, prefix: string): Promise<GitStatusRead | null> {
  // `--ignored=matching` only when the workspace is a subdirectory, to tell
  // "nothing changed" from "the whole workspace is ignored by an outer repo".
  const args = [...STATUS_ARGS, ...(prefix ? ['--ignored=matching'] : []), '--', '.']
  const out = await gitListing(args, root)
  return out == null ? null : parseGitStatusV2(out, prefix)
}

/**
 * Files whose HEAD blob differs between two commits (a checkout, pull, reset
 * or commit moved HEAD), with the old side's blob and mode. A clean file the
 * command switched branches under is clean again afterwards, so status alone
 * would never list it.
 */
async function readHeadMove(
  root: string,
  prefix: string,
  from: string | null,
  to: string | null
): Promise<Map<string, { oid?: string; mode?: string }> | null> {
  const empty = (other: string | null): string =>
    other && other.length === 64 ? EMPTY_TREE_SHA256 : EMPTY_TREE_SHA1
  const out = await gitListing(
    ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', from ?? empty(to), to ?? empty(from), '--', '.'],
    root
  )
  if (out == null) return null
  const moved = new Map<string, { oid?: string; mode?: string }>()
  const parts = out.split('\0')
  for (let i = 0; i + 1 < parts.length; i += 2) {
    // :oldmode newmode oldoid newoid status \0 path
    const meta = parts[i]!.replace(/^\n/, '')
    if (!meta.startsWith(':')) return null
    const [oldMode, , oldOid] = meta.slice(1).split(' ')
    const rel = toWorkspaceRel(parts[i + 1]!, prefix)
    if (rel == null) return null
    if (!rel) continue
    moved.set(rel, isZeroOid(oldOid) ? {} : { oid: oldOid, mode: oldMode })
  }
  return moved
}

/**
 * Write each requested blob, as the worktree would hold it (eol conversion and
 * smudge filters applied), under `blobDir`, in one `git cat-file` process.
 * Bounded like the pre-command copies: per file and in total.
 *
 * With `--filters` git prints the *unfiltered* size in each header, so the
 * size cannot delimit the content. Each request is followed by a request for
 * a name that cannot exist; its `<name> missing` line marks where the content
 * ended.
 */
async function readPriorBlobs(
  root: string,
  requests: Array<{ rel: string; repoPath: string; oid: string }>,
  blobDir: string
): Promise<Map<string, string>> {
  const blobs = new Map<string, string>()
  const usable = requests.filter((r) => !r.repoPath.includes('\n') && /^[0-9a-f]+$/.test(r.oid))
  if (usable.length === 0) return blobs
  const sentinel = `vyotiq-end-${randomUUID()}`
  const sentinelLine = `${sentinel} missing`
  const marker = Buffer.from(`\n${sentinelLine}\n`)
  const input = usable.map((r) => `${r.oid} ${r.repoPath}\n${sentinel} x\n`).join('')

  let index = 0
  let mode: 'header' | 'content' | 'sentinel' = 'header'
  let pending: Buffer = Buffer.alloc(0)
  let chunks: Buffer[] = []
  let size = 0
  let over = false
  let total = 0
  const writes: Array<Promise<void>> = []

  const take = (buf: Buffer): void => {
    if (over || buf.length === 0) return
    if (size + buf.length > SNAPSHOT_BLOB_FILE_MAX_BYTES) {
      over = true
      chunks = []
      return
    }
    chunks.push(Buffer.from(buf))
    size += buf.length
  }
  const endObject = (): void => {
    const request = usable[index]
    if (request && !over && total + size <= SNAPSHOT_BLOB_TOTAL_MAX_BYTES) {
      total += size
      const dest = join(blobDir, ...request.rel.split('/'))
      const content = Buffer.concat(chunks)
      writes.push(
        mkdir(dirname(dest), { recursive: true })
          .then(() => writeFile(dest, content))
          .then(() => {
            blobs.set(request.rel, dest)
          })
          .catch(() => {})
      )
    }
    chunks = []
    size = 0
    over = false
  }

  await spawnGit(['cat-file', '--batch', '--filters'], root, {
    input,
    onStdout: (chunk) => {
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk
      for (;;) {
        if (mode === 'content') {
          const at = pending.indexOf(marker)
          if (at === -1) {
            // Keep a tail that could be the start of the marker.
            const safe = pending.length - (marker.length - 1)
            if (safe > 0) {
              take(pending.subarray(0, safe))
              pending = pending.subarray(safe)
            }
            return true
          }
          take(pending.subarray(0, at))
          pending = pending.subarray(at + marker.length)
          endObject()
          index += 1
          mode = 'header'
          continue
        }
        const nl = pending.indexOf(0x0a)
        if (nl === -1) return true
        const line = pending.subarray(0, nl).toString('utf8')
        pending = pending.subarray(nl + 1)
        if (mode === 'sentinel') {
          if (line !== sentinelLine) return false
          index += 1
          mode = 'header'
          continue
        }
        if (line === sentinelLine) return false
        // `<oid> missing` / `<oid> ambiguous`: no content, the sentinel follows.
        mode = / (missing|ambiguous)$/.test(line) ? 'sentinel' : 'content'
      }
    }
  })
  await Promise.all(writes)
  return blobs
}

async function lstatOrNull(full: string): Promise<Stats | null> {
  try {
    return await lstat(full)
  } catch {
    return null
  }
}

/**
 * Did this file come into being during the watch? Birth time where the
 * filesystem keeps one (an extracted archive keeps its old mtime but is born
 * now), else the later of mtime and ctime. Only asked about paths that were
 * neither tracked nor listed before — a file the command un-ignored was born
 * before the watch and is left alone, the safe direction for Undo.
 */
function bornDuringWatch(st: Stats, startedAtMs: number): boolean {
  const born = st.birthtimeMs > 0 ? st.birthtimeMs : Math.max(st.mtimeMs, st.ctimeMs)
  return born >= startedAtMs - CREATED_SLACK_MS
}

async function sameContent(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)])
    if (sa.size !== sb.size) return false
  } catch {
    return false
  }
  const [ha, hb] = await Promise.all([hashFile(a), hashFile(b)])
  return ha != null && ha === hb
}

async function startGitWatch(
  workspaceRoot: string,
  blobDir: string,
  startedAtMs: number
): Promise<WorkspaceSnapshot | null> {
  const realRoot = canonicalizeWorkspacePath(workspaceRoot)
  const tree = findWorkTree(realRoot)
  if (!tree) return null
  const status = await readGitStatusV2(realRoot, tree.prefix)
  if (!status) return null

  const dirty = new Set<string>()
  const absent = new Set<string>()
  const unfingerprinted = new Set<string>()
  // Tracked changes first: they are the person's work in progress, the most
  // worth a copy when the budget runs out.
  const listed = [...status.paths].sort(([relA, a], [relB, b]) =>
    a.untracked === b.untracked ? (relA < relB ? -1 : relA > relB ? 1 : 0) : a.untracked ? 1 : -1
  )
  const toStat: string[] = []
  for (const [rel, state] of listed) {
    if (state.untracked && !state.headOid && inSkippedDir(rel, state.dir)) continue
    dirty.add(rel)
    if (state.dir) continue
    if (state.xy?.[1] === 'D') absent.add(rel)
    else if (toStat.length >= snapshotFileCap) unfingerprinted.add(rel)
    else toStat.push(rel)
  }
  const present: WorkspaceFileFingerprint[] = []
  const stats = await mapLimit(toStat, CAPTURE_CONCURRENCY, (rel) => lstatOrNull(join(realRoot, ...rel.split('/'))))
  toStat.forEach((rel, i) => {
    const st = stats[i]
    if (!st) absent.add(rel)
    else if (st.isFile()) present.push({ rel, full: join(realRoot, ...rel.split('/')), mtimeMs: st.mtimeMs, size: st.size })
  })

  const files = new Map<string, WorkspaceFileFingerprint>()
  // Within each group, smaller first: more files fit the copy budget.
  present.sort((a, b) => {
    const ta = status.paths.get(a.rel)?.untracked ? 1 : 0
    const tb = status.paths.get(b.rel)?.untracked ? 1 : 0
    return ta - tb || a.size - b.size
  })
  const uncaptured = (await captureFingerprints(present, blobDir, files)) + unfingerprinted.size
  if (uncaptured > 0 && !uncapturedWarnedRoots.has(realRoot)) {
    uncapturedWarnedRoots.add(realRoot)
    logger.warn('Changed files kept without an undo copy before a command; a write to them cannot be undone', {
      scope: 'workspaceMutationWatch',
      uncaptured,
      dirty: dirty.size,
      cap: snapshotFileCap
    })
  }

  return {
    root: workspaceRoot,
    files,
    blobDir,
    startedAtMs,
    truncated: false,
    git: { prefix: tree.prefix, headOid: status.headOid, dirty, absent, unfingerprinted, headBlobs: new Map() }
  }
}

async function diffGitWatch(snapshot: WorkspaceSnapshot, base: GitBaseline): Promise<WorkspaceDiff> {
  const realRoot = canonicalizeWorkspacePath(snapshot.root)
  const fullOf = (rel: string): string => join(realRoot, ...rel.split('/'))
  const created: string[] = []
  const modified: string[] = []
  const deleted: string[] = []

  // 1. What was already changed or untracked: compare against its copy.
  const priorFiles = [...snapshot.files.values()]
  const verdicts = await mapLimit(priorFiles, CAPTURE_CONCURRENCY, async (before) => {
    const now = await lstatOrNull(before.full)
    if (!now || !now.isFile()) return 'deleted' as const
    if (before.mtimeMs !== now.mtimeMs || before.size !== now.size) return 'modified' as const
    if (before.contentHash && now.size <= SNAPSHOT_HASH_MAX_BYTES) {
      const contentHash = await hashFile(before.full)
      if (contentHash && contentHash !== before.contentHash) return 'modified' as const
    }
    return null
  })
  priorFiles.forEach((before, i) => {
    if (verdicts[i] === 'deleted') deleted.push(before.rel)
    else if (verdicts[i] === 'modified') modified.push(before.rel)
  })
  for (const rel of base.absent) {
    const now = await lstatOrNull(fullOf(rel))
    if (now?.isFile()) created.push(rel)
  }
  // Past the cap there is no fingerprint: only a fresh mtime says it changed.
  for (const rel of base.unfingerprinted) {
    const now = await lstatOrNull(fullOf(rel))
    if (!now) deleted.push(rel)
    else if (now.isFile() && now.mtimeMs >= snapshot.startedAtMs - CREATED_SLACK_MS) modified.push(rel)
  }

  // 2. Everything that was clean: whatever git now lists, plus whatever a
  // HEAD move rewrote.
  const after = await readGitStatusV2(realRoot, base.prefix)
  if (!after) {
    logger.warn('Git status failed after a command; only already-changed files were checked for undo', {
      scope: 'workspaceMutationWatch'
    })
    return { created, modified, deleted }
  }
  const candidates = new Map<string, { oid?: string; mode?: string; unknown?: boolean }>()
  // HEAD's side of a listed path is its prior content only while HEAD stayed
  // put, or for a path the move did not change.
  let headTrusted = true
  if (base.headOid !== after.headOid) {
    const moved = await readHeadMove(realRoot, base.prefix, base.headOid, after.headOid)
    headTrusted = moved != null
    if (!moved) {
      logger.warn('Could not list what a HEAD move changed; those files are not undoable', {
        scope: 'workspaceMutationWatch'
      })
    } else {
      for (const [rel, old] of moved) if (!base.dirty.has(rel)) candidates.set(rel, old)
    }
  }
  const newDirs: string[] = []
  for (const [rel, state] of after.paths) {
    if (base.dirty.has(rel) || candidates.has(rel)) continue
    if (state.untracked && !state.headOid && inSkippedDir(rel, state.dir)) continue
    if (state.dir) {
      if (state.untracked) newDirs.push(rel)
      continue
    }
    // HEAD's side now is HEAD's side before, unless HEAD moved — and a path
    // the move changed was taken from the move above.
    if (!state.headOid) candidates.set(rel, {})
    else if (headTrusted) candidates.set(rel, { oid: state.headOid, mode: state.headMode })
    else candidates.set(rel, { unknown: true })
  }

  // 3. Prior content of the clean files that changed, from git.
  const requests: Array<{ rel: string; repoPath: string; oid: string }> = []
  for (const [rel, old] of candidates) {
    if (old.oid && isRegularMode(old.mode)) requests.push({ rel, repoPath: base.prefix + rel, oid: old.oid })
  }
  const blobs = await readPriorBlobs(realRoot, requests, snapshot.blobDir)
  for (const [rel, path] of blobs) base.headBlobs.set(rel, path)

  let uncaptured = 0
  for (const [rel, old] of candidates) {
    const now = await lstatOrNull(fullOf(rel))
    if (now && !now.isFile()) continue
    if (old.unknown) {
      // Tracked, but which content it had before is unknown: changed, no copy.
      if (now) modified.push(rel)
      else deleted.push(rel)
      uncaptured += 1
      continue
    }
    if (!old.oid) {
      if (now && bornDuringWatch(now, snapshot.startedAtMs)) created.push(rel)
      continue
    }
    // A symlink or submodule before: not something a file copy restores.
    if (!isRegularMode(old.mode)) continue
    const blob = blobs.get(rel)
    if (!now) {
      deleted.push(rel)
      if (!blob) uncaptured += 1
      continue
    }
    // Status lists index-only changes too; the file itself may be untouched.
    if (blob && (await sameContent(blob, fullOf(rel)))) continue
    // No copy to compare (too big): a file not written during the watch is
    // one only HEAD moved under (`reset --soft`), not one the command changed.
    if (!blob && now.mtimeMs < snapshot.startedAtMs - CREATED_SLACK_MS) continue
    modified.push(rel)
    if (!blob) uncaptured += 1
  }
  if (uncaptured > 0) {
    logger.warn('Files a command changed had no undo copy (over the size budget or not readable from git)', {
      scope: 'workspaceMutationWatch',
      uncaptured
    })
  }

  // 4. A new nested repository shows as one directory entry: walk it.
  let walkedNew = 0
  for (const dir of newDirs) {
    if (walkedNew >= snapshotFileCap) break
    const { files: inside } = await walkWorkspace(fullOf(dir), snapshotFileCap - walkedNew)
    walkedNew += inside.length
    for (const fp of inside) {
      const st = await lstatOrNull(fp.full)
      if (st && bornDuringWatch(st, snapshot.startedAtMs)) created.push(`${dir}/${fp.rel}`)
    }
  }
  return { created, modified, deleted }
}

export type { InvokeWriteCheckpoint }
