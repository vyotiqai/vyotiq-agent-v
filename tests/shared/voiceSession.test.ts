import { describe, expect, it } from 'vitest'
import {
  AGENT_FLOOR_STATES,
  VOICE_SESSION_STATES,
  VOICE_STATE_LABEL,
  nextVoiceState,
  type VoiceSessionEvent,
  type VoiceSessionState
} from '@shared/voiceSession'

function run(events: VoiceSessionEvent[], from: VoiceSessionState = 'off'): VoiceSessionState {
  let state = from
  for (const e of events) {
    const next = nextVoiceState(state, e)
    if (next === null) throw new Error(`${e.type} not allowed in ${state}`)
    state = next
  }
  return state
}

describe('voice session state machine', () => {
  it('walks a whole turn: listen, hear, think, work, speak, listen', () => {
    expect(
      run([
        { type: 'start' },
        { type: 'ready' },
        { type: 'speech_start' },
        { type: 'end_of_turn' },
        { type: 'tool_start' },
        { type: 'audio_start' },
        { type: 'audio_done', runActive: true },
        { type: 'audio_start' },
        { type: 'audio_done', runActive: false }
      ])
    ).toBe('listening')
  })

  it('lets you barge in whenever the agent has the floor', () => {
    for (const s of AGENT_FLOOR_STATES) expect(nextVoiceState(s, { type: 'barge_in' })).toBe('hearing')
    expect(nextVoiceState('listening', { type: 'barge_in' })).toBeNull()
  })

  it('handles approvals and questions', () => {
    expect(run([{ type: 'needs_you' }, { type: 'answered' }], 'working')).toBe('thinking')
    expect(run([{ type: 'needs_you' }, { type: 'speech_start' }], 'speaking')).toBe('hearing')
  })

  it('pauses on mute and comes back to listening', () => {
    expect(run([{ type: 'mute' }, { type: 'unmute' }], 'speaking')).toBe('listening')
    expect(nextVoiceState('paused', { type: 'speech_start' })).toBeNull()
  })

  it('reconnects, errors and retries', () => {
    expect(run([{ type: 'connection_lost' }, { type: 'connection_restored' }], 'hearing')).toBe('listening')
    expect(run([{ type: 'fail' }, { type: 'retry' }], 'reconnecting')).toBe('connecting')
  })

  it('stops from any live state, and ignores stop when already off', () => {
    for (const s of VOICE_SESSION_STATES) {
      expect(nextVoiceState(s, { type: 'stop' })).toBe(s === 'off' ? null : 'off')
    }
  })

  it('a false start goes back to listening without a turn', () => {
    expect(run([{ type: 'speech_start' }, { type: 'false_start' }], 'listening')).toBe('listening')
  })

  it('labels every state', () => {
    for (const s of VOICE_SESSION_STATES) expect(VOICE_STATE_LABEL[s].length).toBeGreaterThan(0)
  })
})
