/**
 * Which workspaces have voice mode open, so the prompt asks the model for a
 * spoken summary there (docs/voice-mode.md §7.2, §8.6). A tiny module on
 * purpose: the prompt assembler imports it, and it imports nothing.
 */
const active = new Map<string, string>()

export function setVoiceReplyWorkspace(sessionId: string, workspacePath: string | null): void {
  if (workspacePath) active.set(sessionId, normalise(workspacePath))
  else active.delete(sessionId)
}

export function isVoiceReplyActive(paths: ReadonlyArray<string | null | undefined>): boolean {
  if (active.size === 0) return false
  const open = new Set(active.values())
  return paths.some((p) => p != null && open.has(normalise(p)))
}

/**
 * Whether this prompt should ask for a spoken summary: voice mode is open on
 * its workspace, and it isn't a helper instance (whose answer goes back to
 * the parent agent, not to anyone's ears).
 */
export function voiceReplyWanted(input: {
  workspacePath?: string | null
  memoryWorkspacePath?: string | null
  inlineInstance?: boolean
}): boolean {
  return !input.inlineInstance && isVoiceReplyActive([input.workspacePath, input.memoryWorkspacePath])
}

function normalise(p: string): string {
  return p.replace(/[\\/]+$/, '').toLowerCase()
}
