/**
 * "Commit…" from outside Changes — the record's line for kept edits — asks
 * that task's Changes to open its commit box. The tab may only mount after the
 * ask, so the ask waits a moment for a Changes of that task to take it, then
 * lapses: a stale one must never open the box on some later visit.
 */
const COMMIT_REQUEST_EVENT = 'vyotiq:commit-request'
const REQUEST_TTL_MS = 10_000

let pending: { runId: string; at: number } | null = null

export function requestCommitBox(runId: string): void {
  pending = { runId, at: Date.now() }
  window.dispatchEvent(new CustomEvent(COMMIT_REQUEST_EVENT))
}

/** True once, for the task the open request names, while it is fresh. */
export function takeCommitRequest(runId: string | null | undefined): boolean {
  if (!pending || !runId) return false
  if (Date.now() - pending.at > REQUEST_TTL_MS) {
    pending = null
    return false
  }
  if (pending.runId !== runId) return false
  pending = null
  return true
}

export function onCommitRequest(listener: () => void): () => void {
  window.addEventListener(COMMIT_REQUEST_EVENT, listener)
  return () => window.removeEventListener(COMMIT_REQUEST_EVENT, listener)
}
