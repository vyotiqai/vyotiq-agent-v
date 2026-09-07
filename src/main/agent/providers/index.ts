import type { ModelInfo, ProviderId } from '../../../shared/ipc'
import { formatError } from '../../../shared/errors'
import { withResolvedContextWindow } from '../../../shared/domain/modelContextWindows'
import { providerLabel, providerNeedsKey, seedModelsFor } from '../../../shared/providers'
import { anthropicProvider } from './anthropic'
import { geminiProvider } from './gemini'
import {
  beginModelListFetch,
  clearModelCacheKey,
  clearModelListInflight,
  getCachedModels,
  getModelListInflight,
  modelCacheKey,
  setCachedModels,
  setModelListInflight
} from './modelCache'
import {
  assertValidProviderBaseUrl,
  clearOllamaSelectedShowCache,
  customProvider,
  deepseekProvider,
  enrichOllamaModelsWithSelectedShow,
  groqProvider,
  mistralProvider,
  ModelListUnsupportedError,
  ollamaProvider,
  openaiProvider,
  openrouterProvider,
  xaiProvider
} from './openai'
import { opencodeProvider } from './opencode'
import type { ListModelsRequest, LlmProvider } from './types'
import { preloadOpenCodeGoCatalog } from '../../../shared/domain/opencodeGoCatalog'
import { preloadModelsDevRegistry } from '../../../shared/domain/modelsDevRegistry'

// Warm the runtime model registries at startup: OpenCode Go's catalog without
// auth, and the models.dev index that backfills context windows for manually
// entered model ids on OpenAI-compatible hosts (no model-list route or no
// `context_length` in the listing).
preloadOpenCodeGoCatalog()
preloadModelsDevRegistry()

const providers: Record<ProviderId, LlmProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  ollama: ollamaProvider,
  deepseek: deepseekProvider,
  groq: groqProvider,
  openrouter: openrouterProvider,
  xai: xaiProvider,
  mistral: mistralProvider,
  custom: customProvider,
  opencode: opencodeProvider
}

export function getProvider(id: ProviderId): LlmProvider {
  return providers[id]
}

/** Providers whose model catalog endpoint is public (no API key required). */
export const PUBLIC_CATALOG_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(['opencode'])

/** Map catalog failures into provider-aware, actionable warnings. */
export function catalogWarningMessage(provider: ProviderId, err: unknown): string {
  const label = providerLabel(provider)
  const raw = formatError(err)

  if (/API key not set/i.test(raw)) {
    return `${raw} Save a key in Providers settings, then refresh.`
  }

  if (/Circuit open for /i.test(raw)) {
    return `${label} is temporarily paused after repeated failures. Retry shortly.`
  }

  if (/HTTP 401/i.test(raw)) {
    // DeepSeek (and some gateways) return this exact body when Authorization is missing/invalid.
    if (/Authentication Fails \(governor\)/i.test(raw)) {
      return `${label} returned HTTP 401 Authentication Fails (governor) — usually a missing or invalid API key. Save a valid ${label} key in Providers, then refresh.`
    }
    return `${label} returned HTTP 401 (unauthorized). Check the saved API key, then refresh.`
  }

  if (/HTTP 403/i.test(raw)) {
    return `${label} returned HTTP 403 (forbidden). Check the API key permissions.`
  }

  if (/Cannot reach Ollama|Cannot reach custom|returned no models/i.test(raw)) {
    return `${raw} Showing seed defaults (not live models).`
  }

  return `${label}: ${raw}. Showing seed defaults (not live models).`
}

function enrichCatalogModels(provider: ProviderId, models: ModelInfo[]): ModelInfo[] {
  return models.map((m) => withResolvedContextWindow(m, provider))
}

async function applyOllamaSelectedShow(
  input: {
    provider: ProviderId
    model?: string
    baseUrl?: string
    apiKey?: string | null
    signal?: AbortSignal
  },
  models: ModelInfo[],
  cacheKey?: string
): Promise<ModelInfo[]> {
  if (input.provider !== 'ollama' || !input.model?.trim()) return models
  const next = await enrichOllamaModelsWithSelectedShow(models, {
    model: input.model,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    signal: input.signal
  })
  if (cacheKey && next !== models) setCachedModels(cacheKey, next)
  return next
}

