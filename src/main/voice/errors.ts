import { isRetryableVoiceError, type VoiceErrorCode } from '../../shared/voice'

/**
 * A voice failure with its typed code. Adapters throw or emit these; the IPC
 * layer sends `voiceIpcCode(code)`, and the renderer words it. `message` is
 * for logs only and may contain provider text, so it never reaches the UI.
 */
export class VoiceError extends Error {
  readonly code: VoiceErrorCode
  readonly retryable: boolean

  constructor(code: VoiceErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'VoiceError'
    this.code = code
    this.retryable = isRetryableVoiceError(code)
  }
}

export function isVoiceError(err: unknown): err is VoiceError {
  return err instanceof VoiceError
}

/** Any thrown value as a VoiceError; a socket or fetch failure counts as offline. */
export function toVoiceError(err: unknown): VoiceError {
  if (isVoiceError(err)) return err
  if (err instanceof Error && err.name === 'AbortError') return new VoiceError('engine_failed', 'aborted', { cause: err })
  const message = err instanceof Error ? err.message : String(err)
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network/i.test(message)) {
    return new VoiceError('offline', message, { cause: err })
  }
  return new VoiceError('engine_failed', message, { cause: err })
}
