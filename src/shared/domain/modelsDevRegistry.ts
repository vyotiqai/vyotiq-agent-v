import type { ProviderId } from '../ipc/schemas/providers'
import { coreModelId } from './modelContextWindows'

/**
 * Global model-metadata registry backed by https://models.dev/api.json.
 *
 * OpenAI-compatible endpoints come in two flavors: fixed providers (their
 * catalog is part of the API contract) and bring-your-own hosts (vLLM,
 * llama.cpp, gateways). Manually entered model ids on either get no live
 * metadata when the host omits `context_length` — or serves no model-list
 * route at all (Cloudflare Workers AI compat 405s on GET /v1/models).
 *
 * models.dev catalogs 200+ providers with per-provider `limit.context` values
 * and each provider's real API base URL. Context windows are SERVING-specific
 * (the same model id is served with different windows by different hosts —
 * e.g. glm-4.7-flash is 131,072 on Cloudflare but ~200k on other gateways),
 * so a bare model-id match would fake wrong numbers. Resolution order:
 *
 *  1. Endpoint host match → the registry provider whose `api` URL host equals
 *     the configured base URL host; full id, then vendor-stripped core id.
 *  2. Fixed-provider id mapping (deepseek → `deepseek`, groq → `groq`, …).
 *  3. Cross-provider consensus for the core id — only when EVERY provider
 *     listing it agrees on one exact value. Disputed values stay unknown.
 *
 * Verified against Cloudflare's live account catalog (2026-09-05): registry
 * values matched the native `context_window` properties exactly for every
 * probed model.
 */

const MODELS_DEV_API = 'https://models.dev/api.json'
const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000
/** Run-start lookups await this fetch — never let a hung request stall a turn. */
const REGISTRY_FETCH_TIMEOUT_MS = 15_000

type ModelsDevModel = {
  id?: string
  name?: string
  reasoning?: boolean
  tool_call?: boolean
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; output?: number }
}

/** One model as a registry provider lists it — what a model picker needs. */
export type ModelsDevListing = {
  id: string
  name: string
  contextWindow?: number
  maxOutputTokens?: number
  reasoning: boolean
  toolCall: boolean
  inputModalities: string[]
  outputModalities: string[]
}
type ModelsDevProvider = {
  id?: string
  api?: string
  models?: Record<string, ModelsDevModel>
}

type RegistryProvider = {
  id: string
  /** Full model id (lowercased) → context window tokens. */
  models: Map<string, number>
  /** Core id (vendor prefix stripped) → context window. Skipped when a
   *  provider lists two different windows under one core id (ambiguous). */
  core: Map<string, number>
  /** Every listed model, in registry order (ids keep their case). */
  listings: ModelsDevListing[]
}

type RegistryIndex = {
  fetchedAt: number
  providersById: Map<string, RegistryProvider>
  /** URL host (hostname[:port]) → provider ids whose `api` URL uses it. */
  byHost: Map<string, string[]>
  /** Core model id (lowercased) → per-provider distinct context values. */
  byCore: Map<string, Map<string, Set<number>>>
}

/** models.dev registry ids for this app's fixed providers. */
const REGISTRY_ID_BY_PROVIDER: Partial<Record<ProviderId, string>> = {
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'google',
  deepseek: 'deepseek',
  groq: 'groq',
  openrouter: 'openrouter',
  xai: 'xai',
  mistral: 'mistral',
  // The app's `opencode` provider is OpenCode Go; models.dev keeps that under
  // `opencode-go` (`opencode` is the separate Zen catalog).
  opencode: 'opencode-go',
  bedrock: 'amazon-bedrock',
  vertex: 'google-vertex'
}

let index: RegistryIndex | null = null
let inflight: Promise<RegistryIndex> | null = null

function hostOf(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined
  try {
    return new URL(rawUrl).host.toLowerCase()
  } catch {
    return undefined
  }
}

function buildIndex(json: Record<string, ModelsDevProvider>): RegistryIndex {
  const providersById = new Map<string, RegistryProvider>()
  const byHost = new Map<string, string[]>()
  const byCore = new Map<string, Map<string, Set<number>>>()
  for (const [pid, provider] of Object.entries(json)) {
    const models = new Map<string, number>()
    const core = new Map<string, number>()
    const listings: ModelsDevListing[] = []
    for (const raw of Object.values(provider.models ?? {})) {
      if (!raw?.id) continue
      const out = raw.limit?.output
      listings.push({
        id: raw.id.trim(),
        name: raw.name?.trim() || raw.id.trim(),
        ...(typeof raw.limit?.context === 'number' && raw.limit.context > 0 ? { contextWindow: raw.limit.context } : {}),
        ...(typeof out === 'number' && out > 0 ? { maxOutputTokens: out } : {}),
        reasoning: raw.reasoning === true,
        toolCall: raw.tool_call === true,
        inputModalities: raw.modalities?.input ?? ['text'],
        outputModalities: raw.modalities?.output ?? ['text']
      })
      const ctx = raw.limit?.context
      if (typeof ctx !== 'number' || !Number.isFinite(ctx) || ctx <= 0) continue
      const full = raw.id.trim().toLowerCase()
      models.set(full, ctx)
      const coreId = coreModelId(full)
      // Two different windows under one core id inside a single provider:
      // ambiguous — no core-level answer may be claimed for it.
      if (core.get(coreId) != null && core.get(coreId) !== ctx) core.set(coreId, Number.NaN)
      else if (!core.has(coreId)) core.set(coreId, ctx)
      let perProvider = byCore.get(coreId)
      if (!perProvider) {
        perProvider = new Map()
        byCore.set(coreId, perProvider)
      }
      let values = perProvider.get(pid)
      if (!values) {
        values = new Set()
        perProvider.set(pid, values)
      }
      values.add(ctx)
    }
    if (models.size === 0 && listings.length === 0) continue
    providersById.set(pid, { id: pid, models, core, listings })
    const host = hostOf(provider.api)
    if (host) {
      const ids = byHost.get(host)
      if (ids) {
        if (!ids.includes(pid)) ids.push(pid)
      } else {
        byHost.set(host, [pid])
      }
    }
  }
  return { fetchedAt: Date.now(), providersById, byHost, byCore }
}

