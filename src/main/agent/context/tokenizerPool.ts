import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import { logger } from '../../../shared/logger'

const POOL_SIZE = 2

/**
 * Upper bound on one batch encode.
 *
 * Generous on purpose: a real batch is milliseconds, so this never fires in
 * normal operation. It exists because nothing else in the chain has a guard. An
 * unanswered request leaves the promise below pending forever, and its awaiters
 * are `countTextsTokensAsync` -> `estimateMessagesTokensAsync` ->
 * `assembleContext`, so the run would stall before its next request with no
 * event, no error and no status change. On expiry the caller falls back to
 * synchronous BPE (see `tokenizer.ts`).
 */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * A worker that dies sooner than this after spawning is treated as broken rather
 * than unlucky, and is not replaced.
 */
const WORKER_MIN_LIFETIME_MS = 1_000

type CountItem = { text: string; encoding: 'o200k_base' | 'cl100k_base' }

type Pending = {
  resolve: (counts: number[]) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type WorkerMsg = { id: number; counts?: number[]; error?: string }

type WorkerSlot = {
  worker: Worker
  pending: Map<number, Pending>
  /** When the thread was spawned — see the young-worker guard in `retireSlot`. */
  createdAt: number
  /**
   * Set the instant a slot is given up on, before `terminate()` is called.
   *
   * `terminate()` makes the worker emit `exit`, which routes straight back here,
   * so without an explicit flag retirement re-enters itself. Pool membership is
   * not a usable guard: the slot is still in `slots` at that point.
   */
  retired: boolean
}

let slots: WorkerSlot[] | null = null
/** Single lazy-initialization promise so concurrent first callers share one pool create. */
let poolInit: Promise<WorkerSlot[] | null> | null = null
/** Sticky only after worker create fails despite the script existing — not on a missing bundle. */
let poolCreateFailed = false
let nextId = 1

function workerScriptPath(): string {
  return join(__dirname, 'tokenizer.worker.js')
}

/** Take a pending request off the slot and cancel its timeout. */
function takePending(slot: WorkerSlot, id: number): Pending | undefined {
  const pending = slot.pending.get(id)
  if (!pending) return undefined
  slot.pending.delete(id)
  clearTimeout(pending.timer)
  return pending
}

function rejectAll(pending: Map<number, Pending>, err: Error): void {
  for (const [id, entry] of pending) {
    pending.delete(id)
    clearTimeout(entry.timer)
    entry.reject(err)
  }
}

/**
 * Give up on one worker: fail everything in flight and kill the thread, without
 * touching the pool. Returns false when the slot was already abandoned, which is
 * what keeps `terminate()`'s own `exit` event from re-entering retirement.
 */
function abandonSlot(slot: WorkerSlot, err: Error): boolean {
  if (slot.retired) return false
  slot.retired = true
  rejectAll(slot.pending, err)
  void slot.worker.terminate().catch(() => undefined)
  return true
}

/**
 * Drop a worker from the pool, replacing it when we can.
 *
 * Every failure path routes through here, because a worker that has stopped
 * answering must leave `slots`: `postMessage` to a dead worker is a silent no-op
 * (measured — it neither throws nor replies), so a retained dead slot swallows
 * every request routed to it and never settles the promise.
 */
function retireSlot(slot: WorkerSlot, err: Error): void {
  if (!abandonSlot(slot, err)) return
  if (!slots) return
  const idx = slots.indexOf(slot)
  if (idx < 0) return
  // Do not respawn a worker that died on startup. A mis-bundled or empty
  // `tokenizer.worker.js` exits 0 immediately with no error, and since `exit` now
  // retires too, replacing unconditionally would spin threads forever. Dropping
  // the slot instead leaves `ensurePool` to retry lazily on a later batch, and
  // until then counting falls back to the main thread — which is correct, if
  // slower, rather than an endless respawn.
  const replacement =
    Date.now() - slot.createdAt < WORKER_MIN_LIFETIME_MS ? null : tryCreateWorker()
  if (replacement) {
    slots[idx] = replacement
    return
  }
  slots.splice(idx, 1)
  if (slots.length === 0) slots = null
}

function attachWorker(slot: WorkerSlot): void {
  slot.worker.on('message', (msg: WorkerMsg) => {
    const pending = takePending(slot, msg.id)
    if (!pending) return
    if (msg.error) {
      pending.reject(new Error(msg.error))
      return
    }
    pending.resolve(msg.counts ?? [])
  })

  slot.worker.on('error', (err) => {
    retireSlot(slot, err instanceof Error ? err : new Error(String(err)))
  })

  // Unconditional, where this used to return early on an empty `pending` map: an
  // exit with nothing in flight left the dead slot in the pool for the next batch
  // to hang on. `retireSlot` is idempotent via `slot.retired`, so handling the
  // exit that its own `terminate()` produces costs nothing.
  slot.worker.on('exit', (code) => {
    retireSlot(slot, new Error(`Tokenizer worker exited with code ${code}`))
  })
}

function tryCreateWorker(): WorkerSlot | null {
  const script = workerScriptPath()
  if (!existsSync(script)) return null
  try {
    const worker = new Worker(script)
    const slot: WorkerSlot = {
      worker,
      pending: new Map(),
      retired: false,
      createdAt: Date.now()
    }
    attachWorker(slot)
    return slot
  } catch {
    return null
  }
}

function tryCreatePool(): WorkerSlot[] | null {
  if (poolCreateFailed) return null
  const script = workerScriptPath()
  // Missing worker (vitest / pre-build) — retry later once the bundle exists.
  if (!existsSync(script)) return null

  const list: WorkerSlot[] = []
  for (let i = 0; i < POOL_SIZE; i++) {
    const slot = tryCreateWorker()
    if (!slot) {
      for (const existing of list) {
        abandonSlot(existing, new Error('Tokenizer pool create failed'))
      }
      poolCreateFailed = true
      return null
    }
    list.push(slot)
  }
  return list
}

async function ensurePool(): Promise<WorkerSlot[] | null> {
  if (slots && slots.length > 0) return slots
  if (poolInit) return poolInit

  poolInit = Promise.resolve(tryCreatePool())
  const created = await poolInit
  if (!slots) slots = created
  poolInit = null
  return slots
}

/**
 * Encode a batch off the main thread.
 *
 * Returns `null` when the worker bundle is missing (vitest / pre-build) so
 * callers can fall back to sync BPE on the main thread. Rejects when a worker
 * fails or stops answering — same fallback, and the slot is retired so the next
 * batch does not repeat the wait.
 */
export async function encodeCountsInWorker(items: CountItem[]): Promise<number[] | null> {
  if (items.length === 0) return []
  const pool = await ensurePool()
  if (!pool || pool.length === 0) return null

  const id = nextId++
  const slot = pool.reduce((a, b) => (a.pending.size <= b.pending.size ? a : b))!

  return new Promise<number[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!slot.pending.delete(id)) return
      const err = new Error(`Tokenizer worker did not answer in ${REQUEST_TIMEOUT_MS}ms`)
      logger.warn('Tokenizer worker stopped answering; counting on the main thread instead', {
        scope: 'tokenizer',
        items: items.length,
        timeoutMs: REQUEST_TIMEOUT_MS
      })
      reject(err)
      retireSlot(slot, err)
    }, REQUEST_TIMEOUT_MS)
    // A pending encode must never hold the process open on quit.
    timer.unref?.()

    slot.pending.set(id, { resolve, reject, timer })
    try {
      slot.worker.postMessage({ id, items })
    } catch (err) {
      takePending(slot, id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/** Test helper — terminate workers and allow re-init. */
export function resetTokenizerPoolForTests(): void {
  if (slots) {
    // abandonSlot, not retireSlot: retirement mutates `slots`, and this is
    // iterating it.
    for (const slot of slots) {
      abandonSlot(slot, new Error('Tokenizer pool reset'))
    }
  }
  slots = null
  poolInit = null
  poolCreateFailed = false
  nextId = 1
}

/** Terminate workers on app quit (best-effort). */
export function shutdownTokenizerPool(): void {
  resetTokenizerPoolForTests()
}
