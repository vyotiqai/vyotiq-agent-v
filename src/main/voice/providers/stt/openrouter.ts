/**
 * OpenRouter listener: one transcription per turn through dictation's
 * OpenRouter path (`/audio/transcriptions`), with the OpenRouter key already
 * saved under Providers. OpenRouter has no streaming endpoint, so — like This
 * PC — the session's pause detector ends each turn and the words arrive after
 * it: no live captions, slower replies (docs/voice-mode.md §9.3, D-35).
 */
import { isRetryableVoiceError, type VoiceErrorCode } from '../../../../shared/voice'
import { transcribeDictation } from '../../../dictation/transcribe'
import type { SttEvent, SttProvider } from '../types'
import { TurnUploadSttSession } from './local'

type Transcribe = typeof transcribeDictation

/**
 * Dictation's failure codes in voice's words. Dictation folds other HTTP
 * failures into `engine_failed` with the status in its message
 * ("…could not transcribe this (402): …"), so the status is read back from
 * there: 402 is credit (OpenRouter wants $0.50 for audio), a 5xx is the
 * provider being down, not the turn.
 */
export function openRouterSttError(err: unknown): Extract<SttEvent, { kind: 'error' }> {
  const message = err instanceof Error ? err.message : String(err)
  const dictationCode = (err as { code?: unknown } | null)?.code
  const status = Number(/\((\d{3})\)/.exec(message)?.[1] ?? 0)
  let code: VoiceErrorCode
  switch (dictationCode) {
    case 'no_key':
    case 'rejected_key':
    case 'rate_limited':
    case 'offline':
      code = dictationCode
      break
    default:
      code = status === 402 ? 'out_of_credit' : status >= 500 ? 'provider_down' : 'engine_failed'
  }
  // A turn too long to upload fails the same way again on a retry.
  const retryable = dictationCode !== 'too_long' && isRetryableVoiceError(code)
  return { kind: 'error', code, message, retryable }
}

export function makeOpenRouterStt(transcribe: Transcribe = transcribeDictation): SttProvider {
  return {
    id: 'openrouter',
    async open(opts) {
      const session = new TurnUploadSttSession(opts.emit, opts.signal, transcribe, {
        engine: 'openrouter',
        language: opts.language || undefined,
        // The model you picked (B4): it was dropped here, so every turn went to gpt-transcribe.
        ...(opts.model ? { model: opts.model } : {}),
        // Transcribe at the first likely end of the turn; kept if the pause confirms it.
        early: true,
        toError: openRouterSttError
      })
      opts.emit({ kind: 'open' })
      return session
    }
  }
}
