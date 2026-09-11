/**
 * Main-process V8 heap pressure signal.
 *
 * Background index walks/RPCs allocate on the main thread during long runs.
 * When the heap is already close to its ceiling, those allocations race the
 * last-resort GC into an out-of-memory abort (observed: warm index start was
 * the final action before a 3.9 GB V8 OOM). Callers can cheaply skip
 * background work while pressure is high; it resumes once GC catches up.
 *
 * The same allocation discipline applies to the agent run loops themselves:
 * each step re-assembles the full context from the in-memory transcript, so
 * under ceiling pressure they must pause allocation-heavy step work until GC
 * catches up (`waitForHeapPressureRelief`).
 */
import { getHeapStatistics } from 'node:v8'
import { logger } from '../../shared/logger'

export const HEAP_PRESSURE_RATIO = 0.75
/**
 * Absolute floor so small heaps (unit-test workers) never trip the gate:
 * pressure only matters when the process has actually accumulated GBs.
 */
export const HEAP_PRESSURE_MIN_USED_BYTES = 1_500 * 1024 * 1024

export function isHeapPressureHigh(
  ratio: number = HEAP_PRESSURE_RATIO,
  minUsedBytes: number = HEAP_PRESSURE_MIN_USED_BYTES
): boolean {
  const stats = getHeapStatistics()
  const limit = stats.heap_size_limit
  if (!Number.isFinite(limit) || limit <= 0) return false
  if (stats.used_heap_size < minUsedBytes) return false
  return stats.used_heap_size / limit >= ratio
}

/** Poll cadence while waiting for heap relief. */
export const HEAP_PRESSURE_WAIT_POLL_MS = 250
/**
 * Bounded wait: if pressure stays high this long with every big allocator
 * paused, the retained heap is live working set — proceed anyway (one step's
 * allocations are bounded) rather than deadlocking all runs forever. The gate
 * re-arms on the next step, so allocation stays throttled either way.
 */
export const HEAP_PRESSURE_MAX_WAIT_MS = 90_000
/** Re-announce throttling so many paused runs do not spam the log. */
const GATE_ANNOUNCE_MIN_MS = 30_000

let lastGateAnnounceAt = 0

function announceThrottled(message: string, fields: Record<string, unknown>): void {
  const now = Date.now()
  if (now - lastGateAnnounceAt < GATE_ANNOUNCE_MIN_MS) return
  lastGateAnnounceAt = now
  logger.info(message, { scope: 'perf', ...fields })
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Await relief from main-heap pressure, polling `isHigh` until it drops.
 *
 * Returns `true` when the caller may proceed with allocation-heavy work
 * (pressure relieved, or the bounded max-wait fell through — logged), and
 * `false` only when `signal` aborted while waiting (caller must bail).
 * Never throws; never waits unbounded.
 */
export async function waitForHeapPressureRelief(
  signal?: AbortSignal | null,
  opts: {
    isHigh?: () => boolean
    pollMs?: number
    maxWaitMs?: number
  } = {}
): Promise<boolean> {
  const isHigh = opts.isHigh ?? isHeapPressureHigh
  const pollMs = Math.max(10, opts.pollMs ?? HEAP_PRESSURE_WAIT_POLL_MS)
  const maxWaitMs = Math.max(pollMs, opts.maxWaitMs ?? HEAP_PRESSURE_MAX_WAIT_MS)
  if (signal?.aborted) return false
  if (!isHigh()) return true
  const startedAt = Date.now()
  announceThrottled('Agent step work paused under main-heap pressure', {
    reason: 'heap_pressure_gate'
  })
  while (isHigh() && !signal?.aborted && Date.now() - startedAt < maxWaitMs) {
    await sleepMs(pollMs)
  }
  const waitedMs = Date.now() - startedAt
  if (signal?.aborted) return false
  announceThrottled('Agent step work resumed after heap relief', {
    reason: 'heap_pressure_gate',
    relieved: !isHigh(),
    waitedMs
  })
  return true
}
