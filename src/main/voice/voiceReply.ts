/**
 * Which workspaces have voice mode open, so the prompt asks the model for a
 * spoken summary there (docs/voice-mode.md §7.2, §8.6). A tiny module on
 * purpose: the prompt assembler imports it, and it imports nothing.
 */
const active = new Map<string, string>()
/** The run each session follows: its commits and pushes wait for a spoken yes (§27). */
const followed = new Map<string, string>()

export function setVoiceFollowedRun(sessionId: string, runId: string | null): void {
  if (runId) followed.set(sessionId, runId)
  else followed.delete(sessionId)
}

export function isVoiceFollowedRun(runId: string | null | undefined): boolean {
  if (!runId || followed.size === 0) return false
  for (const id of followed.values()) if (id === runId) return true
  return false
}

export function setVoiceReplyWorkspace(sessionId: string, workspacePath: string | null): void {
  if (workspacePath) active.set(sessionId, normalise(workspacePath))
  else active.delete(sessionId)
}

/** The voice sessions open on this workspace. */
export function voiceSessionsOn(workspacePath: string): string[] {
  const want = normalise(workspacePath)
  return [...active].filter(([, p]) => p === want).map(([id]) => id)
}

type SpokenTurnState = (runId: string, workspacePath: string) => Promise<string>
let spokenTurnState: SpokenTurnState | null = null

/** The app as it is now, read for each step of a spoken turn (appControl's app_status registers it). */
export function onSpokenTurnState(fn: SpokenTurnState | null): void {
  spokenTurnState = fn
}

/**
 * The app as it is now, for a step of a spoken turn; empty when nothing
 * reads it or the read fails. 2026-10-16 probe: asked which orb it used, the
 * agent said "cloud" from memory of setting it, after it had been changed to
 * pearl. Told to read the app first, it still didn't; given the app, it can't
 * be stale.
 */
export async function spokenTurnStateText(runId: string, workspacePath: string): Promise<string> {
  if (!spokenTurnState) return ''
  try {
    return await spokenTurnState(runId, workspacePath)
  } catch {
    return ''
  }
}

type SpokenTurnListener = (runId: string, workspacePath: string) => void
let spokenTurnListener: SpokenTurnListener | null = null

/** Voice sessions hear of a run main starts with a turn said out loud (§27). */
export function onSpokenTurnStarted(fn: SpokenTurnListener | null): void {
  spokenTurnListener = fn
}

/**
 * A run started with your spoken words: the session that sent them follows
 * it from here, without waiting for the window to say which run it was
 * (2026-10-16 02:41:42: the run started at once, the window took 17 s and the
 * voice said it couldn't follow the task).
 */
export function noteSpokenTurnStarted(runId: string, workspacePath: string): void {
  try {
    spokenTurnListener?.(runId, workspacePath)
  } catch {
    /* the voice's failure is its own; the run goes on */
  }
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
  messages?: ReadonlyArray<{ role: string; spoken?: true; synthetic?: boolean }>
}): boolean {
  if (input.inlineInstance) return false
  // Only a turn you said out loud (D-32): a typed message in the same task,
  // or another task in the same folder, gets a written answer as usual.
  if (!lastTurnWasSpoken(input.messages ?? [])) return false
  return isVoiceReplyActive([input.workspacePath, input.memoryWorkspacePath])
}

/** The person's latest message was said in voice mode (loop-injected turns don't count). */
export function lastTurnWasSpoken(messages: ReadonlyArray<{ role: string; spoken?: true; synthetic?: boolean }>): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'user' || m.synthetic) continue
    return m.spoken === true
  }
  return false
}

function normalise(p: string): string {
  return p.replace(/[\\/]+$/, '').toLowerCase()
}
