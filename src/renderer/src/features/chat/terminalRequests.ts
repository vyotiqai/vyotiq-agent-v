import { workspacePathsEqual } from '@shared/workspacePathMatch'

/**
 * "Run in my terminal" from a command card: the command goes to the person's
 * own shell in the Terminal tab (never the agent's read-only mirror). The
 * request waits here until a Terminal panel for that workspace takes it, so
 * the tab can be opened by the same click that asked.
 */
export type TerminalRunRequest = { workspacePath: string; command: string; id: number }

let pending: TerminalRunRequest | null = null
let nextId = 1
const listeners = new Set<() => void>()

export function requestRunInTerminal(workspacePath: string, command: string): void {
  pending = { workspacePath, command, id: nextId++ }
  for (const listener of listeners) listener()
}

/** The waiting request for this workspace, taken (so it runs once), or null. */
export function takeTerminalRunRequest(workspacePath: string | null): TerminalRunRequest | null {
  if (!pending || !workspacePath || !workspacePathsEqual(pending.workspacePath, workspacePath)) return null
  const taken = pending
  pending = null
  return taken
}

export function onTerminalRunRequest(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test hook. */
export function resetTerminalRunRequestsForTests(): void {
  pending = null
}
