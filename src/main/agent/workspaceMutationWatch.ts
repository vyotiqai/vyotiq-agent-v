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

async function walkWorkspace(
  root: string,
  cap: number
): Promise<WorkspaceFileFingerprint[]> {
  const realRoot = canonicalizeWorkspacePath(root)
  const out: WorkspaceFileFingerprint[] = []
  const queue: Array<{ dir: string; relDir: string }> = [{ dir: realRoot, relDir: '' }]
  let dirsVisited = 0

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
    for (const entry of entries) {
      if (out.length >= cap) break
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
  if (out.length >= cap) {
    logger.warn('Workspace snapshot file cap reached; checkpoint diff may be incomplete', {
      scope: 'workspaceMutationWatch',
      cap,
      root: realRoot
    })
  }
  return out
}

/** Take a pre-mutation workspace fingerprint (with prior blobs for small files). */
export async function startWatch(workspaceRoot: string): Promise<WorkspaceSnapshot> {
  const blobDir = join(tmpdir(), `vyotiq-ws-snap-${process.pid}-${randomUUID()}`)
  await mkdir(blobDir, { recursive: true })
  const files = new Map<string, WorkspaceFileFingerprint>()
  const walked = await walkWorkspace(workspaceRoot, SNAPSHOT_FILE_CAP)
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
  return { root: workspaceRoot, files, blobDir }
}

export async function diffSince(snapshot: WorkspaceSnapshot): Promise<WorkspaceDiff> {
  const walked = await walkWorkspace(snapshot.root, SNAPSHOT_FILE_CAP)
  const current = new Map(walked.map((f) => [f.rel, f] as const))
  const created: string[] = []
  const modified: string[] = []
  const deleted: string[] = []

  for (const [rel, now] of current) {
    const before = snapshot.files.get(rel)
    if (!before) {
      created.push(rel)
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
  for (const rel of snapshot.files.keys()) {
    if (!current.has(rel)) deleted.push(rel)
  }
  return { created, modified, deleted }
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
