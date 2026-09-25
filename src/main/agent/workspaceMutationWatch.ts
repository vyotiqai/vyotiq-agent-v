import { copyFile, mkdir, readdir, rm, stat } from 'fs/promises'
import { createReadStream } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { canonicalizeWorkspacePath } from '../../shared/utils/workspacePath'
import { IGNORED_DIRS, yieldToEventLoop } from './tools/walk'
import { getWriteCheckpoint, type InvokeWriteCheckpoint } from './checkpoints'
import { logger } from '../../shared/logger'

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
}

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

/** Take a pre-mutation workspace fingerprint (with prior blobs for small files). */
export async function startWatch(workspaceRoot: string): Promise<WorkspaceSnapshot> {
  const blobDir = join(tmpdir(), `vyotiq-ws-snap-${process.pid}-${randomUUID()}`)
  await mkdir(blobDir, { recursive: true })
  const files = new Map<string, WorkspaceFileFingerprint>()
  // Read the clock before the walk: a file written while the walk is still
  // running must count as created, not be dated before the watch began.
  const startedAtMs = Date.now()
  const { files: walked, truncated } = await walkWorkspace(workspaceRoot, snapshotFileCap)
  let totalBlobBytes = 0
  let totalHashBytes = 0
  for (const fp of walked) {
    let blobPath: string | undefined
    let contentHash: string | undefined
    if (
      fp.size <= SNAPSHOT_BLOB_FILE_MAX_BYTES &&
      totalBlobBytes + fp.size <= SNAPSHOT_BLOB_TOTAL_MAX_BYTES
    ) {
      try {
        const dest = join(blobDir, ...fp.rel.split('/'))
        await mkdir(dirname(dest), { recursive: true })
        await copyFile(fp.full, dest)
        blobPath = dest
        totalBlobBytes += fp.size
      } catch {
        blobPath = undefined
      }
    }
    // Hash small files for same-size rewrite detection (build runners touch
    // files exactly this way), bounded by SNAPSHOT_HASH_TOTAL_MAX_BYTES like
    // the blob budget: the walk order is BFS (root files before subdirs), so
    // the first files to fit are also the most checkpoint-relevant. A
    // same-size in-place rewrite of a budget-exhausted file is mtime/size
    // diff only — the trade the blob budget already makes.
    if (fp.size <= SNAPSHOT_HASH_MAX_BYTES && totalHashBytes + fp.size <= SNAPSHOT_HASH_TOTAL_MAX_BYTES) {
      contentHash = await hashFile(fp.full)
      if (contentHash != null) totalHashBytes += fp.size
    }
    files.set(fp.rel, { ...fp, blobPath, contentHash })
  }
  return { root: workspaceRoot, files, blobDir, startedAtMs, truncated }
}

export async function diffSince(snapshot: WorkspaceSnapshot): Promise<WorkspaceDiff> {
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

  for (const rel of diff.created) {
    await cp.recordObservedMutation(rel, 'created')
  }
  for (const rel of diff.modified) {
    const prior = snapshot.files.get(rel)
    await cp.recordObservedMutation(rel, 'modified', prior?.blobPath)
  }
  for (const rel of diff.deleted) {
    const prior = snapshot.files.get(rel)
    await cp.recordObservedMutation(rel, 'deleted', prior?.blobPath)
  }
}

export type { InvokeWriteCheckpoint }
