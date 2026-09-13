import { rm } from 'fs/promises'
import { getWriteCheckpoint } from '../checkpoints'
import { logger } from '../../../shared/logger'
import {
  gitShowToFile,
  type MergedInstanceFileChange
} from '@main/git/instanceWorktree'

/**
 * Record the file changes a successful merge_agent_instance applied onto the
 * parent run's active write checkpoint, so chatRewind can revert merged
 * instance edits like any other write of the merge turn.
 *
 * Prior content comes from the pre-merge HEAD (the parent tree was clean —
 * the merge gate enforces that). Created files record no prior blob; restoring
 * them deletes the file. Any capture failure is logged, never thrown: the git
 * merge already succeeded and failing the tool would prompt a pointless retry.
 */
export async function recordMergedInstanceChanges(
  workspace: string,
  context: { runDir?: string; skipWriteCheckpoint?: boolean },
  result: { preMergeHead?: string; changedFiles?: MergedInstanceFileChange[] }
): Promise<void> {
  if (context.skipWriteCheckpoint || !context.runDir) return
  const cp = getWriteCheckpoint(context.runDir)
  if (!cp) return
  const head = result.preMergeHead
  const changed = result.changedFiles ?? []
  if (!head || changed.length === 0) return

  for (const change of changed) {
    try {
      if (change.action === 'created') {
        await cp.recordObservedMutation(change.path, 'created')
        continue
      }
      const prior = await gitShowToFile(workspace, head, change.path)
      try {
        await cp.recordObservedMutation(change.path, change.action, prior ?? undefined)
      } finally {
        if (prior) await rm(prior, { force: true })
      }
    } catch (err) {
      logger.warn('Failed to record merged instance changes for checkpoint', {
        scope: 'agent',
        path: change.path,
        err
      })
    }
  }
}
