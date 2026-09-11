import type { ModelInfo, ThinkingEffort } from '../ipc/schemas/providers'

/**
 * Runtime model catalog for OpenCode Go (`opencode`).
 *
 * OpenCode Go's live `/v1/models` endpoint returns **bare ids only** — no
 * context window, modalities, or reasoning-effort ladders. Those capabilities
 * live in the models.dev `opencode-go` registry entry, so we resolve them at
 * runtime from `https://models.dev/api.json` instead of hardcoding a static
 * table in the repo. The source is keyed by provider id and re-validated
 * periodically; nothing here is a committed constant.
 *
 * Endpoint *routing* (responses / messages / chat/completions) is protocol,
 * not capability data, and cannot be derived from the catalog — it stays as a
 * small structural mapping below. Everything user-visible (context window,
 * output token limit, modalities, reasoning-effort ladders) is fetched live.
 */

export type OpenCodeTransport = 'responses' | 'messages' | 'chat'

type ModelsDevModel = {
  id: string
  name?: string
  reasoning?: boolean
  reasoning_options?: Array<{ type: string; values?: string[] }>
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; output?: number }
}

type ModelsDevProvider = {
  id: string
  name?: string
  api?: string
  doc?: string
  models?: Record<string, ModelsDevModel> | ModelsDevModel[]
}

const MODELS_DEV_API = 'https://models.dev/api.json'
const PROVIDER_ID = 'opencode-go'

/** Re-fetch the catalog at most this often (it changes only when models ship). */
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000

type CatalogState = {
  fetchedAt: number
  models: Map<string, ModelsDevModel>
  /** Resolved metadata; lazily populated from `models`. */
  meta: Map<string, OpenCodeModelMeta>
}

type OpenCodeModelMeta = {
  contextWindow: number
  maxOutputTokens: number
  inputModalities: OpenCodeInputModality[]
  /** Declared reasoning-effort ladder (from `reasoning_options`), if any. */
  supportedThinkingEfforts?: readonly ThinkingEffort[]
  /** True when the registry marks reasoning as non-disablable (mandatory). */
  thinkingCanDisable: boolean
}

/** Wire-sendable input modalities (video is not representable on our schema). */
export type OpenCodeInputModality = ModelInfo['inputModalities'][number]

const EFFORT_OPTION_TYPES = new Set(['effort'])
const KNOWN_EFFORTS: readonly ThinkingEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

let catalogState: CatalogState | null = null
let inflight: Promise<CatalogState> | null = null

function asModelArray(
  models: ModelsDevProvider['models']
): ModelsDevModel[] {
  if (!models) return []
  return Array.isArray(models) ? models : Object.values(models)
}

function mapModalities(input: string[] | undefined): OpenCodeInputModality[] {
  // App schema: text | image | audio | file. Drop video/pdf→file stands in for pdf.
  const allowed: OpenCodeInputModality[] = []
  for (const m of input ?? []) {
    const norm = m.toLowerCase()
    if (norm === 'video') continue
    if (norm === 'pdf') {
      if (!allowed.includes('file')) allowed.push('file')
      continue
    }
    if ((['text', 'image', 'audio', 'file'] as const).includes(norm as OpenCodeInputModality)) {
      allowed.push(norm as OpenCodeInputModality)
    }
  }
  return allowed.length ? allowed : ['text']
}

function effortFromOptions(
  options: ModelsDevModel['reasoning_options']
): { ladder?: readonly ThinkingEffort[]; canDisable: boolean } {
  const list = options ?? []
  const ladder: ThinkingEffort[] = []
  for (const opt of list) {
    if (!EFFORT_OPTION_TYPES.has(opt.type)) continue
    for (const v of opt.values ?? []) {
      const e = v.toLowerCase() as ThinkingEffort
      if ((KNOWN_EFFORTS as readonly string[]).includes(e)) {
        if (!ladder.includes(e)) ladder.push(e)
      }
    }
  }
  // models.dev lists only the *enabled* tiers. Disable is possible when an
  // explicit affordance exists: a `toggle` option (Anthropic-style) or an
  // `effort: none` rung. Models that declare effort tiers without either
  // cannot be disabled (the Go mount rejects it with "[1210] cannot be
  // disabled"). No options at all → the transport default still applies.
  const hasToggle = list.some((o) => o.type === 'toggle')
  const hasNone = list.some((o) =>
    (o.values ?? []).some((v) => v.toLowerCase() === 'none')
  )
  const canDisable = list.length === 0 ? true : hasToggle || hasNone
  return { ladder: ladder.length ? ladder : undefined, canDisable }
}

function resolveMeta(raw: ModelsDevModel): OpenCodeModelMeta {
  const { ladder, canDisable } = effortFromOptions(raw.reasoning_options)
  return {
    contextWindow: raw.limit?.context ?? 0,
    maxOutputTokens: raw.limit?.output ?? 0,
    inputModalities: mapModalities(raw.modalities?.input),
    supportedThinkingEfforts: ladder,
    thinkingCanDisable: raw.reasoning === false ? true : canDisable
  }
}

