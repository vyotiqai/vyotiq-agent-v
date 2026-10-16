/**
 * Voice mode's side of app control (docs/voice-mode.md §27): the agent is the
 * voice, so its `app_control` reaches the session following its run for the
 * voice's own controls and what the window shows. Voice sessions set this at
 * startup; app control can't import them (they import the agent).
 */
import type { VoiceScreen } from '../../shared/ipc/schemas/voice'
import type { AppActionContext, AppActionResult } from './runner'

export type VoiceLinkSession = {
  controls: NonNullable<AppActionContext['voice']>
  /** What the window shows; null before it says. */
  screen: VoiceScreen | null
  muted: 'until_called' | 'until_unmuted' | null
  /** An app action the run took, kept in the session's conversation (§24.8). */
  noteAction: (action: string, result: AppActionResult) => void
}

type VoiceLink = {
  /** The session following this run, if one does. */
  forRun: (runId: string) => VoiceLinkSession | null
  /** Any live session, for the app's status when no run is named. */
  any: () => VoiceLinkSession | null
}

let link: VoiceLink | null = null

export function setVoiceLink(next: VoiceLink | null): void {
  link = next
}

export function voiceLinkForRun(runId: string | null | undefined): VoiceLinkSession | null {
  if (!link) return null
  return (runId ? link.forRun(runId) : null) ?? link.any()
}

/** Only the session following this run: what it did belongs in that conversation, not any other. */
export function voiceSessionFollowing(runId: string | null | undefined): VoiceLinkSession | null {
  return runId && link ? link.forRun(runId) : null
}
