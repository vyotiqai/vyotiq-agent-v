import { useCallback, useSyncExternalStore } from 'react'
import type { ChatMetaStore } from '../../chatStores'
import type { ContextUsageState } from './ContextMeter'

/**
 * The context meter's usage, read from the meta store when there is one so a
 * usage patch re-renders only the meter, never the whole composer.
 */
export function useResolvedContextUsage(
  metaStore: ChatMetaStore | undefined,
  usage: ContextUsageState | null | undefined
): ContextUsageState | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) => metaStore?.subscribeMeta(onStoreChange) ?? (() => {}),
    [metaStore]
  )
  const getRevision = useCallback(() => metaStore?.getMetaRevision() ?? 0, [metaStore])
  useSyncExternalStore(subscribe, getRevision, getRevision)
  return metaStore ? metaStore.getContextUsage() : (usage ?? null)
}

export function useResolvedCostHint(
  metaStore: ChatMetaStore | undefined,
  costHint: string | null | undefined
): string | null {
  const subscribe = metaStore?.subscribeMeta ?? (() => () => {})
  const getRevision = metaStore?.getMetaRevision ?? (() => 0)
  useSyncExternalStore(subscribe, getRevision, getRevision)
  if (metaStore?.getCostHint) return metaStore.getCostHint()
  return costHint ?? null
}
