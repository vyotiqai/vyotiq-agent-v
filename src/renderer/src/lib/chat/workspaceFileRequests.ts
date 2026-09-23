import { useSyncExternalStore } from 'react'

/**
 * "Open this file in the Files panel", asked from outside the task view (the
 * palette, which can be opened from Home). A request waits here until a task
 * view for that workspace is mounted and takes it, so asking before the view
 * exists is not a race.
 */
export type WorkspaceFileRequest = { workspacePath: string; path: string; seq: number }

let pending: WorkspaceFileRequest | null = null
let seq = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function requestOpenWorkspaceFile(workspacePath: string, path: string): void {
  seq += 1
  pending = { workspacePath, path, seq }
  emit()
}

/** Take the request once; a later one with a new `seq` is unaffected. */
export function consumeWorkspaceFileRequest(requestSeq: number): void {
  if (pending?.seq !== requestSeq) return
  pending = null
  emit()
}

export function useWorkspaceFileRequest(): WorkspaceFileRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => pending,
    () => null
  )
}
