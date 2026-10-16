/**
 * The voice session state machine (docs/voice-mode.md §5), as a pure
 * transition function. Main owns the live session and drives this; the
 * renderer only receives the resulting state. Keeping it pure means every
 * transition is unit-tested without audio, sockets or timers.
 */

export const VOICE_SESSION_STATES = [
  'off',
  'connecting',
  'listening',
  'hearing',
  'thinking',
  'working',
  'speaking',
  'waiting_on_you',
  'paused',
  'reconnecting',
  'error'
] as const
export type VoiceSessionState = (typeof VOICE_SESSION_STATES)[number]

export type VoiceSessionEvent =
  | { type: 'start' }
  | { type: 'ready' }
  | { type: 'speech_start' }
  /** Not a turn after all (a cough, the agent's own echo); `runActive` returns to the agent's work. */
  | { type: 'false_start'; runActive?: boolean }
  | { type: 'end_of_turn' }
  /** The first audio of a reply (an answer or a progress cue) started playing. */
  | { type: 'audio_start' }
  | { type: 'tool_start' }
  /** An approval or a question from the agent is waiting. */
  | { type: 'needs_you' }
  | { type: 'answered' }
  /** Playback drained. `runActive` says whether the agent is still working. */
  | { type: 'audio_done'; runActive: boolean }
  /** The run finished with nothing (more) to say. */
  | { type: 'run_done' }
  /** The voice's answer ended without audio (nothing to say, or nothing can speak); `runActive`: the agent is working. */
  | { type: 'reply_done'; runActive: boolean }
  /** The user started talking while the agent had the floor, confirmed (§6.2). */
  | { type: 'barge_in' }
  | { type: 'mute' }
  | { type: 'unmute' }
  | { type: 'connection_lost' }
  | { type: 'connection_restored' }
  | { type: 'fail' }
  | { type: 'retry' }
  | { type: 'stop' }

/** States in which the agent has the floor; speech from the user there is a barge-in. */
export const AGENT_FLOOR_STATES: ReadonlySet<VoiceSessionState> = new Set(['thinking', 'working', 'speaking'])

/** States in which the mic is open and audio flows to the listener. */
export const MIC_OPEN_STATES: ReadonlySet<VoiceSessionState> = new Set([
  'listening',
  'hearing',
  'thinking',
  'working',
  'speaking',
  'waiting_on_you',
  'reconnecting'
])

/**
 * The next state, or null when the event doesn't apply in this state (the
 * caller ignores it). `stop` ends the session from anywhere; `fail` errors
 * it from anywhere live.
 */
export function nextVoiceState(state: VoiceSessionState, event: VoiceSessionEvent): VoiceSessionState | null {
  if (event.type === 'stop') return state === 'off' ? null : 'off'
  if (event.type === 'fail') return state === 'off' || state === 'error' ? null : 'error'

  switch (state) {
    case 'off':
      return event.type === 'start' ? 'connecting' : null
    case 'connecting':
      return event.type === 'ready' ? 'listening' : null
    case 'listening':
      if (event.type === 'speech_start') return 'hearing'
      // A turn can end without a speech_start (push-to-talk on a quiet mic).
      if (event.type === 'end_of_turn') return 'thinking'
      // The agent you handed work to started, or speaks its result, after the voice went quiet (D-44).
      if (event.type === 'tool_start') return 'working'
      if (event.type === 'audio_start') return 'speaking'
      if (event.type === 'needs_you') return 'waiting_on_you'
      if (event.type === 'mute') return 'paused'
      if (event.type === 'connection_lost') return 'reconnecting'
      return null
    case 'hearing':
      if (event.type === 'end_of_turn') return 'thinking'
      if (event.type === 'false_start') return event.runActive ? 'working' : 'listening'
      if (event.type === 'mute') return 'paused'
      if (event.type === 'connection_lost') return 'reconnecting'
      return null
    case 'thinking':
      if (event.type === 'audio_start') return 'speaking'
      if (event.type === 'tool_start') return 'working'
      if (event.type === 'reply_done') return event.runActive ? 'working' : 'listening'
      if (event.type === 'needs_you') return 'waiting_on_you'
      if (event.type === 'run_done') return 'listening'
      if (event.type === 'barge_in') return 'hearing'
      if (event.type === 'mute') return 'paused'
      if (event.type === 'connection_lost') return 'reconnecting'
      return null
    case 'working':
      if (event.type === 'audio_start') return 'speaking'
      if (event.type === 'needs_you') return 'waiting_on_you'
      if (event.type === 'run_done') return 'listening'
      if (event.type === 'barge_in') return 'hearing'
      if (event.type === 'mute') return 'paused'
      if (event.type === 'connection_lost') return 'reconnecting'
      return null
    case 'speaking':
      if (event.type === 'audio_done') return event.runActive ? 'working' : 'listening'
      if (event.type === 'barge_in') return 'hearing'
      if (event.type === 'needs_you') return 'waiting_on_you'
      if (event.type === 'mute') return 'paused'
      if (event.type === 'connection_lost') return 'reconnecting'
      return null
    case 'waiting_on_you':
      if (event.type === 'answered') return 'thinking'
      if (event.type === 'speech_start') return 'hearing'
      if (event.type === 'run_done') return 'listening'
      if (event.type === 'mute') return 'paused'
      if (event.type === 'connection_lost') return 'reconnecting'
      return null
    case 'paused':
      return event.type === 'unmute' ? 'listening' : null
    case 'reconnecting':
      if (event.type === 'connection_restored') return 'listening'
      // Muted mid-reconnect: the listener is opened again on unmute.
      if (event.type === 'mute') return 'paused'
      return null
    case 'error':
      return event.type === 'retry' ? 'connecting' : null
  }
}

/** Short label for the orb's live region and the voice bar (§13.3). */
export const VOICE_STATE_LABEL: Readonly<Record<VoiceSessionState, string>> = {
  off: 'Voice off',
  connecting: 'Connecting',
  listening: 'Listening',
  hearing: 'Hearing you',
  thinking: 'Thinking',
  working: 'Working',
  speaking: 'Speaking',
  waiting_on_you: 'Needs you',
  paused: 'Muted',
  reconnecting: 'Reconnecting',
  error: 'Voice stopped'
}
