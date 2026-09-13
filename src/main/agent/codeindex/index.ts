import { existsSync } from 'fs'
import { isAbortError } from '../../../shared/errors'
import { getOrOpenCodeIndexStore, closeCodeIndexStore } from './storeCache'
import { codeindexDbPath } from '../indexStoragePaths'
import { syncCodeIndex } from './sync'
import { searchCodeIndex, formatSearchHits } from './query'
import type { WalkedFile } from '../tools/walk'
import type { CodebaseSearchHit, IndexStatus, SyncResult } from './types'
import { setCodeIndexRuntimeStatus } from './status'
import { clearIndexSyncProgress } from './indexProgress'
import { enqueueIndexJob } from '../indexJobQueue'
// Static imports despite the module cycle (workspaceIndex imports this barrel):
// both sides only touch each other's bindings after module evaluation, so the
// cycle is safe.
import { warmWorkspaceIndexes, workspaceIndexSearchSignal } from '../workspaceIndex'

export type { CodeChunk, CodebaseSearchHit, IndexStatus, SyncResult } from './types'
export type { CodeIndexRuntimeStatus } from '../../../shared/ipc/schemas/settings'
export { chunkSource } from './chunk'
export { sha256Text } from './hash'
export {
  CodeIndexStore,
  codeindexRoot,
  ftsQueryTokens,
  buildChunkFtsBody,
  literalRunForPattern
} from './store'
export { getOrOpenCodeIndexStore, closeCodeIndexStore } from './storeCache'
export { syncCodeIndex } from './sync'
export {
  INDEX_SCAN_CAP,
  CODE_INDEX_RECONCILE_WALK_CAP,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  CODE_INDEX_MAX_FILE_BYTES,
  MAX_CHUNK_CHARS
} from './types'
export { clearIndexSyncProgress, publishIndexSyncProgress } from './indexProgress'
export {
  searchCodeIndex,
  formatSearchHits,
  codebaseSearchHitPathsFromResult,
  collectDocsLexicalHits,
  queryIndexCandidates,
  queryIndexFileList,
  resolveCandidateFullPaths,
  type CandidateLookup
} from './query'
export { getCodeIndexRuntimeStatus, onCodeIndexRuntimeStatus } from './status'

function readCodeIndexEnabled(): boolean {
  try {
    const { getSettings } = require('@main/settings/settings') as typeof import('@main/settings/settings')
    return getSettings().codeIndex?.enabled !== false
  } catch {
    return true
  }
}

const locks = new Map<string, Promise<void>>()

export function workspaceKey(workspaceRoot: string): string {
  return process.platform === 'win32' ? workspaceRoot.toLowerCase() : workspaceRoot
}

/**
 * Interactive callers must not queue behind a wedged sync indefinitely.
 * Bounding only the *acquire* keeps long-but-honest syncs working while a
 * genuinely wedged holder degrades to a clear error.
 */
const INTERACTIVE_LOCK_WAIT_MS = 30_000

export class WorkspaceLockBusyError extends Error {
  readonly workspaceRoot: string
  constructor(workspaceRoot: string, waitedMs: number) {
    super(
      `Codebase index is busy for this workspace (waited ${Math.round(waitedMs / 1000)}s for the current index operation). Retry shortly.`
    )
    this.name = 'WorkspaceLockBusyError'
    this.workspaceRoot = workspaceRoot
  }
}

async function withWorkspaceLock<T>(
  workspaceRoot: string,
  fn: () => Promise<T>,
  opts: { waitTimeoutMs?: number } = {}
): Promise<T> {
  const key = workspaceKey(workspaceRoot)
  const prev = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  locks.set(key, prev.then(() => gate))
  const waitTimeoutMs = opts.waitTimeoutMs ?? 0
  if (waitTimeoutMs > 0) {
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new WorkspaceLockBusyError(workspaceRoot, waitTimeoutMs)),
          waitTimeoutMs
        )
        const onPrev = (): void => {
          clearTimeout(timer)
          resolve()
        }
        void prev.then(onPrev, onPrev)
      })
    } catch (err) {
      // Never acquired, but this slot is already chained into the queue —
      // resolving it is what lets the next waiter proceed at all.
      release()
      throw err
    }
  } else {
    await prev
  }
  try {
    return await fn()
  } finally {
    release()
  }
}

async function ensureCodeIndexSyncedUnlocked(
  workspaceRoot: string,
  opts: {
    signal?: AbortSignal
    force?: boolean
    files?: WalkedFile[]
    keepIndexingStatus?: boolean
  } = {}
): Promise<{ sync: SyncResult | null; disabled?: boolean }> {
  if (readCodeIndexEnabled() === false) {
    setCodeIndexRuntimeStatus({
      phase: 'idle',
      message: 'Codebase index disabled',
      error: null,
      indexProgress: null,
      progress: null
    })
    return { sync: null, disabled: true }
  }
  setCodeIndexRuntimeStatus({
    phase: 'syncing',
    message: opts.force ? 'Syncing codebase index' : 'Incremental sync',
    error: null,
    indexProgress: null
  })
  const store = getOrOpenCodeIndexStore(workspaceRoot)
  const sync = await syncCodeIndex(workspaceRoot, store, {
    signal: opts.signal,
    files: opts.files
  })
  const doneProgress = {
    stage: 'done' as const,
    filesDone: sync.scanned,
    filesTotal: sync.scanned,
    indexed: sync.indexed,
    skipped: sync.skipped,
    removed: sync.removed,
    currentPath: null
  }
  if (opts.keepIndexingStatus) {
    setCodeIndexRuntimeStatus({
      phase: 'syncing',
      message: `Code index synced · ${sync.indexed} updated · ${sync.skipped} skipped`,
      error: null,
      progress: 0.7,
      indexProgress: doneProgress
    })
  } else {
    clearIndexSyncProgress()
    setCodeIndexRuntimeStatus({
      phase: 'ready',
      message: `Index ready · ${sync.indexed} updated · ${sync.skipped} skipped`,
      error: null,
      progress: 1,
      indexProgress: doneProgress
    })
  }
  return { sync }
}

