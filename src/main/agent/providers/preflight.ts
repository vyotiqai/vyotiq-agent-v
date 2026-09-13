import type { ProviderId } from '../../../shared/ipc'
import {
  isOllamaCloudHost,
  providerNeedsKey
} from '../../../shared/domain/providers'

export type ProviderPreflightFailure = {
  code: 'PROVIDER_AUTH' | 'PROVIDER_KEYCHAIN' | 'PROVIDER_KEY_DECRYPT'
  message: string
}

/**
 * Fail-closed checks before starting an agent stream (keys / host mismatches).
 * Does not hit the network — invalid-but-present keys still fail at request time.
 */
export function preflightChatProviderAuth(opts: {
  providerId: ProviderId
  apiKey: string | null
  baseUrl: string | null | undefined
  encryptionAvailable: boolean
  hasStoredBlob: boolean
}): ProviderPreflightFailure | null {
  const { providerId, apiKey, baseUrl, encryptionAvailable, hasStoredBlob } = opts
  if (!providerNeedsKey(providerId, baseUrl ?? undefined)) return null
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
      message: `API key for ${providerId} is stored but cannot be decrypted. Re-enter it in Settings or restore OS keychain access.`
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
    message: `API key for ${providerId} is not set. Add it in Settings → Providers.`
  }
}