/** Race a shared catalog fetch against one caller’s abort without cancelling the fetch. */
export async function awaitCatalogWithCallerSignal<T>(
  run: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return run
  if (signal.aborted) {
    const err = new Error('Aborted')
    err.name = 'AbortError'
    throw err
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      const err = new Error('Aborted')
      err.name = 'AbortError'
      reject(err)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    run.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}

export async function listProviderModels(input: {
  provider: ProviderId
  apiKey?: string | null
  baseUrl?: string
  signal?: AbortSignal
  forceRefresh?: boolean
  model?: string
}): Promise<{ models: ModelInfo[]; warning?: string }> {
  const key = modelCacheKey(input.provider, input.baseUrl, input.apiKey)
  if (!input.forceRefresh) {
    const cached = getCachedModels(key)
    if (cached) {
      const models = await applyOllamaSelectedShow(
        input,
        enrichCatalogModels(input.provider, cached),
        key
      )
      return { models }
    }
    const pending = getModelListInflight(key)
    if (pending) {
      const result = await awaitCatalogWithCallerSignal(pending, input.signal)
      return {
        ...result,
        models: await applyOllamaSelectedShow(input, result.models, key)
      }
    }
  } else {
    // Drop memory/inflight so Refresh cannot join a stale in-flight catalog fetch.
    clearModelCacheKey(key)
    clearOllamaSelectedShowCache()
  }

  const generation = beginModelListFetch(key)
  const run = listProviderModelsUncached(
    { ...input, signal: undefined },
    key,
    generation
  )
  setModelListInflight(key, run)
  try {
    return await awaitCatalogWithCallerSignal(run, input.signal)
  } finally {
    clearModelListInflight(key, run)
  }
}

async function listProviderModelsUncached(
  input: {
    provider: ProviderId
    apiKey?: string | null
    baseUrl?: string
    signal?: AbortSignal
    forceRefresh?: boolean
    model?: string
  },
  key: string,
  generation: number
): Promise<{ models: ModelInfo[]; warning?: string }> {
  // OpenCode Go publishes its catalog without auth (verified: GET /v1/models →
  // HTTP 200 unauthenticated), so fetch it even before a key is saved. Chat
  // still requires a key via providerNeedsKey/preflight.
  const catalogNeedsKey =
    providerNeedsKey(input.provider, input.baseUrl) && !PUBLIC_CATALOG_PROVIDERS.has(input.provider)
  if (catalogNeedsKey && !input.apiKey?.trim()) {
    const seeds = seedModelsFor(input.provider)
    return {
      models: await applyOllamaSelectedShow(
        input,
        enrichCatalogModels(input.provider, seeds)
      ),
      warning: `${providerLabel(input.provider)} API key not set — showing illustrative placeholder model IDs. Save a key and refresh to load the live catalog.`
    }
  }

  const provider = getProvider(input.provider)
  const timeout = AbortSignal.timeout(10_000)
  const req: ListModelsRequest = {
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    signal: timeout
  }

  try {
    if (input.baseUrl) {
      assertValidProviderBaseUrl(input.baseUrl)
    }
    const models = await provider.listModels(req)
    if (!models.length) {
      if (input.forceRefresh) clearModelCacheKey(key)
      const seeds = seedModelsFor(input.provider)
      return {
        models: await applyOllamaSelectedShow(
          { ...input, signal: timeout },
          enrichCatalogModels(input.provider, seeds)
        ),
        warning: `${providerLabel(input.provider)} live catalog was empty; showing illustrative placeholder model IDs (not installed models).`
      }
    }
    const enriched = await applyOllamaSelectedShow(
      { ...input, signal: timeout },
      enrichCatalogModels(input.provider, models),
      key
    )
    setCachedModels(key, enriched, generation)
    return { models: enriched }
  } catch (err) {
    if (input.forceRefresh) clearModelCacheKey(key)
    const seeds = seedModelsFor(input.provider)
    // Reachable host without a model-list route (HTTP 405/501 on /models):
    // the provider connects for chat — manual model entry is the flow, not a fix.
    if (err instanceof ModelListUnsupportedError) {
      const label = providerLabel(input.provider)
      const hint =
        input.provider === 'custom'
          ? ' Type a model ID in the composer model picker search and press Enter to use it.'
          : ''
      return {
        models: await applyOllamaSelectedShow(
          { ...input, signal: timeout },
          enrichCatalogModels(input.provider, seeds)
        ),
        warning: `${label} does not serve a model list (HTTP ${err.status}); the host is reachable and chat can still connect.${hint} Showing illustrative placeholder model IDs (not live models).`
      }
    }
    const raw = formatError(err)
    const providerAlreadyExplained = /Cannot reach Ollama|Cannot reach custom|returned no models|HTTP \d+|API key not set/i.test(
      raw
    )
    const timedOut =
      !providerAlreadyExplained &&
      (raw === 'Request timed out' ||
        raw === 'Request aborted' ||
        (timeout.aborted && /abort|timed out/i.test(raw)))
    if (timedOut) {
      return {
        models: enrichCatalogModels(input.provider, seeds),
        warning: `Timed out after 10s reaching ${providerLabel(input.provider)}${
          input.baseUrl ? ` at ${normalizeHostForWarning(input.baseUrl)}` : ''
        }. Showing illustrative placeholder model IDs (not live models).`
      }
    }
    return {
      models: await applyOllamaSelectedShow(
        { ...input, signal: timeout },
        enrichCatalogModels(input.provider, seeds)
      ),
      warning: `${catalogWarningMessage(input.provider, err)} Showing illustrative placeholder model IDs (not the live catalog).`
    }
  }
}

function normalizeHostForWarning(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/i, '').replace(/\/$/, '')
}

export type { LlmProvider, StreamChunk, ToolCall, ProviderChatRequest, TokenUsage } from './types'
