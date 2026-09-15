/**
 * After a successful workspace add, decide whether Chat should open a draft
 * session (no prior active run) or keep the persisted active run (re-add).
 */
export function needsDraftChatAfterWorkspaceAdd(activeRunId: string | null): boolean {
  return activeRunId == null
}
