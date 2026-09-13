import { workspacePathsEqual } from '@shared/workspacePathMatch'

export type ActiveRunRef = {
  runId: string
  workspacePath: string
}

/** Runs that left the active list and were marked background (closed while running). */
export function finishedBackgroundRuns(
  prevActive: readonly ActiveRunRef[],
  nextActive: readonly ActiveRunRef[],
  backgroundRunIds: ReadonlySet<string>
): ActiveRunRef[] {
  return prevActive.filter(
    (entry) =>
      backgroundRunIds.has(entry.runId) &&
      !nextActive.some(
        (r) =>
          r.runId === entry.runId && workspacePathsEqual(r.workspacePath, entry.workspacePath)
      )
  )
}

export function backgroundRunFinishedMessage(title: string | null | undefined): string {
  const t = title?.trim()
  return t ? `Finished: ${t}` : 'Agent finished'
}

export function shouldShowBackgroundRunToast(opts: {
  windowFocused: boolean
  focusedRunId: string | null | undefined
  finishedRunId: string
}): boolean {
  if (!opts.windowFocused) return false
  if (opts.focusedRunId && opts.focusedRunId === opts.finishedRunId) return false
  return true
}
