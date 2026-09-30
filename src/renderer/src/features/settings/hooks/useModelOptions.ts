import { useEffect, useMemo, useState } from 'react'
import type { ProviderIdAny } from '@shared/ipc'
import type { MenuOption } from '@renderer/lib/ui'

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
  const [ids, setIds] = useState<string[]>([])
  useEffect(() => {
    let cancelled = false
    const list = window.vyotiq?.listModels
    if (!list) return undefined
    void list({ provider, baseUrl, forceRefresh: false })
      .then((res) => {
        if (!cancelled) setIds(res.ok ? res.data.models.map((m) => m.id) : [])
      })
      .catch(() => {
        if (!cancelled) setIds([])
      })
    return () => {
      cancelled = true
    }
  }, [provider, baseUrl, reloadKey])
  return useMemo(() => {
    const all = ids.includes(current) || !current ? ids : [current, ...ids]
    return all.map((id) => ({ value: id, label: id }))
  }, [ids, current])
}
