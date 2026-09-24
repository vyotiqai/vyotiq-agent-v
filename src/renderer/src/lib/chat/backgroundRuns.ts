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
