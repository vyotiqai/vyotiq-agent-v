import { isAbortError } from '../../../shared/errors'
import {
  isRetriableNetworkError,
  isRetriableProviderMessage,
  RetriableStreamError
} from '../providers/fetchWithRetry'
import type { LlmProvider, ProviderChatRequest, TokenUsage } from '../providers/types'
import { circuitKeyProvider, isCircuitOpenError } from '../circuitBreaker'
import { runWithStreamRetry } from '../streamRetry'

export type StructuredParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; error?: string }

export async function collectStructuredResponse<T>(
  provider: LlmProvider,
  req: ProviderChatRequest & {
    responseFormat: NonNullable<ProviderChatRequest['responseFormat']>
  },
  parse: (raw: string) => StructuredParseResult<T>,
  /**
   * Fires once per billed provider stream, as the usage arrives. A sink rather
   * than a return value because this function has five exit paths (abort,
   * transient failure, stream error, parse failure, success) and the tokens were
   * charged on every one of them — a return channel would drop the spend on
   * exactly the failures worth seeing.
   */
  onUsage?: (usage: TokenUsage, attempt: number, generationMs: number) => void
): Promise<
  | { ok: true; data: T; rawText: string }
  | { ok: false; rawText: string; error: string; streamHttpStatus?: number }
> {
  let rawText = ''
  let streamError: string | undefined
  let streamHttpStatus: number | undefined
  let aborted = false
  let attempt = 0
  let startedAt = Date.now()

  try {
    await runWithStreamRetry({
      signal: req.signal,
      circuitKey: circuitKeyProvider(provider.id, req.baseUrl),
      onAttemptStart: (n) => {
        rawText = ''
        streamError = undefined
        // Retries re-send the whole prompt and are billed again, so the attempt
        // number is tracked while `rawText` resets.
        attempt = n
        startedAt = Date.now()
      },
      runAttempt: async () => {
        for await (const chunk of provider.streamChat(req)) {
          if (req.signal.aborted) {
            aborted = true
            return 'terminal'
          }
          if (chunk.type === 'done' && chunk.usage) {
            onUsage?.(chunk.usage, Math.max(1, attempt), Math.max(0, Date.now() - startedAt))
          }
          if (chunk.type === 'text' && chunk.text) rawText += chunk.text
          if (chunk.type === 'error') {
            const message = chunk.error ?? 'Provider error'
            if (isRetriableProviderMessage(message)) {
              throw new RetriableStreamError(message)
            }
            streamError = message
            streamHttpStatus = chunk.httpStatus
            return 'terminal'
          }
        }
        return 'complete'
      }
    })
  } catch (err) {
    if (isAbortError(err) || req.signal.aborted) {
      return { ok: false, rawText, error: 'Request aborted' }
    }
    if (err instanceof RetriableStreamError || isRetriableNetworkError(err) || isCircuitOpenError(err)) {
      // Transient connect/network failure — no hard status; callers keep their
      // fallback ladder for these.
      return {
        ok: false,
        rawText: '',
        error: err instanceof Error ? err.message : String(err)
      }
    }
    throw err
  }

  if (aborted || req.signal.aborted) {
    return { ok: false, rawText, error: 'Request aborted' }
  }
  if (streamError) {
    return { ok: false, rawText, error: streamError, streamHttpStatus }
  }

  rawText = rawText.trim()
  const parsed = parse(rawText)
  if (parsed.ok) return { ok: true, data: parsed.data, rawText }
  return { ok: false, rawText, error: parsed.error ?? 'Failed to parse structured response' }
}
