import type { ModelInfo, ProviderId } from '../../shared/ipc'
import {
  knownContextWindow,
  withResolvedContextWindow
} from '../../shared/domain/modelContextWindows'
import { resolveModelsDevContextWindow } from '../../shared/domain/modelsDevRegistry'
import { seedModelsFor } from '../../shared/providers'
import { findOllamaCatalogModel } from '../../shared/reasoning'
import { baseModelInfo } from './providers/normalize'
import { listProviderModels } from './providers'

/**
 * Resolve model metadata, falling back to seeds and finally to conservative
 * defaults so an unlisted model still runs instead of failing the turn.
 *
 * Live catalogs that omit `context_length` are backfilled from known windows /
 * seeds before the 128k default — otherwise DeepSeek (and similar) silently
 * budget against the wrong window. Unlisted ids (manual entry on hosts with no
 * model-list route, e.g. Cloudflare compat) resolve from the models.dev
 * registry: the endpoint's host picks the serving-specific provider entry, and
 * disputed windows stay unknown rather than guessed.
 */
export async function resolveModelInfo(
  providerId: ProviderId,
  modelId: string,
  apiKey: string | null,
  baseUrl: string | undefined,
  signal: AbortSignal
): Promise<ModelInfo> {
  const listed = await listProviderModels({
    provider: providerId,
    apiKey,
    baseUrl,
    signal,
    model: modelId
  })
  const apiHost = hostOf(baseUrl)
  const registryCtx = (): Promise<number | undefined> =>
    resolveModelsDevContextWindow(modelId, { providerId, apiHost, signal })
  const found =
    providerId === 'ollama'
      ? findOllamaCatalogModel(listed.models, modelId)
      : listed.models.find((m) => m.id === modelId)
  if (found) {
    const enriched = withResolvedContextWindow(found, providerId)
    if (enriched.contextWindow != null && enriched.contextWindow > 0) return enriched
    const fromRegistry = await registryCtx()
    if (fromRegistry != null && fromRegistry > 0) {
      return { ...enriched, contextWindow: fromRegistry }
    }
    const seed = seedModelsFor(providerId).find((m) => m.id === modelId)
    if (seed?.contextWindow != null && seed.contextWindow > 0) {
      return { ...enriched, contextWindow: seed.contextWindow }
    }
    return enriched
  }
  const seed = seedModelsFor(providerId).find((m) => m.id === modelId)
  if (seed) return withResolvedContextWindow(seed, providerId)
  const known = knownContextWindow(modelId, providerId)
  const fromRegistry = known != null ? undefined : await registryCtx()
  return baseModelInfo(
    modelId,
    {
      contextWindow: known ?? fromRegistry ?? 128_000,
      supportsTools: providerId !== 'ollama' || /tool|coder|qwen|llama3|mistral/i.test(modelId)
    },
    providerId
  )
}

function hostOf(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined
  try {
    return new URL(baseUrl).host.toLowerCase()
  } catch {
    return undefined
  }
}
