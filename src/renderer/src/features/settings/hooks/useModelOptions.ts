import { useEffect, useMemo, useState } from 'react'
import type { ModelInfo, ProviderIdAny } from '@shared/ipc'
import type { MenuOption } from '@renderer/lib/ui'

/** The provider's model list as main reports it, with each model's catalog fields. */
export function useModelList(
  provider: ProviderIdAny,
  baseUrl: string | undefined,
  reloadKey: unknown
): ModelInfo[] {
  const [models, setModels] = useState<ModelInfo[]>([])
  useEffect(() => {
    let cancelled = false
    const list = window.vyotiq?.listModels
    if (!list) return undefined
    void list({ provider, baseUrl, forceRefresh: false })
      .then((res) => {
        if (!cancelled) setModels(res.ok ? res.data.models : [])
      })
      .catch(() => {
        if (!cancelled) setModels([])
      })
    return () => {
      cancelled = true
    }
  }, [provider, baseUrl, reloadKey])
  return models
}

/** Menu options for a model list, with the model in use kept in it even when the list does not (yet) name it. */
export function modelMenuOptions(models: readonly ModelInfo[], current: string): MenuOption[] {
  const ids = models.map((m) => m.id)
  const all = ids.includes(current) || !current ? ids : [current, ...ids]
  return all.map((id) => ({ value: id, label: id }))
}

/**
 * The provider's model list as the composer's picker has it, with the model
 * in use kept in it even when the list does not (yet) name it.
 */
export function useModelOptions(
  provider: ProviderIdAny,
  baseUrl: string | undefined,
  current: string,
  reloadKey: unknown
): MenuOption[] {
  const models = useModelList(provider, baseUrl, reloadKey)
  return useMemo(() => modelMenuOptions(models, current), [models, current])
}
