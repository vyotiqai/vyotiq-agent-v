import { useEffect, useMemo, useRef } from 'react'
import { listConfiguredProviders, providerLabel } from '@shared/providers'
import type { ProviderId, SecretProvider } from '@shared/ipc'
import { modelSelectionKey } from '@shared/domain/modelSelection'
import {
  filterModelsForWorkspace,
  modelsToOptions,
  seedOptionsForProvider,
  buildModelMetaMap,
  isSeedFallbackWarning,
  pickerModelsFromCatalogEntry,
  type ModelFilterOpts,
  type ModelPickerOption
} from './composerModelUtils'
import { useProviderCatalogCache, ollamaCatalogNeedsShow } from './useProviderCatalogCache'
import { findOllamaCatalogModel } from '@shared/reasoning'

export function useComposerModels({
  provider,
  model,
  ollamaBaseUrl,
  customOpenAiBaseUrl,
  modelsRefreshKey,
  hasWorkspace,
  hasImages,
  hasAudio = false,
  browsedProvider,
  secrets
}: {
  provider: ProviderId
  model: string
  ollamaBaseUrl?: string
  customOpenAiBaseUrl?: string
  modelsRefreshKey?: string | number
  hasWorkspace?: boolean
  hasImages: boolean
  hasAudio?: boolean
  browsedProvider?: ProviderId
  secrets: Record<SecretProvider, boolean>
}) {
  const value = modelSelectionKey(provider, model)
  const activeBrowse = browsedProvider ?? provider
  /** Browsed (non-active) providers: fetch once per tab open / refresh, not on every idle tick. */
  const browsedFetchedRef = useRef(new Set<ProviderId>())
  /** One `/api/show` enrich per selected Ollama id until catalog refresh. */
  const ollamaShowAttemptedRef = useRef<string | null>(null)

  const { cache, loadProvider, getEntry } = useProviderCatalogCache(
    { ollamaBaseUrl, customOpenAiBaseUrl },
    modelsRefreshKey
  )

  const filterOpts: ModelFilterOpts = useMemo(
    () => ({ hasWorkspace: Boolean(hasWorkspace), hasImages, hasAudio }),
    [hasWorkspace, hasImages, hasAudio]
  )

  const configuredProviders = useMemo(
    () =>
      listConfiguredProviders(secrets, {
        ollamaBaseUrl,
        customOpenAiBaseUrl,
        alwaysInclude: [provider]
      }),
    [secrets, ollamaBaseUrl, customOpenAiBaseUrl, provider]
  )

  useEffect(() => {
    browsedFetchedRef.current.clear()
    ollamaShowAttemptedRef.current = null
  }, [modelsRefreshKey])

  useEffect(() => {
    let cancelled = false
    let idleId: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    const start = (): void => {
      if (!cancelled) void loadProvider(provider, { model })
    }

    // Defer catalog network behind first paint — cold models:list was ~1.5s in the startup stampede.
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      idleId = window.requestIdleCallback(start, { timeout: 1500 })
    } else {
      timer = setTimeout(start, 0)
    }

    return () => {
      cancelled = true
      if (idleId != null && typeof window !== 'undefined' && 'cancelIdleCallback' in window) {
        window.cancelIdleCallback(idleId)
      }
      if (timer != null) clearTimeout(timer)
    }
  }, [provider, modelsRefreshKey, loadProvider])

  useEffect(() => {
    if (activeBrowse === provider) return
    if (browsedFetchedRef.current.has(activeBrowse)) return
    browsedFetchedRef.current.add(activeBrowse)
    void loadProvider(activeBrowse)
  }, [activeBrowse, provider, loadProvider])

  const activeEntry = getEntry(provider)
  const liveModels = activeEntry?.models ?? null
  const modelsWarning = activeEntry?.warning ?? null
  const liveCatalog =
    liveModels && liveModels.length > 0 && !isSeedFallbackWarning(modelsWarning)
      ? liveModels
      : null

  useEffect(() => {
    if (provider !== 'ollama' || !model) return
    if (!liveModels || activeEntry?.loading) return
    const meta = findOllamaCatalogModel(liveModels, model)
    if (!ollamaCatalogNeedsShow(meta)) return
    const attemptKey = `${provider}::${model}`
    if (ollamaShowAttemptedRef.current === attemptKey) return
    ollamaShowAttemptedRef.current = attemptKey
    void loadProvider(provider, { model })
  }, [provider, model, liveModels, activeEntry?.loading, loadProvider])

  const catalog = liveCatalog ?? []
  const filtered = filterModelsForWorkspace(catalog, filterOpts)

  const warningsByProvider = useMemo(() => {
    const map = {} as Partial<Record<ProviderId, string | null>>
    for (const id of configuredProviders) {
      map[id] = getEntry(id)?.warning ?? null
    }
    return map
  }, [cache, configuredProviders, getEntry])

  const optionsByProvider = useMemo(() => {
    const map = {} as Record<ProviderId, ModelPickerOption[]>
    for (const id of configuredProviders) {
      const label = providerLabel(id)
      const entry = getEntry(id)
      const live = pickerModelsFromCatalogEntry(entry)
      if (live) {
        const source = filterModelsForWorkspace(live, filterOpts)
        map[id] = modelsToOptions(id, source.length ? source : live, label)
      } else {
        map[id] = []
      }
    }
    return map
  }, [cache, filterOpts, getEntry, configuredProviders])

  const modelMetaByValue = useMemo(
    () => buildModelMetaMap(optionsByProvider),
    [optionsByProvider]
  )

  const seedsByProvider = useMemo(() => {
    const map = {} as Record<ProviderId, ModelPickerOption[]>
    for (const id of configuredProviders) {
      const warning = getEntry(id)?.warning ?? null
      if (isSeedFallbackWarning(warning)) {
        map[id] = []
      } else {
        map[id] = seedOptionsForProvider(id)
      }
    }
    return map
  }, [configuredProviders, cache, getEntry])

  const currentMeta = modelMetaByValue[value]

  const refreshCatalog = async (opts?: {
    forceRefresh?: boolean
    provider?: ProviderId
  }) => {
    const target = opts?.provider ?? activeBrowse
    if (opts?.forceRefresh) ollamaShowAttemptedRef.current = null
    const entry = await loadProvider(target, {
      forceRefresh: opts?.forceRefresh,
      model: target === provider ? model : undefined
    })
    return entry.models
      ? { ok: true as const, models: entry.models, warning: entry.warning }
      : { ok: false as const, error: entry.warning ?? 'Failed to load models' }
  }

  return {
    providers: configuredProviders,
    optionsByProvider,
    seedsByProvider,
    modelMetaByValue,
    value,
    provider,
    model,
    providerLabel: providerLabel(provider),
    modelsWarning,
    warningsByProvider,
    catalogLoading: Boolean(getEntry(activeBrowse)?.loading),
    catalog,
    filtered,
    filterOpts,
    currentMeta,
    refreshCatalog,
    loadProvider
  }
}
