/**
 * Shared warm/debounce for the code index.
 * Indexes live under Electron userData/workspaces/{id}/ — not `.vyotiq/`.
 * Warm is serialized via the global index job queue.
 */
import { existsSync, rmSync } from 'fs'
import { ensureCodeIndexSynced, disposeCodeIndexWorkspace } from './codeindex'
import { throwIfAborted } from './tools/walk'
import { legacyCodeindexRoot, legacySparsegrepRoot } from './indexStoragePaths'
import { isAbortError } from '../../shared/errors'
import { logger } from '../../shared/logger'
import { logErrorSummary } from '../../shared/utils/logPolicy'
import {
  activeIndexJobPreemptSignal,
  dropPendingByCoalesceKey,
  enqueueIndexJob,
  IndexQueueFullError
} from './indexJobQueue'
import { clearIndexSyncProgress } from './codeindex/indexProgress'
import { setCodeIndexRuntimeStatus } from './codeindex/status'
import { isHeapPressureHigh } from '../perf/heapPressure'
import { workspaceIndexStorageDir } from './indexStoragePaths'
import { join } from 'path'

export const WORKSPACE_INDEX_DEBOUNCE_MS = 1500

function workspaceKey(workspaceRoot: string): string {
  return process.platform === 'win32' ? workspaceRoot.toLowerCase() : workspaceRoot
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()
const abortControllers = new Map<string, AbortController>()
/** Worktrees torn down permanently — block warm/search after instance finalize. */
const permanentlyDisposedKeys = new Set<string>()

function controllerFor(workspaceRoot: string): AbortController {
  const key = workspaceKey(workspaceRoot)
  let c = abortControllers.get(key)
  if (!c || c.signal.aborted) {
    c = new AbortController()
    abortControllers.set(key, c)
  }
  return c
}

export function workspaceIndexAbortSignal(workspaceRoot: string): AbortSignal {
  const key = workspaceKey(workspaceRoot)
  if (permanentlyDisposedKeys.has(key)) {
    const ac = new AbortController()
    ac.abort()
    return ac.signal
  }
  return controllerFor(workspaceRoot).signal
}

/** Combine workspace dispose with caller abort (codebase_search interactive jobs). */
export function workspaceIndexSearchSignal(
  workspaceRoot: string,
  callerSignal?: AbortSignal
): AbortSignal {
  return combineSignals(workspaceIndexAbortSignal(workspaceRoot), callerSignal)
}

function combineSignals(...signals: Array<AbortSignal | null | undefined>): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => s != null)
  if (list.length === 0) {
    return new AbortController().signal
  }
  if (list.length === 1) return list[0]!
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(list)
  }
  const ac = new AbortController()
  const onAbort = (): void => ac.abort()
  for (const s of list) {
    if (s.aborted) {
      ac.abort()
      return ac.signal
    }
    s.addEventListener('abort', onAbort, { once: true })
  }
  return ac.signal
}

function removeDirBestEffort(root: string, label: string): void {
  if (!existsSync(root)) return
  try {
    rmSync(root, { recursive: true, force: true })
    logger.info('Removed legacy index dir', { scope: 'workspaceIndex', root, label })
  } catch (err) {
    logger.warn('Failed to remove legacy index dir', { scope: 'workspaceIndex', root, err })
  }
}

/** Drop pre-migration caches: in-workspace dirs and the obsolete sparse store. */
export function removeLegacyWorkspaceIndexDirs(workspaceRoot: string): void {
  removeDirBestEffort(legacyCodeindexRoot(workspaceRoot), 'legacy-codeindex')
  removeDirBestEffort(legacySparsegrepRoot(workspaceRoot), 'legacy-sparsegrep')
  removeDirBestEffort(
    join(workspaceIndexStorageDir(workspaceRoot), 'sparsegrep'),
    'obsolete-sparsegrep'
  )
}

/**
 * Warm the code index (boot / workspace open / scheduled sync) via a single
 * background job. Sync is an incremental SQLite pass — no models, no child
 * process. Large workspaces page: an incomplete sync resumes on the next warm
 * (every mutation and every codebase_search re-warms).
 */