async function fetchRegistry(signal?: AbortSignal): Promise<RegistryIndex> {
  const timeout = AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS)
  const res = await fetch(MODELS_DEV_API, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  })
  if (!res.ok) {
    throw new Error(`models.dev API returned HTTP ${res.status}`)
  }
  const json = (await res.json()) as Record<string, ModelsDevProvider>
  index = buildIndex(json)
  return index
}

/** Load (or refresh) the registry. Concurrent callers share one fetch. */
export async function loadModelsDevRegistry(opts?: {
  forceRefresh?: boolean
  signal?: AbortSignal
}): Promise<RegistryIndex> {
  const stale = !index || opts?.forceRefresh || Date.now() - index.fetchedAt > REGISTRY_TTL_MS
  if (!stale && index) return index
  if (inflight && !opts?.forceRefresh) return inflight
  inflight =
    inflight ??
    fetchRegistry(opts?.signal).finally(() => {
      inflight = null
    })
  return inflight
}

/** Warm the registry ahead of the first metadata lookup (call from main). */
export function preloadModelsDevRegistry(): void {
  void loadModelsDevRegistry().catch(() => {
    /* surfaced on next real lookup */
  })
}

function lookupContextWindow(
  registry: RegistryIndex,
  modelId: string,
  opts?: { providerId?: ProviderId; apiHost?: string }
): number | undefined {
  const full = modelId.trim().toLowerCase()
  if (!full) return undefined
  const core = coreModelId(full)

  const candidates: string[] = []
  if (opts?.apiHost) {
    for (const pid of registry.byHost.get(opts.apiHost.toLowerCase()) ?? []) {
      candidates.push(pid)
    }
  }
  const mapped = opts?.providerId ? REGISTRY_ID_BY_PROVIDER[opts.providerId] : undefined
  if (mapped && !candidates.includes(mapped)) candidates.push(mapped)

  for (const pid of candidates) {
    const provider = registry.providersById.get(pid)
    if (!provider) continue
    const ctx = provider.models.get(full) ?? provider.core.get(core)
    // NaN marks an in-provider ambiguous core id (two different windows).
    if (ctx != null && Number.isFinite(ctx)) return ctx
  }

  // No serving-specific match: fall to consensus. Every provider listing this
  // core id must agree on one value — a single listing is unanimous; disputed
  // serving configs stay unknown rather than guessed.
  const perProvider = registry.byCore.get(core)
  if (perProvider && perProvider.size > 0) {
    const values = new Set<number>()
    for (const set of perProvider.values()) {
      for (const v of set) values.add(v)
    }
    if (values.size === 1) return values.values().next().value
  }
  return undefined
}

/**
 * Context window for a model id from the registry, awaiting the load so a
 * cold cache still resolves. Returns undefined when the registry is
 * unreachable, the model is unlisted, or its serving config is disputed.
 */
export async function resolveModelsDevContextWindow(
  modelId: string,
  opts?: { providerId?: ProviderId; apiHost?: string; signal?: AbortSignal }
): Promise<number | undefined> {
  let registry: RegistryIndex
  try {
    registry = await loadModelsDevRegistry({ signal: opts?.signal })
  } catch {
    return undefined
  }
  return lookupContextWindow(registry, modelId, opts)
}

/**
 * The models a registry provider lists (for a fixed provider id), awaiting the
 * load. Throws when the registry can't be reached — a caller showing it as a
 * catalog must say so rather than show an empty list.
 */
export async function modelsDevListings(
  providerId: ProviderId,
  opts?: { signal?: AbortSignal }
): Promise<ModelsDevListing[]> {
  const registryId = REGISTRY_ID_BY_PROVIDER[providerId]
  if (!registryId) return []
  const registry = await loadModelsDevRegistry({ signal: opts?.signal })
  return registry.providersById.get(registryId)?.listings ?? []
}

/** Test hook — replace the registry index with a fixture (prevents network). */
export type ModelsDevRegistryFixture = Record<
  string,
  { api?: string; models?: Record<string, ModelsDevModel> } | undefined
>

export function __setModelsDevRegistryForTests(providers: ModelsDevRegistryFixture | null): void {
  index = providers ? buildIndex(providers as Record<string, ModelsDevProvider>) : null
  inflight = null
}
