import {
  isCustomProviderId,
  type CustomProvider,
  type ProviderIdAny
} from '../../../shared/ipc'
import {
  isOllamaCloudHost,
  providerLabel,
  providerNeedsKey
} from '../../../shared/domain/providers'

export type ProviderPreflightFailure = {
  code: 'PROVIDER_AUTH' | 'PROVIDER_KEYCHAIN' | 'PROVIDER_KEY_DECRYPT' | 'SETTINGS'
  message: string
}

/**
 * Fail-closed checks before starting an agent stream (keys / host mismatches).
 * Does not hit the network — invalid-but-present keys still fail at request time.
 */
export function preflightChatProviderAuth(opts: {
  providerId: ProviderIdAny
  /** Saved custom endpoints; a `custom:<slug>` id must name one of them. */
  customProviders?: readonly CustomProvider[]
  apiKey: string | null
  baseUrl: string | null | undefined
  encryptionAvailable: boolean
  hasStoredBlob: boolean
}): ProviderPreflightFailure | null {
  const { providerId, apiKey, baseUrl, encryptionAvailable, hasStoredBlob } = opts
  // A chat or workspace can still name an endpoint removed from Settings since.
  // Its base URL no longer resolves, so sending would reach some other host.
  if (
    isCustomProviderId(providerId) &&
    !opts.customProviders?.some((entry) => entry.id === providerId)
  ) {
    return {
      code: 'SETTINGS',
      message:
        'The custom endpoint this task uses was removed from Settings → Providers. Pick another model.'
    }
  }
  if (!providerNeedsKey(providerId, baseUrl ?? undefined)) return null
  const label = providerLabel(providerId, opts.customProviders)
  if (apiKey?.trim()) return null

  if (!encryptionAvailable) {
    return {
      code: 'PROVIDER_KEYCHAIN',
      message:
        'OS secure storage is unavailable. API keys cannot be decrypted on this system.'
    }
  }
  if (hasStoredBlob) {
    return {
      code: 'PROVIDER_KEY_DECRYPT',
      message: `API key for ${label} is stored but cannot be decrypted. Re-enter it in Settings → Providers or restore OS keychain access.`
    }
  }
  if (providerId === 'ollama' && isOllamaCloudHost(baseUrl ?? '')) {
    return {
      code: 'PROVIDER_AUTH',
      message:
        'Ollama Cloud (ollama.com) requires an API key. Add it in Settings → Providers, or switch the Ollama base URL to a local host (e.g. http://127.0.0.1:11434).'
    }
  }
  return {
    code: 'PROVIDER_AUTH',
    message: `API key for ${label} is not set. Add it in Settings → Providers.`
  }
}
