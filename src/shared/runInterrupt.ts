/** Stable error message written when a run is interrupted on crash/quit. */
export const RUN_INTERRUPTED_ERROR = 'Interrupted: app exited while run was active' as const

export type ResumableRunSummary = {
  status: string
  resumable?: true
  error?: string
}

/** True when a cancelled run can be resumed via chat:start(runId). */
export function isResumableInterruptedRun(
  run: ResumableRunSummary | null | undefined
): boolean {
  if (!run || run.status !== 'cancelled') return false
  if (run.resumable === true) return true
  return run.error === RUN_INTERRUPTED_ERROR
}
