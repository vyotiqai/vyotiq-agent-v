import type { VoiceErrorCode } from '@shared/voice'

/** What went wrong, in plain words, and the one fix the bar offers (§15, B8). */
export type VoiceProblem = { message: string; fix: 'settings' | 'mic' | 'retry' | null }

export function voiceProblem(code: VoiceErrorCode): VoiceProblem {
  switch (code) {
    case 'no_key':
      return { message: 'Voice mode needs a key for a listening provider.', fix: 'settings' }
    case 'rejected_key':
      return { message: 'The voice provider rejected its key.', fix: 'settings' }
    case 'out_of_credit':
      return { message: 'The voice provider says the account is out of credit.', fix: 'settings' }
    case 'rate_limited':
      return { message: 'The voice provider is busy right now.', fix: 'retry' }
    case 'offline':
      return { message: 'Lost the connection to the voice provider.', fix: 'retry' }
    case 'provider_down':
      return { message: 'The voice provider isn’t responding.', fix: 'retry' }
    case 'mic_blocked':
      return { message: 'The microphone is blocked for Vyotiq.', fix: 'mic' }
    case 'mic_missing':
      return { message: 'No microphone found.', fix: 'retry' }
    case 'unsupported':
      return { message: 'This system can’t capture audio here.', fix: null }
    case 'engine_failed':
      return { message: 'Voice mode stopped unexpectedly.', fix: 'retry' }
  }
}