async function fetchCatalog(signal?: AbortSignal): Promise<CatalogState> {
  const res = await fetch(MODELS_DEV_API, { signal })
  if (!res.ok) {
    throw new Error(`models.dev API returned HTTP ${res.status}`)
  }
  const json = (await res.json()) as Record<string, ModelsDevProvider>
  const provider = json[PROVIDER_ID]
  const models = new Map<string, ModelsDevModel>()
  for (const raw of asModelArray(provider?.models)) {
    if (raw?.id) models.set(raw.id.toLowerCase(), raw)
  }
  const meta = new Map<string, OpenCodeModelMeta>()
  for (const [id, raw] of models) meta.set(id, resolveMeta(raw))
  return { fetchedAt: Date.now(), models, meta }
}

/** Load (or refresh) the catalog. Concurrent callers share one in-flight fetch. */
export async function loadOpenCodeGoCatalog(
  opts?: { forceRefresh?: boolean; signal?: AbortSignal }
): Promise<CatalogState> {
  const stale =
    !catalogState || opts?.forceRefresh || Date.now() - catalogState.fetchedAt > CATALOG_TTL_MS
  if (!stale && catalogState) return catalogState
  if (opts?.forceRefresh) {
    // A forced refresh must not join (or return) an older in-flight fetch.
    const run = fetchCatalog(opts.signal)
      .then((state) => {
        catalogState = state
        return state
      })
      .finally(() => {
        if (inflight === run) inflight = null
      })
    inflight = run
    return run
  }
  if (inflight) return inflight
  inflight = fetchCatalog(opts?.signal)
    .then((state) => {
      catalogState = state
      return state
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** Warm the catalog ahead of the first capability lookup (call from main). */
export function preloadOpenCodeGoCatalog(): void {
  void loadOpenCodeGoCatalog().catch(() => {
    /* surfaced on next real lookup */
  })
}

/** Strip an `opencode-go/` config-style prefix; lowercase for lookups. */
export function normalizeOpenCodeGoModelId(id: string): string {
  return id.replace(/^opencode-go\//i, '').trim().toLowerCase()
}

/* -------------------------------------------------------------------------- */
/* Structural endpoint routing (protocol, not capability data)                 */
/* -------------------------------------------------------------------------- */

/**
 * Endpoints table from https://opencode.ai/docs/go/ (live 2026-09-11). Keep in
 * sync with the docs table, not with the live `/models` ids: the catalog lists
 * ids before they are routed, and a missed id silently sends the model to the
 * wrong mount where every run fails.
 */
const RESPONSES_MODELS = new Set([
  'grok-4.5',
  'grok-4.6',
  'gpt-5.6-luna',
  'muse-spark-1.2-contributor',
  'muse-spark-1.3-contributor'
])

const MESSAGES_MODELS = new Set([
  'minimax-m3',
  'minimax-m2.7',
  'minimax-m2.5',
  'qwen3.8-max',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus',
  'qwen3.5-plus'
])

/** Endpoint family for a model id — shared with reasoning/thinking wiring. */
export function opencodeGoTransportFor(modelId: string): OpenCodeTransport {
  const core = normalizeOpenCodeGoModelId(modelId)
  if (RESPONSES_MODELS.has(core)) return 'responses'
  if (MESSAGES_MODELS.has(core)) return 'messages'
  if (/^minimax-/.test(core) || /^qwen/.test(core)) return 'messages'
  return 'chat'
}

/** Thinking-effort vocabulary allowed by each transport's request normalizer. */
export function opencodeGoEffortsFor(
  transport: OpenCodeTransport
): NonNullable<ModelInfo['supportedThinkingEfforts']> {
  switch (transport) {
    case 'responses':
      return ['minimal', 'low', 'medium', 'high', 'xhigh']
    case 'messages':
      return ['low', 'medium', 'high', 'xhigh', 'max']
    case 'chat':
      return ['low', 'medium', 'high']
  }
}

/* -------------------------------------------------------------------------- */
/* Capability lookups (runtime catalog)                                        */
/* -------------------------------------------------------------------------- */

/** Resolve registry metadata for an OpenCode Go model (single model). */
export async function lookupOpenCodeGoModelMeta(
  modelId: string,
  opts?: { signal?: AbortSignal }
): Promise<OpenCodeModelMeta | undefined> {
  const state = await loadOpenCodeGoCatalog({ signal: opts?.signal })
  return state.meta.get(normalizeOpenCodeGoModelId(modelId))
}

/** Cached variant for synchronous hot paths; undefined until the catalog is warm. */
export function getCachedOpenCodeGoMeta(modelId: string): OpenCodeModelMeta | undefined {
  return catalogState?.meta.get(normalizeOpenCodeGoModelId(modelId))
}

/** Declared reasoning-effort ladder for a Go model, when the registry publishes one. */
export async function opencodeGoEffortLadderFor(
  modelId: string,
  opts?: { signal?: AbortSignal }
): Promise<readonly ThinkingEffort[] | undefined> {
  const meta = await lookupOpenCodeGoModelMeta(modelId, { signal: opts?.signal })
  return meta?.supportedThinkingEfforts
}

/** Cached variant for synchronous hot paths; undefined until the catalog is warm. */
export function getCachedOpenCodeGoEffortLadder(
  modelId: string
): readonly ThinkingEffort[] | undefined {
  return getCachedOpenCodeGoMeta(modelId)?.supportedThinkingEfforts
}

/** Cached variant for synchronous seed paths; `[]` until the catalog is warm. */
export function getCachedOpenCodeGoModelIds(): string[] {
  return catalogState ? [...catalogState.models.keys()] : []
}

/** All model ids the OpenCode Go registry currently publishes (no key needed). */
export async function listOpenCodeGoModelIds(
  opts?: { signal?: AbortSignal }
): Promise<string[]> {
  const state = await loadOpenCodeGoCatalog({ signal: opts?.signal })
  return [...state.models.keys()]
}

/**
 * Merge runtime registry metadata into a catalog/seed row when fields are
 * missing. Returns the input unchanged when no registry entry exists (so
 * unknown/live-only ids pass through without inventing capabilities).
 */
export function mergeOpenCodeGoMeta<T extends Partial<ModelInfo>>(model: T): T {
  const meta = getCachedOpenCodeGoMeta(model.id ?? '')
  if (!meta) return model
  return {
    ...model,
    contextWindow: model.contextWindow ?? (meta.contextWindow > 0 ? meta.contextWindow : undefined),
    maxOutputTokens:
      model.maxOutputTokens ?? (meta.maxOutputTokens > 0 ? meta.maxOutputTokens : undefined),
    inputModalities: [...meta.inputModalities]
  }
}

/**
 * Build a `ModelInfo` for an OpenCode Go model from the live registry. Returns
 * `undefined` if the registry has no entry (so callers can fall back to the
 * live `/v1/models` id without inventing capabilities).
 */
export async function openCodeGoModelInfoFromRegistry(
  modelId: string,
  transport: OpenCodeTransport,
  opts?: { signal?: AbortSignal }
): Promise<ModelInfo | undefined> {
  const core = normalizeOpenCodeGoModelId(modelId)
  const meta = await lookupOpenCodeGoModelMeta(core, { signal: opts?.signal })
  if (!meta) return undefined
  const ladder = meta.supportedThinkingEfforts
  const supportsThinking = ladder != null || meta.thinkingCanDisable === false
  if (!supportsThinking) return undefined
  return {
    id: core,
    displayName: core,
    contextWindow: meta.contextWindow > 0 ? meta.contextWindow : undefined,
    maxOutputTokens: meta.maxOutputTokens > 0 ? meta.maxOutputTokens : undefined,
    inputModalities: [...meta.inputModalities],
    outputModalities: ['text'],
    supportsTools: true,
    supportsVision: meta.inputModalities.includes('image'),
    supportsStructuredOutput: true,
    supportsThinking: true,
    thinkingApi:
      transport === 'responses'
        ? 'responses'
        : transport === 'messages'
          ? 'messages'
          : 'chat_completions',
    supportedThinkingEfforts: ladder ? [...ladder] : undefined,
    thinkingCanDisable: meta.thinkingCanDisable,
    thinkingMode: ladder ? 'effort' : 'adaptive'
  }
}

/* -------------------------------------------------------------------------- */
/* Effort clamping (logic, not capability data)                                */
/* -------------------------------------------------------------------------- */

/**
 * Clamp a requested effort onto a Go model's declared ladder. Preferred rungs
 * pass through; 'xhigh' requests the model's top tier (on ladders declaring
 * 'max', max IS that top); everything else follows the repo-wide preference
 * (medium → high → low → …). 'medium' lands on the ladder's positional middle
 * ('high' for the documented low/high/max GLM ladders) and below-floor requests
 * land on the floor without ever inventing an unlisted rung.
 */
export function clampEffortToOpenCodeGoLadder(
  effort: ThinkingEffort,
  ladder: readonly ThinkingEffort[]
): ThinkingEffort {
  if (ladder.includes(effort)) return effort
  if (effort === 'xhigh' && ladder.includes('max')) return 'max'
  const preference: readonly ThinkingEffort[] = [
    'medium',
    'high',
    'low',
    'minimal',
    'xhigh',
    'max'
  ]
  for (const rung of preference) {
    if (ladder.includes(rung)) return rung
  }
  return ladder[0]!
}

/** Weakest rung of a declared ladder — a Go model's thinking floor. */
export function opencodeGoFloorEffort(ladder: readonly ThinkingEffort[]): ThinkingEffort {
  return clampEffortToOpenCodeGoLadder('low', ladder)
}

// Warm the registry on import in any process (main or renderer). The catalog is a
// public, keyless models.dev endpoint; the in-memory cache is shared for the
// session, so this resolves seed/merge metadata without further network calls.
preloadOpenCodeGoCatalog()
