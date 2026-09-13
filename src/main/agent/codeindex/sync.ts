import { promises as fsp } from 'fs'
import { chunkSource } from './chunk'
import { sha256Text } from './hash'
import { buildChunkFtsBody, type CodeIndexStore } from './store'
import {
  CODE_INDEX_EXTS,
  collectWorkspaceFiles,
  collectWorkspaceFilesPage,
  INDEX_SKIP_DIR_SEGMENTS,
  isIndexableSourcePath,
  throwIfAborted,
  yieldToEventLoop,
  type WalkedFile
} from '../tools/walk'
import { CODE_INDEX_MAX_FILE_BYTES, CODE_INDEX_RECONCILE_WALK_CAP, INDEX_SCAN_CAP, type IndexStatus, type SyncResult } from './types'
import { publishIndexSyncProgress, type IndexProgressUpdate } from './indexProgress'

/** Yield periodically so crawl/SQLite on main stays responsive. */
const YIELD_EVERY = 32
const PROGRESS_THROTTLE_MS = 75

function roundMtime(mtimeMs: number): number {
  return Math.round(mtimeMs)
}

function isMissingPathError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err != null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  )
}

export type SyncCodeIndexOptions = {
  signal?: AbortSignal
  /**
   * Optional precollected walk. When `pageCap` is set and the list is at least
   * that long, treat as a partial page (do not `deleteFilesNotIn`).
   */
  files?: WalkedFile[]
  /** Optional progress sink (defaults to publishIndexSyncProgress). */
  onProgress?: (update: IndexProgressUpdate, opts?: { force?: boolean }) => void
  /** Page size for paged walks. Tests pass a small cap; production uses INDEX_SCAN_CAP. */
  pageCap?: number
}

type ReadTextResult = { ok: true; text: string } | { ok: false; missing: boolean }
type StatResult =
  | { ok: true; size: number; mtimeMs: number }
  | { ok: false; missing: boolean }

async function readTextFile(full: string): Promise<ReadTextResult> {
  try {
    return { ok: true, text: await fsp.readFile(full, 'utf8') }
  } catch (err) {
    return { ok: false, missing: isMissingPathError(err) }
  }
}

async function statFile(full: string): Promise<StatResult> {
  try {
    const st = await fsp.stat(full)
    if (!st.isFile()) return { ok: false, missing: false }
    return { ok: true, size: st.size, mtimeMs: st.mtimeMs }
  } catch (err) {
    return { ok: false, missing: isMissingPathError(err) }
  }
}

function report(
  onProgress: SyncCodeIndexOptions['onProgress'],
  update: IndexProgressUpdate,
  opts?: { force?: boolean }
): void {
  if (onProgress) {
    onProgress(update, opts)
    return
  }
  publishIndexSyncProgress(update, opts)
}

/** Throttle custom onProgress sinks the same way as publishIndexSyncProgress. */
function createThrottledProgress(
  onProgress: SyncCodeIndexOptions['onProgress']
): SyncCodeIndexOptions['onProgress'] {
  if (!onProgress) return undefined
  let last = 0
  return (update, opts) => {
    const now = Date.now()
    if (!opts?.force && now - last < PROGRESS_THROTTLE_MS) return
    last = now
    onProgress(update, opts)
  }
}

async function collectCodeIndexPage(
  workspaceRoot: string,
  store: CodeIndexStore,
  pageCap: number | undefined,
  signal: AbortSignal | undefined
): Promise<{
  files: WalkedFile[]
  exhausted: boolean
  lastRel: string | null
  startAfter: string | undefined
}> {
  const priorCursor = store.getMeta('syncCursor')
  let startAfter = priorCursor && priorCursor.length > 0 ? priorCursor : undefined
  let page = await collectWorkspaceFilesPage(
    workspaceRoot,
    pageCap,
    startAfter,
    signal,
    CODE_INDEX_EXTS,
    INDEX_SKIP_DIR_SEGMENTS
  )
  if (startAfter && page.cursorMissing) {
    store.setMeta('syncCursor', '')
    startAfter = undefined
    page = await collectWorkspaceFilesPage(
      workspaceRoot,
      pageCap,
      undefined,
      signal,
      CODE_INDEX_EXTS,
      INDEX_SKIP_DIR_SEGMENTS
    )
  }
  return {
    files: page.files.filter((f) => isIndexableSourcePath(f.rel, f.full)),
    exhausted: page.exhausted,
    lastRel: page.lastRel,
    startAfter
  }
}

