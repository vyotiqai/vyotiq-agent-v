/**
 * Worktree instance index inheritance.
 *
 * When a write-capable instance is spawned into a git worktree, the child
 * resolves its own index storage (workspaceIndexStorageId is keyed by the
 * canonical worktree path), so its first codebase_search would cold-start a
 * full walk + chunk + index of code identical to the parent workspace. The
 * store skips unchanged files by mtime+size → SHA-256 (codeindex/sync.ts), so
 * copying the parent's index DB into the child's storage at spawn makes the
 * child instantly warm at the cost of one local file copy.
 *
 * Copy strategy (chosen from verified store evidence):
 * - CodeIndexStore uses node:sqlite DatabaseSync with `PRAGMA journal_mode =
 *   WAL` (codeindex/store.ts) and a single `index.sqlite` per index dir.
 * - We do NOT open the parent DB to take a VACUUM INTO snapshot: even a
 *   read-only connection can create/attach -shm/-wal files under the parent's
 *   storage dir, and DatabaseSync would block the main thread. Instead we copy
 *   `index.sqlite` + `index.sqlite-wal` (if present) with fs/promises and
 *   never touch the parent's -shm (transient; rebuilt on open).
 * - The copy is validated read-only (`PRAGMA quick_check`) before it is left
 *   behind; a torn copy from a concurrent parent write is removed so the
 *   child falls back to cold-start indexing instead of a corrupt DB.
 *
 * The helper is best-effort: failures are collected and warned, and it never
 * throws — a failed copy only costs the child its warm start.
 */
import { copyFile, mkdir, rm, stat } from 'fs/promises'
import { basename, join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { codeindexDbPath, codeindexRoot } from './indexStoragePaths'
import { logger } from '../../shared/logger'

const DB_FILENAME = 'index.sqlite'
const WAL_SUFFIX = '-wal'
// The copy runs synchronously per spawn inside the spawn path; a pathological
// multi-hundred-MB parent DB would stall every instance start. Past this,
// skip the copy — the child cold-starts.
const MAX_INHERIT_DB_BYTES = 512 * 1024 * 1024

type IndexPair = {
  label: 'codeindex'
  srcRoot: string
  dstRoot: string
  srcDb: string
}

function indexPairs(parentWorkspacePath: string, worktreePath: string): IndexPair[] {
  return [
    {
      label: 'codeindex',
      srcRoot: codeindexRoot(parentWorkspacePath),
      dstRoot: codeindexRoot(worktreePath),
      srcDb: codeindexDbPath(parentWorkspacePath)
    }
  ]
}

/** Open a DB read-only and run quick_check; false on any open/check failure. */
function quickCheckReadOnly(dbPath: string): boolean {
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const row = db.prepare('PRAGMA quick_check').get() as
      | { quick_check?: string }
      | undefined
    return row?.quick_check === 'ok'
  } catch {
    return false
  } finally {
    try {
      db?.close()
    } catch {
      /* already closed */
    }
  }
}

/**
 * Copy one parent index (db + WAL) into the worktree's storage dir.
 * Missing parent DB → clean no-op. Throws only on copy/validation failure so
 * the caller can collect; never writes anything under the parent's storage.
 */
async function copyIndex(pair: IndexPair, maxDbBytes: number): Promise<void> {
  let src
  try {
    src = await stat(pair.srcDb)
  } catch {
    return // parent has no index for this store yet — nothing to inherit
  }
  if (!src.isFile()) return
  if (src.size > maxDbBytes) {
    logger.warn('indexInheritance: parent index too large to inherit; child cold-starts', {
      scope: 'indexInheritance',
      index: pair.label,
      bytes: src.size
    })
    return
  }

  await mkdir(pair.dstRoot, { recursive: true })
  const dstDb = join(pair.dstRoot, basename(pair.srcDb))
  const dstWal = dstDb + WAL_SUFFIX
  await copyFile(pair.srcDb, dstDb)
  try {
    await copyFile(pair.srcDb + WAL_SUFFIX, dstWal)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
  }

  if (!quickCheckReadOnly(dstDb)) {
    // Torn copy (parent wrote mid-copy) or unreadable source — remove it so
    // the child cold-starts cleanly instead of opening a corrupt DB.
    await rm(dstDb, { force: true })
    await rm(dstWal, { force: true })
    throw new Error(`indexInheritance: quick_check failed for copied ${pair.label} DB`)
  }
}

/**
 * Copy the parent workspace's code index DB into the instance worktree's
 * index storage so the child's first codebase_search is warm.
 *
 * Best-effort and non-fatal: failures are logged (warn) and collected, never
 * thrown. The parent's storage dir is only ever read — nothing is written,
 * locked, or deleted there.
 */
export async function copyWorkspaceIndexesForInstance(
  parentWorkspacePath: string,
  worktreePath: string,
  opts?: { maxDbBytes?: number }
): Promise<void> {
  const maxDbBytes = opts?.maxDbBytes ?? MAX_INHERIT_DB_BYTES
  const failed: string[] = []
  for (const pair of indexPairs(parentWorkspacePath, worktreePath)) {
    try {
      await copyIndex(pair, maxDbBytes)
    } catch (err) {
      failed.push(pair.label)
      logger.warn('indexInheritance: failed to copy parent index into worktree', {
        scope: 'indexInheritance',
        index: pair.label,
        err
      })
    }
  }
}
