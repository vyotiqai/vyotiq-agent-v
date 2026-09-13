/**
 * Shared helpers for the per-run append queues (events.jsonl / messages.jsonl).
 *
 * Mid-run appends can fail on transient filesystem errors (EBUSY/EAGAIN while an
 * antivirus scanner or another process briefly holds the file, EMFILE under heavy
 * concurrency, etc.). Those should be retried rather than silently dropping a
 * record. Genuine failures (ENOSPC, permission denied, …) must surface an
 * aggregated, per-run notice so the run knows how many records were lost.
 */

export const TRANSIENT_APPEND_ERROR_CODES = new Set([
  'EAGAIN',
  'EBUSY',
  'EMFILE',
  'ENFILE',
  'EDEADLK',
  'ETIMEDOUT'
])

export function isTransientFsError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as NodeJS.ErrnoException).code
  return code !== undefined && TRANSIENT_APPEND_ERROR_CODES.has(code)
}

/**
 * Run `fn` up to `attempts` times, retrying only on transient filesystem errors.
 * Non-transient errors propagate immediately; the final transient error also
 * propagates so the caller can record it as a permanent loss.
 */
export async function withTransientAppendRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown = undefined
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isTransientFsError(err) || attempt >= attempts) throw err
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 15))
    }
  }
  throw lastErr
}

export type DirAppendFailures = { count: number; last: Error }

/** Accumulate a failure for a run dir, preserving the running count + latest error. */
export function bumpFailure(map: Map<string, DirAppendFailures>, dir: string, err: unknown): void {
  const error = err instanceof Error ? err : new Error(String(err))
  const existing = map.get(dir)
  if (existing) {
    existing.count += 1
    existing.last = error
  } else {
    map.set(dir, { count: 1, last: error })
  }
}

/** Build a single, human-readable error summarizing one or more per-dir failures. */
export function formatAppendFailure(fileName: string, all: DirAppendFailures[]): Error {
  const total = all.reduce((n, f) => n + f.count, 0)
  const last = all[all.length - 1]!.last
  const msg =
    total === 1
      ? last.message
      : `${total} record(s) failed to persist to ${fileName} across ${all.length} run(s); last error: ${last.message}`
  const err = new Error(msg)
  err.cause = last
  return err
}
