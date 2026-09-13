import { useCallback } from 'react'
import type { ProviderId } from '@shared/ipc'
import type { ListModelsResult } from '@shared/ipc/schemas/providers'

type ProviderBaseUrls = {
  ollamaBaseUrl?: string
  customOpenAiBaseUrl?: string
}

type RefreshOptions = {
  forceRefresh?: boolean
  provider?: ProviderId
  ollamaBaseUrl?: string
  customOpenAiBaseUrl?: string
}

export function useModelCatalog(
  provider: ProviderId,
  baseUrls?: ProviderBaseUrls | string,
  _apiKey?: string | null,
  _enabled = true
): {
  refresh: (opts?: RefreshOptions) => Promise<
    { ok: true; data: ListModelsResult; warning?: string; models: ListModelsResult['models'] } | { ok: false; error: string }
  >
} {
  // Back-compat: older callers passed ollamaBaseUrl as a string.
  const urls: ProviderBaseUrls =
    typeof baseUrls === 'string' ? { ollamaBaseUrl: baseUrls } : (baseUrls ?? {})

  const refresh = useCallback(
    async (opts?: RefreshOptions) => {
      if (!window.vyotiq?.listModels) {
        return { ok: false as const, error: 'Unavailable' }
      }
      const targetProvider = opts?.provider ?? provider
      const ollama =
        opts?.ollamaBaseUrl ?? urls.ollamaBaseUrl
      const custom =
        opts?.customOpenAiBaseUrl ?? urls.customOpenAiBaseUrl
      const baseUrl =
        targetProvider === 'ollama'
          ? ollama
          : targetProvider === 'custom'
            ? custom
            : undefined
      const res = await window.vyotiq.listModels({
        provider: targetProvider,
        baseUrl,
        forceRefresh: opts?.forceRefresh ?? true
      })
      if (!res.ok) return res
      return {
        ok: true as const,
        data: res.data,
        models: res.data.models,
        warning: res.data.warning
      }
    },
    [provider, urls.ollamaBaseUrl, urls.customOpenAiBaseUrl]
  )

  return { refresh }
}
