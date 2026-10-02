/**
 * Something in this window changed what `listRuns` reports for one workspace
 * (a task's added folders, say), so its task list should be re-read now
 * rather than on the next refresh. The workspace manager listens.
 */
export const RUN_LIST_CHANGED_EVENT = 'vyotiq:run-list-changed'

export type RunListChangedDetail = { workspacePath: string }

export function signalRunListChanged(workspacePath: string): void {
  if (typeof window === 'undefined' || !workspacePath) return
  window.dispatchEvent(new CustomEvent<RunListChangedDetail>(RUN_LIST_CHANGED_EVENT, { detail: { workspacePath } }))
}