export async function ensureCodeIndexSynced(
  workspaceRoot: string,
  opts: {
    signal?: AbortSignal
    force?: boolean
    files?: WalkedFile[]
    keepIndexingStatus?: boolean
  } = {}
): Promise<{ sync: SyncResult | null; disabled?: boolean }> {
  return withWorkspaceLock(workspaceRoot, () =>
    ensureCodeIndexSyncedUnlocked(workspaceRoot, opts)
  )
}

function schedulePostSearchWarm(workspaceRoot: string): void {
  try {
    warmWorkspaceIndexes(workspaceRoot)
  } catch {
    // Search must never fail on warm.
  }
}

export type CodebaseSearchResult = {
  hits: CodebaseSearchHit[]
  status: IndexStatus
  formatted: string
}

function disabledSearchResult(): CodebaseSearchResult {
  return {
    hits: [],
    status: {
      ready: false,
      fileCount: 0,
      chunkCount: 0,
      lastIndexedAt: null,
      syncComplete: false
    },
    formatted: 'Codebase index is disabled (Settings → Indexing).'
  }
}

function formatCodebaseSearchResult(
  hits: CodebaseSearchHit[],
  status: IndexStatus
): CodebaseSearchResult {
  const formatted =
    hits.length > 0 || status.ready
      ? formatSearchHits(hits)
      : [
          formatSearchHits(hits),
          'Codebase index is still warming — results may be incomplete. Retry shortly or pass refresh:true.'
        ]
            .filter(Boolean)
            .join('\n')
  return { hits, status, formatted }
}

export async function runCodebaseSearch(
  workspaceRoot: string,
  query: string,
  opts: { limit?: number; signal?: AbortSignal; refresh?: boolean } = {}
): Promise<CodebaseSearchResult> {
  const searchSignal = workspaceIndexSearchSignal(workspaceRoot, opts.signal)

  const runQueuedInteractiveSearch = (): Promise<CodebaseSearchResult> =>
    enqueueIndexJob({
      priority: 'interactive',
      signal: searchSignal,
      run: () =>
        withWorkspaceLock(
          workspaceRoot,
          async () => {
            if (readCodeIndexEnabled() === false) return disabledSearchResult()
            // refresh=true forces a sync in this slot. Otherwise serve whatever
            // is already indexed and enqueue a warm sync after we release the
            // queue — a cold full sync inside interactive would starve every
            // later search.
            if (opts.refresh === true) {
              const { sync, disabled } = await ensureCodeIndexSyncedUnlocked(workspaceRoot, {
                signal: searchSignal,
                force: true
              })
              if (disabled || !sync) return disabledSearchResult()
            }
            const store = getOrOpenCodeIndexStore(workspaceRoot)
            let status = store.getStatus()
            if (!status.ready && status.chunkCount === 0) {
              const { sync } = await ensureCodeIndexSyncedUnlocked(workspaceRoot, {
                signal: searchSignal,
                force: true
              })
              status = sync?.status ?? status
            }
            const hits = await searchCodeIndex(workspaceRoot, store, query, {
              limit: opts.limit,
              signal: searchSignal
            })
            return formatCodebaseSearchResult(hits, status)
          },
          { waitTimeoutMs: INTERACTIVE_LOCK_WAIT_MS }
        )
    })

  // Ready store: a plain SQLite read on main — skip the global concurrency-1
  // slot so parallel codebase_search calls can overlap. refresh / disabled /
  // missing DB / cold store stay queued.
  if (opts.refresh !== true && readCodeIndexEnabled() && existsSync(codeindexDbPath(workspaceRoot))) {
    try {
      const store = getOrOpenCodeIndexStore(workspaceRoot)
      const status = store.getStatus()
      if (status.ready || status.chunkCount !== 0) {
        const hits = await searchCodeIndex(workspaceRoot, store, query, {
          limit: opts.limit,
          signal: searchSignal
        })
        const result = formatCodebaseSearchResult(hits, status)
        schedulePostSearchWarm(workspaceRoot)
        return result
      }
      // Cold store: the first sync stays inside enqueueIndexJob.
    } catch (err) {
      if (isAbortError(err) || searchSignal.aborted) throw err
      // busy/locked/missing store — queued path below.
    }
  }

  const result = await runQueuedInteractiveSearch()
  schedulePostSearchWarm(workspaceRoot)
  return result
}

export function disposeCodeIndexWorkspace(workspaceRoot: string): void {
  closeCodeIndexStore(workspaceRoot)
}

/** Force reindex (settings UI). */
export async function reindexCodeIndex(
  workspaceRoot: string,
  opts: { signal?: AbortSignal } = {}
): Promise<SyncResult | null> {
  const key = workspaceKey(workspaceRoot)
  return enqueueIndexJob({
    priority: 'reindex',
    coalesceKey: `reindex:${key}`,
    signal: opts.signal,
    run: async () => {
      const { sync } = await ensureCodeIndexSynced(workspaceRoot, {
        force: true,
        signal: opts.signal
      })
      return sync
    }
  })
}
