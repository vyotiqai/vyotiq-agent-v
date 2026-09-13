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
 * Output token limit to send on a provider request.
 *
 * Catalog `maxOutputTokens` is the model's capability ceiling — not a safe default
 * for billing. OpenRouter (and other OpenAI-compat APIs) reserve credits against
 * `max_tokens`, so sending the catalog max (e.g. 65536) can fail with HTTP 402
 * even when the actual output would be small.
 */
export function requestMaxOutputTokens(
  providerId: ProviderId,
  modelInfo: Pick<ModelInfo, 'maxOutputTokens'>
): number | undefined {
  if (OPENAI_COMPAT_PROVIDERS.has(providerId)) {
    return undefined
  }
  return modelInfo.maxOutputTokens
}
