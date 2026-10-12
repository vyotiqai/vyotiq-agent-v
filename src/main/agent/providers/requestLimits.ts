import type { ModelInfo, ProviderId } from '../../../shared/ipc'

const OPENAI_COMPAT_PROVIDERS = new Set<ProviderId>([
  'openai',
  'groq',
  'xai',
  'mistral',
  'deepseek',
  'openrouter',
  'ollama',
  'custom',
  // Go's /chat/completions mount is an OpenAI-compat subscription gateway;
  // registry output ceilings must not be reserved against max_tokens.
  'opencode'
])

/**
 * Hosted OpenAI-compatible APIs whose own default output limit can be small
 * (DeepSeek defaults to 4k) and that take `max_tokens` as sent. These get a
 * moderate explicit limit instead of the host's default.
 *
 * Left out on purpose:
 * - `openai` streams through the Responses API, where the model's own maximum
 *   already applies, and its chat models reject `max_tokens`.
 * - `ollama` and `custom` are usually local servers whose default is "until the
 *   context is full"; a fixed limit there can only make a request fail when the
 *   prompt plus the limit passes a small window (vLLM rejects it outright).
 *   A per-model "Max output" on the endpoint overrides this.
 * - `opencode`, see above.
 */
const MODERATE_LIMIT_PROVIDERS = new Set<ProviderId>(['groq', 'xai', 'mistral', 'deepseek', 'openrouter'])

/** The usual output limit sent to the providers above. */
export const MODERATE_MAX_OUTPUT_TOKENS = 16_384

/** Sent instead after a reply was cut off at the limit, so the next attempt has room. */
export const BOOSTED_MAX_OUTPUT_TOKENS = 32_768

export type RequestMaxOutputOptions = {
  /** The previous reply hit the output limit; ask for more room this time. */
  boost?: boolean
}

/**
 * Output token limit to send on a provider request.
 *
 * Catalog `maxOutputTokens` is the model's capability ceiling — not a safe default
 * for billing. OpenRouter (and other OpenAI-compat APIs) reserve credits against
 * `max_tokens`, so sending the catalog max (e.g. 65536) can fail with HTTP 402
 * even when the actual output would be small. Those get a moderate limit capped
 * by the catalog instead, and the provider retries once without it when the host
 * rejects the value (see `shouldRetryOmitMaxTokens`).
 *
 * A model whose `limitsSource` is `'user'` was set by hand on a custom
 * endpoint; that value is always sent as is.
 */
export function requestMaxOutputTokens(
  providerId: ProviderId,
  modelInfo: Pick<ModelInfo, 'maxOutputTokens' | 'limitsSource'>,
  opts: RequestMaxOutputOptions = {}
): number | undefined {
  const catalogMax =
    typeof modelInfo.maxOutputTokens === 'number' && modelInfo.maxOutputTokens > 0
      ? modelInfo.maxOutputTokens
      : undefined
  if (modelInfo.limitsSource === 'user' && catalogMax) return catalogMax
  if (MODERATE_LIMIT_PROVIDERS.has(providerId)) {
    const wanted = opts.boost ? BOOSTED_MAX_OUTPUT_TOKENS : MODERATE_MAX_OUTPUT_TOKENS
    return catalogMax ? Math.min(catalogMax, wanted) : wanted
  }
  if (OPENAI_COMPAT_PROVIDERS.has(providerId)) {
    return undefined
  }
  return catalogMax
}
