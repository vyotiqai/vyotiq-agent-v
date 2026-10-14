import type { ProviderIdAny } from '@shared/ipc'
import type { EffectiveChatSettings } from '@shared/domain/effectiveSettings'
import { isLocalOllamaHost, resolveEffectiveOllamaHost } from '@shared/domain/providers'

type Endpoints = Pick<EffectiveChatSettings, 'ollamaBaseUrl' | 'customOpenAiBaseUrl' | 'customProviders'>

/** Loopback hosts: a model served here needs no network to answer. */
function isLoopbackUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return host === 'localhost' || host === '::1' || host === '0.0.0.0' || /^127\./.test(host)
  } catch {
    return false
  }
}

/**
 * True when a run on this provider talks only to this machine: Ollama on a
 * local host (and no key routing it to Ollama Cloud), or an OpenAI-compatible
 * endpoint on loopback. Such a run keeps going offline, so what is sent to it
 * goes to it, not to the offline queue.
 */
export function providerRunsLocally(
  provider: ProviderIdAny,
  endpoints: Endpoints,
  ollamaKeySet: boolean
): boolean {
  if (provider === 'ollama') {
    return isLocalOllamaHost(resolveEffectiveOllamaHost(endpoints.ollamaBaseUrl, ollamaKeySet ? 'key' : null))
  }
  if (provider === 'custom') return isLoopbackUrl(endpoints.customOpenAiBaseUrl)
  if (provider.startsWith('custom:')) {
    return isLoopbackUrl(endpoints.customProviders.find((p) => p.id === provider)?.baseUrl)
  }
  return false
}
