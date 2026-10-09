import { useSyncExternalStore } from 'react'
import { GIT_STATUS_FILE_LIMIT_MAX } from '@shared/ipc'

/**
 * Workspaces whose Changes list was asked to show every file, not the first
 * 200. Shared, so every view of the workspace's status (the inspector, the
 * branch chip) reads the longer list once it is asked for. Lasts the session.
 */
const expanded = new Set<string>()
const listeners = new Set<() => void>()

export function expandGitStatus(workspacePath: string): void {
  if (expanded.has(workspacePath)) return
  expanded.add(workspacePath)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The file limit to ask git status for: undefined is main's default (200). */
export function useGitStatusLimit(workspacePath: string | null): number | undefined {
  const isExpanded = useSyncExternalStore(
    subscribe,
    () => (workspacePath ? expanded.has(workspacePath) : false),
    () => false
  )
  return isExpanded ? GIT_STATUS_FILE_LIMIT_MAX : undefined
}

/** Test hook. */
export function resetGitStatusLimitForTests(): void {
  expanded.clear()
}
