/**
 * Where a finished voice turn goes (docs/voice-mode.md §6.3, D-12). The
 * session already stopped speaking when you started talking; this decides
 * what happens to the agent's work.
 */
import type { VoiceInterruptMode } from '@shared/ipc/schemas/voice'
import type { VoiceTurn } from './voiceSessionController'

/** The slice of a task's chat controller a voice turn needs. */
export type VoiceRunTarget = {
  /** The agent is working on this task right now. */
  running: () => boolean
  /** The task's run id once one exists. */
  runId: () => string | null
  /** Send a message like the composer does; `steer` interrupts the current step to apply it. */
  send: (text: string, opts: { steer: boolean }) => Promise<boolean>
  /** Stop the run (the composer's Stop). */
  stop: () => Promise<void> | void
  /** The New task brief: a turn here starts the task (§13.5). */
  brief?: boolean
}

export type VoiceRouteResult =
  | { kind: 'sent'; runId: string | null }
  | { kind: 'stopped' }
  | { kind: 'dropped' }

export async function routeVoiceTurn(
  turn: VoiceTurn,
  target: VoiceRunTarget,
  mode: VoiceInterruptMode
): Promise<VoiceRouteResult> {
  const running = target.running()
  if (turn.stop) {
    // "Stop" / "never mind": with work in progress it cancels it; otherwise there's nothing to send.
    if (running) await target.stop()
    return running ? { kind: 'stopped' } : { kind: 'dropped' }
  }
  if (running && mode === 'cancel') {
    await target.stop()
    // A message sent while the run is still winding down would be queued as a
    // follow-up and dropped by the cancel; wait for it to settle (up to 3 s).
    await waitUntil(() => !target.running(), 3000)
  }
  const steer = running && mode === 'steer'
  const ok = await target.send(turn.text, { steer })
  return ok ? { kind: 'sent', runId: target.runId() } : { kind: 'dropped' }
}

async function waitUntil(done: () => boolean, timeoutMs: number, stepMs = 50): Promise<void> {
  for (let waited = 0; !done() && waited < timeoutMs; waited += stepMs) {
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}
