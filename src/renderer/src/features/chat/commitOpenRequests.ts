import { workspacePathsEqual } from '@shared/workspacePathMatch'

/**
 * "Open this commit" from a view: the Changes tab shows that commit's files.
 * The request waits here until a Changes panel for that workspace takes it,
 * so the tab can be opened by the same click that asked.
 */
export type CommitOpenRequest = { workspacePath: string; sha: string; id: number }

let pending: CommitOpenRequest | null = null
let nextId = 1
const listeners = new Set<() => void>()

export function requestOpenCommit(workspacePath: string, sha: string): void {
  pending = { workspacePath, sha, id: nextId++ }
  for (const listener of listeners) listener()
}

/** The waiting request for this workspace, taken (so it opens once), or null. */
export function takeCommitOpenRequest(workspacePath: string | null): CommitOpenRequest | null {
  if (!pending || !workspacePath || !workspacePathsEqual(pending.workspacePath, workspacePath)) return null
  const taken = pending
  pending = null
  return taken
}

export function onCommitOpenRequest(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test hook. */
export function resetCommitOpenRequestsForTests(): void {
  pending = null
}
