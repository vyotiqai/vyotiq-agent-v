/**
 * Global index job queue: single flight across workspaces.
 * Interactive search/ensure runs ahead of background warm/reindex.
 * In-flight warm is preempted when interactive work enqueues (then re-queued).
 */
import { logger } from '../../shared/logger'

export type IndexJobPriority = 'interactive' | 'reindex' | 'warm'

const PRIORITY_RANK: Record<IndexJobPriority, number> = {
  interactive: 0,
  reindex: 1,
  warm: 2
}

export const INDEX_JOB_QUEUE_MAX_PENDING = 32

export class IndexQueueFullError extends Error {
  readonly code = 'INDEX_QUEUE_FULL'
  constructor(message = 'Index job queue full') {
    super(message)
    this.name = 'IndexQueueFullError'
  }
}

type AbortBinding = { signal: AbortSignal; onAbort: () => void }

type PendingJob = {
  priority: IndexJobPriority
  coalesceKey?: string
  run: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
  abortBindings: AbortBinding[]
  preemptController?: AbortController
  preemptRequested?: boolean
}

type TrailingDirty = {
  priority: IndexJobPriority
  run: () => Promise<unknown>
}

const pending: PendingJob[] = []
let pumping = false
let activeJob: PendingJob | null = null
const coalescePromises = new Map<string, Promise<unknown>>()
/** Coalesce keys that joined while a job was in-flight — one trailing rerun after settle. */
const trailingDirty = new Map<string, TrailingDirty>()

function clearCoalesceState(key: string): void {
  coalescePromises.delete(key)
  trailingDirty.delete(key)
}

function markTrailingDirty(
  key: string,
  priority: IndexJobPriority,
  run: () => Promise<unknown>
): void {
  trailingDirty.set(key, { priority, run })
}

function bindCoalescePromise(key: string, promise: Promise<unknown>): void {
  coalescePromises.set(key, promise)
  // finally() re-rejects on failure — must attach a catch or it becomes unhandled.
  void promise
    .finally(() => {
      if (coalescePromises.get(key) === promise) coalescePromises.delete(key)
      scheduleTrailingIfDirty(key)
    })
    .catch(() => {})
}

function scheduleTrailingIfDirty(key: string): void {
  const dirty = trailingDirty.get(key)
  if (!dirty) return
  trailingDirty.delete(key)
  // Preempt already requeued this key — that copy is the trailing run.
  if (findPendingByCoalesceKey(key) || coalescePromises.has(key)) return
  void enqueueIndexJob({
    priority: dirty.priority,
    coalesceKey: key,
    run: dirty.run
  }).catch(() => {})
}

function insertByPriority(job: PendingJob): void {
  let i = 0
  while (i < pending.length && PRIORITY_RANK[pending[i]!.priority] <= PRIORITY_RANK[job.priority]) {
    i++
  }
  pending.splice(i, 0, job)
}

function dropOldestWarm(): boolean {
  // Scan from the head: insertByPriority appends newer warm jobs toward the
  // tail, so the oldest warm request is the first warm entry.
  for (let i = 0; i < pending.length; i++) {
    if (pending[i]!.priority !== 'warm') continue
    const dropped = pending.splice(i, 1)[0]!
    detachExternalAborts(dropped)
    if (dropped.coalesceKey) clearCoalesceState(dropped.coalesceKey)
    // Warm callers are fire-and-forget — resolve rather than reject.
    dropped.resolve(undefined)
    return true
  }
  return false
}

function detachExternalAborts(job: PendingJob): void {
  for (const binding of job.abortBindings) {
    binding.signal.removeEventListener('abort', binding.onAbort)
  }
  job.abortBindings = []
}

function rejectPendingJob(job: PendingJob, err: unknown): void {
  const idx = pending.indexOf(job)
  if (idx < 0) return
  pending.splice(idx, 1)
  detachExternalAborts(job)
  if (job.coalesceKey) clearCoalesceState(job.coalesceKey)
  job.reject(err)
}

function attachExternalAbort(job: PendingJob, signal: AbortSignal): void {
  if (signal.aborted) {
    rejectPendingJob(job, new DOMException('Aborted', 'AbortError'))
    return
  }
  const onAbort = (): void => {
    rejectPendingJob(job, new DOMException('Aborted', 'AbortError'))
  }
  job.abortBindings.push({ signal, onAbort })
  signal.addEventListener('abort', onAbort, { once: true })
}

/** Abort signal for the currently running warm job (queue preempt). */
export function activeIndexJobPreemptSignal(): AbortSignal | null {
  return activeJob?.preemptController?.signal ?? null
}

function preemptActiveWarmIfNeeded(incoming: IndexJobPriority): void {
  if (incoming !== 'interactive') return
  if (!activeJob || activeJob.priority !== 'warm') return
  if (!activeJob.preemptController || activeJob.preemptController.signal.aborted) return
  activeJob.preemptRequested = true
  logger.warn('Warm index job preempted by interactive request — requeued', {
    scope: 'indexJobQueue',
    coalesceKey: activeJob.coalesceKey
  })
  activeJob.preemptController.abort()
}

