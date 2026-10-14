/**
 * Where the voice's hand-off goes (docs/voice-mode.md §25, D-44, D-46): to
 * the task, like a typed message. It starts the task, or joins the running
 * one mid-turn; talking never cancels the agent's work. Only an explicit
 * "stop" does, through `stop_agent`.
 */
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

export async function routeVoiceTurn(turn: VoiceTurn, target: VoiceRunTarget): Promise<VoiceRouteResult> {
  const running = target.running()
  if (turn.stop) {
    // "Stop" / "never mind": with work in progress it cancels it; otherwise there's nothing to send.
    if (running) await target.stop()
    return running ? { kind: 'stopped' } : { kind: 'dropped' }
  }
  // While it works, the brief joins the current turn (applied between steps), never cancelling it.
  const ok = await target.send(turn.text, { steer: running })
  return ok ? { kind: 'sent', runId: target.runId() } : { kind: 'dropped' }
}
