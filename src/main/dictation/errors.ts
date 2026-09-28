import type { DictationErrorCode } from '../../shared/ipc'

/**
 * A transcription failure the take can act on. The IPC handler returns
 * `code` as `dictation:<code>`, so the renderer picks its fix (Add key,
 * Install, Retry) from the code, never from the wording of `message`.
 */
export class DictationError extends Error {
  readonly code: DictationErrorCode

  constructor(code: DictationErrorCode, message: string) {
    super(message)
    this.name = 'DictationError'
    this.code = code
  }
}

export function isDictationError(err: unknown): err is DictationError {
  return err instanceof DictationError
}