export function warmWorkspaceIndexes(
  workspaceRoot: string,
  opts: { warmCodeIndex?: boolean } = {}
): void {
  const warmCodeIndex = opts.warmCodeIndex !== false
  if (!workspaceRoot.trim()) return
  const key = workspaceKey(workspaceRoot)
  if (permanentlyDisposedKeys.has(key)) return
  // Near the V8 ceiling, background index work must not allocate: the walk,
  // hashing and SQLite writes run on main, and the last-resort GC that follows
  // an allocation failure is a hard process abort. Indexes simply stay
  // warm-as-is; every mutation/search retries once pressure drops.
  if (isHeapPressureHigh()) {
    logger.debug('Workspace index warm skipped under heap pressure', {
      scope: 'workspaceIndex',
      workspace: workspaceRoot
    })
    return
  }
  removeLegacyWorkspaceIndexDirs(workspaceRoot)
  const coalesceKey = `warm:${key}`

  void enqueueIndexJob({
    priority: 'warm',
    coalesceKey,
    run: async () => {
      // Resolve dispose signal inside run so coalesce+dispose+reopen does not pin a stale abort.
      const disposeSignal = controllerFor(workspaceRoot).signal
      const signal = combineSignals(disposeSignal, activeIndexJobPreemptSignal())
      try {
        throwIfAborted(signal)
        logger.debug('Workspace index warm started', { scope: 'workspaceIndex', warmCodeIndex })
        throwIfAborted(signal)
        if (!warmCodeIndex) {
          clearIndexSyncProgress()
          setCodeIndexRuntimeStatus({ phase: 'idle', progress: 1, message: null, error: null })
          return
        }
        const { sync } = await ensureCodeIndexSynced(workspaceRoot, {
          signal,
          keepIndexingStatus: true
        })
        if (sync) {
          const changed = sync.indexed > 0 || sync.removed > 0
          ;(changed ? logger.info.bind(logger) : logger.debug.bind(logger))('Code index warm sync', {
            scope: 'workspaceIndex',
            workspace: workspaceRoot,
            scanned: sync.scanned,
            indexed: sync.indexed,
            skipped: sync.skipped,
            removed: sync.removed,
            complete: sync.syncComplete,
            cursor: sync.cursor
          })
        }
        clearIndexSyncProgress()
        setCodeIndexRuntimeStatus({
          phase: 'ready',
          message: sync ? `Index ready · ${sync.indexed} updated · ${sync.skipped} skipped` : 'Index ready',
          error: null,
          progress: 1,
          indexProgress: null
        })
      } catch (err) {
        if (signal.aborted || isAbortError(err)) return
        throw err
      }
    }
  }).catch((err: unknown) => {
    const disposeSignal = abortControllers.get(key)?.signal
    if (disposeSignal?.aborted || isAbortError(err)) return
    if (err instanceof IndexQueueFullError) return
    logger.warn('Workspace index warm failed', {
      scope: 'workspaceIndex',
      reason: logErrorSummary(err)
    })
    setCodeIndexRuntimeStatus({
      phase: 'error',
      message: null,
      error: 'Workspace index sync failed. Click Reindex workspace to retry.',
      progress: null,
      indexProgress: null
    })
  })
}

/** Debounced sync after mutations. */
export function scheduleWorkspaceIndexSync(
  workspaceRoot: string,
  delayMs: number = WORKSPACE_INDEX_DEBOUNCE_MS
): void {
  if (!workspaceRoot.trim()) return
  // Instance worktrees index on first codebase_search, not on every mutation.
  if (workspaceRoot.replace(/\\/g, '/').split('/').includes('instance-worktrees')) return
  const key = workspaceKey(workspaceRoot)
  const prev = timers.get(key)
  if (prev) clearTimeout(prev)
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      warmWorkspaceIndexes(workspaceRoot)
    }, delayMs)
  )
}

export type DisposeWorkspaceIndexesOptions = {
  /** Instance worktree finalize — never warm or search this root again. */
  permanent?: boolean
}

export function disposeWorkspaceIndexes(
  workspaceRoot: string,
  opts: DisposeWorkspaceIndexesOptions = {}
): void {
  const key = workspaceKey(workspaceRoot)
  if (opts.permanent === true) {
    permanentlyDisposedKeys.add(key)
  }
  const prev = timers.get(key)
  if (prev) clearTimeout(prev)
  timers.delete(key)
  dropPendingByCoalesceKey(`warm:${key}`)
  dropPendingByCoalesceKey(`reindex:${key}`)
  const ac = abortControllers.get(key)
  if (ac) {
    ac.abort()
    abortControllers.delete(key)
  }
  disposeCodeIndexWorkspace(workspaceRoot)
}

/** Test helper. */
export function clearWorkspaceIndexSyncTimers(): void {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  for (const ac of abortControllers.values()) ac.abort()
  abortControllers.clear()
  permanentlyDisposedKeys.clear()
}