export async function syncCodeIndex(
  workspaceRoot: string,
  store: CodeIndexStore,
  signalOrOpts?: AbortSignal | SyncCodeIndexOptions
): Promise<SyncResult> {
  const opts: SyncCodeIndexOptions =
    signalOrOpts != null && typeof signalOrOpts === 'object' && !('aborted' in signalOrOpts)
      ? signalOrOpts
      : { signal: signalOrOpts as AbortSignal | undefined }
  const signal = opts.signal
  const onProgress = createThrottledProgress(opts.onProgress)

  throwIfAborted(signal)
  report(
    onProgress,
    { stage: 'walking', filesDone: 0, filesTotal: 0, indexed: 0, skipped: 0, currentPath: null },
    { force: true }
  )

  let files: WalkedFile[]
  let batchComplete = true
  let pageLastRel: string | null = null
  let pageStartAfter: string | undefined
  const pageCap = opts.pageCap ?? INDEX_SCAN_CAP

  if (opts.files != null) {
    files = opts.files.filter((f) => isIndexableSourcePath(f.rel, f.full))
    const capped =
      opts.pageCap != null && Number.isFinite(opts.pageCap) && opts.files.length >= opts.pageCap
    batchComplete = !capped
  } else {
    const page = await collectCodeIndexPage(workspaceRoot, store, pageCap, signal)
    files = page.files
    pageLastRel = page.lastRel
    pageStartAfter = page.startAfter
    batchComplete =
      page.exhausted || (pageCap != null && Number.isFinite(pageCap) && page.files.length < pageCap)
  }
  throwIfAborted(signal)
  const filesTotal = files.length
  const seen = new Set<string>()
  let indexed = 0
  let skipped = 0
  let filesDone = 0
  let currentPath: string | null = null

  const progressUpdate = (): IndexProgressUpdate => ({
    stage: 'scanning',
    filesDone,
    filesTotal,
    indexed,
    skipped,
    currentPath
  })

  report(onProgress, { ...progressUpdate(), filesDone: 0, currentPath: null }, { force: true })

  for (let i = 0; i < files.length; i++) {
    throwIfAborted(signal)
    if (i > 0 && i % YIELD_EVERY === 0) {
      await yieldToEventLoop()
      throwIfAborted(signal)
    }
    const { full, rel } = files[i]!
    filesDone = i + 1
    currentPath = rel
    const st = await statFile(full)
    if (!st.ok) {
      if (!st.missing && store.getFileStamp(rel)) seen.add(rel)
      skipped++
      report(onProgress, progressUpdate())
      continue
    }
    if (st.size > CODE_INDEX_MAX_FILE_BYTES) {
      skipped++
      report(onProgress, progressUpdate())
      continue
    }
    const mtimeMs = roundMtime(st.mtimeMs)
    const stamp = store.getFileStamp(rel)
    if (stamp && stamp.mtimeMs === mtimeMs && stamp.size === st.size) {
      seen.add(rel)
      skipped++
      report(onProgress, progressUpdate())
      continue
    }
    const textResult = await readTextFile(full)
    if (!textResult.ok) {
      if (!textResult.missing && store.getFileStamp(rel)) seen.add(rel)
      skipped++
      report(onProgress, progressUpdate())
      continue
    }
    const text = textResult.text
    if (text.includes('\0')) {
      skipped++
      report(onProgress, progressUpdate())
      continue
    }
    const fileHash = sha256Text(text)
    if (store.getFileStamp(rel)?.hash === fileHash) {
      store.updateFileStamp(rel, fileHash, mtimeMs, st.size)
      seen.add(rel)
      skipped++
      report(onProgress, progressUpdate())
      continue
    }
    const chunks = chunkSource(rel, text)
    store.replaceFileChunks(
      rel,
      fileHash,
      mtimeMs,
      st.size,
      chunks.map((c) => ({
        startLine: c.startLine,
        endLine: c.endLine,
        kind: c.kind,
        name: c.name,
        parentName: c.parentName,
        ftsBody: buildChunkFtsBody(rel, c)
      }))
    )
    seen.add(rel)
    indexed++
    report(onProgress, progressUpdate())
  }

  let removed = 0
  const partial = !batchComplete
  let syncComplete = batchComplete
  let cursor: string | null = batchComplete ? null : pageLastRel

  if (batchComplete) {
    store.setMeta('syncComplete', 'true')
    store.setMeta('syncCursor', '')
    report(
      onProgress,
      { stage: 'reconciling', filesDone: filesTotal, filesTotal, indexed, skipped, currentPath: null },
      { force: true }
    )
    throwIfAborted(signal)
    let reconcileSeen: Set<string>
    if (opts.files != null || pageStartAfter == null) {
      reconcileSeen = seen
    } else {
      const allFiles = await collectWorkspaceFiles(
        workspaceRoot,
        Math.max(CODE_INDEX_RECONCILE_WALK_CAP, pageCap * 2),
        signal,
        CODE_INDEX_EXTS,
        INDEX_SKIP_DIR_SEGMENTS
      )
      throwIfAborted(signal)
      reconcileSeen = new Set<string>()
      for (const f of allFiles) {
        if (!isIndexableSourcePath(f.rel, f.full)) continue
        const st = await statFile(f.full)
        if (st.ok) reconcileSeen.add(f.rel)
        else if (!st.missing && store.getFileStamp(f.rel)) reconcileSeen.add(f.rel)
      }
    }
    removed = store.deleteFilesNotIn(reconcileSeen)
  } else {
    store.setMeta('syncComplete', 'false')
    if (pageLastRel) store.setMeta('syncCursor', pageLastRel)
  }

  store.setMeta('lastIndexedAt', new Date().toISOString())
  report(
    onProgress,
    {
      stage: 'done',
      filesDone: filesTotal,
      filesTotal,
      indexed,
      skipped,
      removed,
      currentPath: null
    },
    { force: true }
  )

  const status: IndexStatus = store.getStatus()
  return {
    scanned: files.length,
    indexed,
    skipped,
    removed,
    status,
    partial,
    syncComplete,
    cursor
  }
}
