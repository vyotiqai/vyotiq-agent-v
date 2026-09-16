import { PROVIDER_DEFAULTS, seedModelsFor, providerLabel } from '@shared/providers'
import type { ModelInfo, ProviderId } from '@shared/ipc'
import { modelSelectionKey, parseModelSelectionKey } from '@shared/domain/modelSelection'
import { inferSupportedServiceTiers } from '@shared/domain/serviceTier'

export type ModelFilterOpts = { hasWorkspace: boolean; hasImages: boolean; hasAudio?: boolean }

export type ModelPickerOption = {
  value: string
  label: string
  group?: string
  subProvider?: string
  meta?: ModelInfo
}

const OPENROUTER_PREFIX_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  mistral: 'Mistral',
  meta: 'Meta',
  'meta-llama': 'Meta',
  qwen: 'Qwen',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  'x-ai': 'xAI',
  arcee: 'Arcee AI',
  cohere: 'Cohere',
  perplexity: 'Perplexity',
  microsoft: 'Microsoft',
  nvidia: 'NVIDIA'
}

export function openRouterGroup(modelId: string): string {
  const prefix = modelId.split('/')[0]?.toLowerCase() ?? ''
  return OPENROUTER_PREFIX_LABELS[prefix] ?? capitalize(prefix.replace(/-/g, ' '))
}

export function openRouterSubProvider(modelId: string): string | undefined {
  if (!modelId.includes('/')) return undefined
  return modelId.split('/')[0]?.toLowerCase()
}

function capitalize(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function formatModelDisplayName(id: string, displayName?: string): string {
  const name = displayName ?? id
  if (id.includes('/') && name === id) {
    const part = id.slice(id.lastIndexOf('/') + 1)
    return part.replace(/-/g, ' ')
  }
  return name
}

/** Drop a leading "Provider: " when the logo/group already identifies the source. */
export function compactModelLabel(
  label: string,
  ...prefixes: Array<string | undefined>
): string {
  const m = /^([^:]+):\s+(.+)$/.exec(label)
  if (!m) return label
  const prefix = m[1]!.trim()
  const rest = m[2]!.trim()
  if (!rest) return label
  const hit = prefixes.some((p) => p && p.trim().toLowerCase() === prefix.toLowerCase())
  return hit ? rest : label
}

export function modelSupportsAudio(model: ModelInfo): boolean {
  return model.inputModalities.includes('audio')
}

export function modelSupportsVision(model: ModelInfo): boolean {
  return model.supportsVision || model.inputModalities.includes('image')
}

export function filterModelsForWorkspace<T extends ModelInfo>(
  models: T[],
  opts: ModelFilterOpts
): T[] {
  const { hasWorkspace, hasImages, hasAudio } = opts
  if (!hasWorkspace && !hasImages && !hasAudio) return models
  return models.filter((model) => {
    if (hasWorkspace && !model.supportsTools) return false
    if (hasImages && !modelSupportsVision(model)) return false
    if (hasAudio && !modelSupportsAudio(model)) return false
    return true
  })
}

/** Return a vision-capable model id when the current selection cannot accept images. */
export function pickVisionFallback(
  catalog: ModelInfo[],
  currentModel: string,
  filterOpts: ModelFilterOpts
): string | null {
  const currentOk = catalog.some((m) => m.id === currentModel && modelSupportsVision(m))
  if (currentOk) return null
  const filtered = filterModelsForWorkspace(catalog, { ...filterOpts, hasImages: true })
  return filtered[0]?.id ?? null
}

/** Return an audio-capable model id when the current selection cannot accept audio. */
export function pickAudioFallback(
  catalog: ModelInfo[],
  currentModel: string,
  filterOpts: ModelFilterOpts
): string | null {
  const currentOk = catalog.some((m) => m.id === currentModel && modelSupportsAudio(m))
  if (currentOk) return null
  const filtered = filterModelsForWorkspace(catalog, { ...filterOpts, hasAudio: true })
  return filtered[0]?.id ?? null
}

export function modelsToOptions(
  provider: ProviderId,
  models: ModelInfo[],
  providerLabel: string
): ModelPickerOption[] {
  return models.map((m) => {
    const group =
      provider === 'openrouter' && m.id.includes('/')
        ? openRouterGroup(m.id)
        : providerLabel
    return {
      value: modelSelectionKey(provider, m.id),
      label: compactModelLabel(
        formatModelDisplayName(m.id, m.displayName),
        providerLabel,
        group
      ),
      group,
      subProvider: openRouterSubProvider(m.id),
      meta: m
    }
  })
}

export function seedOptionsForProvider(provider: ProviderId): ModelPickerOption[] {
  const label = PROVIDER_DEFAULTS.find((p) => p.id === provider)?.label ?? provider
  return modelsToOptions(provider, seedModelsFor(provider), label)
}

export function buildModelMetaMap(
  optionsByProvider: Record<string, ModelPickerOption[]>
): Record<string, ModelInfo> {
  const map: Record<string, ModelInfo> = {}
  for (const opts of Object.values(optionsByProvider)) {
    for (const opt of opts) {
      if (opt.meta) map[opt.value] = opt.meta
    }
  }
  return map
}

/** Resolve a stored model key to a picker row, including cross-provider favorites/recent. */
export function resolvePickerOption(
  key: string,
  optionsByProvider: Record<ProviderId, ModelPickerOption[]>,
  modelMetaByValue: Record<string, ModelInfo>
): ModelPickerOption | undefined {
  const parsed = parseModelSelectionKey(key)
  if (!parsed) return undefined
  const found = optionsByProvider[parsed.provider]?.find((o) => o.value === key)
  if (found) return found
  const meta = modelMetaByValue[key]
  const group =
    parsed.provider === 'openrouter' && parsed.model.includes('/')
      ? openRouterGroup(parsed.model)
      : providerLabel(parsed.provider)
  const label = compactModelLabel(
    formatModelDisplayName(parsed.model, meta?.displayName),
    providerLabel(parsed.provider),
    group
  )
  return {
    value: key,
    label,
    group,
    subProvider: openRouterSubProvider(parsed.model),
    meta
  }
}

export function supportedTiersForModel(
  provider: ProviderId,
  modelId: string,
  meta?: ModelInfo
): import('@shared/ipc').ServiceTier[] {
  if (meta?.supportedServiceTiers?.length) return meta.supportedServiceTiers
  const tiers = inferSupportedServiceTiers(modelId, provider)
  return tiers.length > 0 ? tiers : []
}

/** True when the catalog fell back to static seed models (connection/key/empty live list). */
export function isSeedFallbackWarning(warning: string | null | undefined): boolean {
  if (!warning) return false
  return /seed defaults|not live models|not installed models/i.test(warning)
}

/**
 * Host is reachable but GET /models returns 405/501 (no catalog route).
 * Chat can still connect — placeholders stay out of the live list via
 * {@link isSeedFallbackWarning}, but send must not be blocked.
 */
export function isModelListUnsupportedWarning(warning: string | null | undefined): boolean {
  if (!warning) return false
  return (
    /does not serve a model list \(HTTP (?:405|501)\)/i.test(warning) &&
    /host is reachable/i.test(warning)
  )
}

/**
 * Live catalog rows for the model picker. Keep previous models while a refresh
 * is in flight — wiping here drops `modelMeta` and makes Think flicker.
 */
export function pickerModelsFromCatalogEntry(
  entry: { models: ModelInfo[] | null; warning: string | null; loading?: boolean } | undefined
): ModelInfo[] | null {
  if (!entry || isSeedFallbackWarning(entry.warning)) return null
  if (!entry.models?.length) return null
  return entry.models
}
