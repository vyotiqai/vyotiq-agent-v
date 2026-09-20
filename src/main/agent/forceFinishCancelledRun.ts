import { logger } from '../../shared/logger'
import { invalidateListRunsCache } from './runListCache'
import { notifyChildTerminal } from './agentInstances'
import { appendEvent, loadStatus, updateStatus } from './state'
import { resolveRunDir } from '../storage/paths'

type ForceFinishDependencies = {
  isActive: (runId: string) => boolean
  getRunWorkspace: (runId: string) => string | undefined
}

/**
 * A cancelled run whose loop never unwound (stuck on a tool that ignores the
 * abort) leaves status.json `running` — a zombie the sidebar renders as a live
 * spinner, and one `reconcileStaleRuns` skips forever because isActive stays
 * true. Persist the terminal status the loop will never write, and notify the
 * parent run so its sidebar instance row stops spinning. Safe to run after a
 * late normal unwind: both paths write the same terminal status, and
 * notifyChildTerminal is idempotent for already-resolved waiters.
 */
export async function forceFinishCancelledRun(
  runId: string,
  { isActive, getRunWorkspace }: ForceFinishDependencies
): Promise<boolean> {
  if (!isActive(runId)) return false
  const workspacePath = getRunWorkspace(runId)
  if (!workspacePath) return false
  try {
    const runDir = resolveRunDir(workspacePath, runId)
    const status = loadStatus(runDir)
    if (!status) return false
    if (status.status === 'done' || status.status === 'error' || status.status === 'cancelled') {
      return false
    }
    // Match the loop's own user-cancel contract (loop.ts writeStatus): a plain
    // terminal patch, no resumable flag — this was a cancel, not a crash.
    await updateStatus(runDir, { status: 'cancelled' }, { sync: true })
    appendEvent(runDir, {
      type: 'status',
      runId,
      status: 'cancelled',
      ...(status.invokeId != null ? { invokeId: status.invokeId } : {})
    })
    if (status.inlineInstance && status.parentRunId) {
      notifyChildTerminal(runId, 'cancelled', undefined, {
        goal: status.goal,
        pathScope: status.pathScope
      })
    }
    invalidateListRunsCache(workspacePath)
    logger.warn('Cancelled run never unwound — force-finalized on disk', {
      scope: 'agent',
      runId,
      correlationId: runId
    })
    return true
  } catch (err) {
    logger.warn('Cancelled run force-finish failed', {
      scope: 'agent',
      runId,
      err
    })
    return false
  }
}