function requeueWarmCopy(job: PendingJob): void {
  const copy: PendingJob = {
    priority: 'warm',
    coalesceKey: job.coalesceKey,
    run: job.run,
    resolve: () => {},
    reject: () => {},
    abortBindings: []
  }
  const promise = new Promise<unknown>((resolve, reject) => {
    copy.resolve = resolve
    copy.reject = reject
  })
  if (job.coalesceKey) bindCoalescePromise(job.coalesceKey, promise)
  insertByPriority(copy)
}

async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    while (pending.length > 0) {
      const job = pending.shift()!
      detachExternalAborts(job)
      activeJob = job
      if (job.priority === 'warm') {
        job.preemptController = new AbortController()
        job.preemptRequested = false
      }
      try {
        const result = await job.run()
        if (job.preemptRequested) {
          requeueWarmCopy(job)
          job.resolve(undefined)
        } else {
          job.resolve(result)
        }
      } catch (err) {
        if (job.preemptRequested) {
          requeueWarmCopy(job)
          job.resolve(undefined)
        } else {
          job.reject(err)
        }
      } finally {
        activeJob = null
      }
    }
  } finally {
    pumping = false
    if (pending.length > 0) void pump()
  }
}

export type EnqueueIndexJobOptions<T> = {
  priority: IndexJobPriority
  /** When set, duplicate enqueues share one promise until settled. */
  coalesceKey?: string
  run: () => Promise<T>
  /** When aborted while pending, job is removed and the promise rejects with AbortError. */
  signal?: AbortSignal
}

export function dropPendingByCoalesceKey(coalesceKey: string): boolean {
  const existing = coalescePromises.get(coalesceKey)
  if (!existing) return false
  for (let i = 0; i < pending.length; i++) {
    if (pending[i]!.coalesceKey !== coalesceKey) continue
    const dropped = pending.splice(i, 1)[0]!
    detachExternalAborts(dropped)
    clearCoalesceState(coalesceKey)
    dropped.resolve(undefined)
    return true
  }
  // Running or settled — clear stale coalesce only if map still points at it.
  // Do not resolve the active promise here; abort via workspace signal instead.
  clearCoalesceState(coalesceKey)
  return false
}

function findPendingByCoalesceKey(coalesceKey: string): PendingJob | undefined {
  return pending.find((j) => j.coalesceKey === coalesceKey)
}

export function enqueueIndexJob<T>(opts: EnqueueIndexJobOptions<T>): Promise<T> {
  if (opts.signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'))
  }

  if (opts.coalesceKey) {
    const existing = coalescePromises.get(opts.coalesceKey)
    if (existing) {
      const job = findPendingByCoalesceKey(opts.coalesceKey)
      if (job) {
        if (PRIORITY_RANK[opts.priority] < PRIORITY_RANK[job.priority]) {
          const idx = pending.indexOf(job)
          if (idx >= 0) pending.splice(idx, 1)
          job.priority = opts.priority
          insertByPriority(job)
          preemptActiveWarmIfNeeded(opts.priority)
        }
        if (opts.signal) attachExternalAbort(job, opts.signal)
      } else {
        // In-flight (or just-settled): join the running promise and mark one trailing rerun.
        markTrailingDirty(opts.coalesceKey, opts.priority, opts.run as () => Promise<unknown>)
      }
      return existing as Promise<T>
    }
  }

  if (pending.length >= INDEX_JOB_QUEUE_MAX_PENDING) {
    if (opts.priority === 'warm') {
      return Promise.reject(new IndexQueueFullError())
    }
    if (!dropOldestWarm() && pending.length >= INDEX_JOB_QUEUE_MAX_PENDING) {
      return Promise.reject(new IndexQueueFullError())
    }
  }

  preemptActiveWarmIfNeeded(opts.priority)

  const promise = new Promise<T>((resolve, reject) => {
    const job: PendingJob = {
      priority: opts.priority,
      coalesceKey: opts.coalesceKey,
      run: opts.run as () => Promise<unknown>,
      resolve: resolve as (value: unknown) => void,
      reject,
      abortBindings: []
    }
    if (opts.signal) attachExternalAbort(job, opts.signal)
    insertByPriority(job)
    void pump()
  })

  if (opts.coalesceKey) bindCoalescePromise(opts.coalesceKey, promise)

  return promise
}

export function resetIndexJobQueueForTests(): void {
  if (activeJob?.preemptController && !activeJob.preemptController.signal.aborted) {
    activeJob.preemptRequested = false
    activeJob.preemptController.abort()
  }
  activeJob = null
  const leftover = pending.splice(0, pending.length)
  for (const job of leftover) {
    detachExternalAborts(job)
    job.resolve(undefined)
  }
  coalescePromises.clear()
  trailingDirty.clear()
  pumping = false
}

export function indexJobQueuePendingCountForTests(): number {
  return pending.length
}

export function indexJobQueuePendingInteractiveCountForTests(): number {
  return pending.filter((job) => job.priority === 'interactive').length
}

export function indexJobQueueIsBusyForTests(): boolean {
  return pumping || pending.length > 0 || activeJob != null
}

export function indexJobQueueActivePriorityForTests(): IndexJobPriority | null {
  return activeJob?.priority ?? null
}

