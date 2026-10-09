import type { RunSummary } from '@shared/ipc'

/**
 * Branches that go for good when these tasks are deleted: the ones their
 * helper instances kept. Recently deleted keeps the record, not the branch
 * (main/agent/state.ts deleteRun), so unmerged commits there do not come back
 * on restore.
 */
export function branchesLostOnDelete(
  runIds: readonly string[],
  instanceRuns: readonly RunSummary[] = []
): number {
  const deleting = new Set(runIds)
  return instanceRuns.filter((run) => run.worktreeBranch && run.parentRunId != null && deleting.has(run.parentRunId))
    .length
}

/** The one Delete confirmation, from the task header and the navigator alike. */
export function deleteTasksMessage({
  count,
  title,
  branches
}: {
  count: number
  /** Named when one task is deleted from its own header. */
  title?: string
  branches: number
}): string {
  const one = count === 1
  const what = one ? (title ? `“${title}”` : 'this task') : `these ${count} tasks`
  const kept = `${one ? 'It goes' : 'They go'} to Recently deleted for 30 days; files ${one ? 'it' : 'they'} changed stay as they are.`
  const lost =
    branches > 0
      ? ` ${branches === 1 ? 'The branch' : `The ${branches} branches`} ${one ? 'its' : 'their'} helper instances kept ${branches === 1 ? 'is' : 'are'} deleted for good, with any commits not merged yet.`
      : ''
  return `Delete ${what}? ${kept}${lost}`
}
