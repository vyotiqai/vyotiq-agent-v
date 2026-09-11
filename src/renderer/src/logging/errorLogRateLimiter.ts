/**
 * Collapse repeated identical renderer errors into one log record per window.
 *
 * A runaway render loop (React #185) can throw thousands of times per second;
 * each unthrottled record crosses the electron-log renderer bridge into the
 * main process, where per-record work (formatting, crash-snippet disk I/O)
 * saturates the main thread and starves GC — the OOM amplifier behind the
 * 2026-09-11 crash. The first occurrence logs immediately; repeats of the same
 * signature inside the window are counted and reported with the next logged
 * record (`suppressedRepeats`).
 */

const WINDOW_MS = 5_000
/** Bounded signature map — newest signatures evict the oldest. */
const MAX_TRACKED_SIGNATURES = 64

type Entry = {
  lastLoggedAt: number
  suppressed: number
}

const entries = new Map<string, Entry>()

export type ErrorLogDecision = {
  /** True when the caller should log this occurrence. */
  log: boolean
  /** Same-signature occurrences suppressed since the previously logged record. */
  suppressed: number
}

export function shouldLogErrorSignature(
  signature: string,
  now: number = Date.now()
): ErrorLogDecision {
  const entry = entries.get(signature)
  if (entry == null || now - entry.lastLoggedAt >= WINDOW_MS) {
    if (entries.size >= MAX_TRACKED_SIGNATURES && entry == null) {
      const oldest = entries.keys().next().value
      if (oldest != null) entries.delete(oldest)
    }
    entries.set(signature, { lastLoggedAt: now, suppressed: 0 })
    return { log: true, suppressed: entry?.suppressed ?? 0 }
  }
  entry.suppressed += 1
  return { log: false, suppressed: 0 }
}

/** Test hook — clears all tracked signatures. */
export function resetErrorLogRateLimiter(): void {
  entries.clear()
}
