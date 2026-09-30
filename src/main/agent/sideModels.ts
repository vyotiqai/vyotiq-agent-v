import type { ModelRef, ProviderIdAny, Settings } from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { providerNeedsKey, resolveProviderChatBaseUrl } from '../../shared/providers'
import { getSecret } from '@main/settings/secrets'

/**
 * The utility model (Settings → Agent), for side calls that don't need the
 * task's model: compaction summaries and commit messages. Returns null when
 * none is set, or when its provider has no key — the side call then runs on
 * the task's model as it always did, rather than failing.
 */
export function usableUtilityModel(settings: Settings): (ModelRef & { apiKey: string | null; baseUrl: string | undefined }) | null {
  const ref = settings.utilityModel
  if (!ref) return null
  const provider: ProviderIdAny = ref.provider
  let apiKey: string | null = null
  let baseUrl: string | undefined
  try {
    apiKey = getSecret(provider)
    baseUrl = resolveProviderChatBaseUrl(provider, settings, apiKey)
  } catch (err) {
    logger.warn('Utility model is set but its provider could not be resolved; using the task model', {
      scope: 'agent',
      provider,
      err
    })
    return null
  }
  if (providerNeedsKey(provider, baseUrl ?? settings.ollamaBaseUrl) && !apiKey?.trim()) {
    logger.warn('Utility model is set but its provider has no API key; using the task model', {
      scope: 'agent',
      provider
    })
    return null
  }
  return { provider, model: ref.model, apiKey, baseUrl }
}
