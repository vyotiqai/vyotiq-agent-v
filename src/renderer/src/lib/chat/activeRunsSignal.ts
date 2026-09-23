import type { ActiveRun } from '@shared/ipc'

/**
 * Something that changes what `listActiveRuns` reports happened in this window
 * (an approval answered, a question submitted), so the live-run list should
 * be re-read now rather than on the next poll. The navigator's "Needs you"
 * depends on it.
 */
export const ACTIVE_RUNS_CHANGED_EVENT = 'vyotiq:active-runs-changed'

export function signalActiveRunsChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(ACTIVE_RUNS_CHANGED_EVENT))
}

/** True when two live-run lists would render the same navigator. */
export function sameActiveRuns(
  a: readonly ActiveRun[],
  b: readonly ActiveRun[],
  samePath: (x: string, y: string) => boolean
): boolean {
  if (a.length !== b.length) return false
  return a.every((prev, i) => {
    const next = b[i]
    if (!next) return false
    return (
      prev.runId === next.runId &&
      samePath(prev.workspacePath, next.workspacePath) &&
      prev.waiting?.kind === next.waiting?.kind &&
      prev.waiting?.since === next.waiting?.since &&
      prev.steps?.completed === next.steps?.completed &&
      prev.steps?.total === next.steps?.total
    )
  })
}
