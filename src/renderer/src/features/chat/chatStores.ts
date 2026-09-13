import type { UiItem } from '@shared/transcript'
import type { ContextUsageState } from '@shared/utils/contextUsage'
import type { StepUsageTotals } from '@shared/utils/runTelemetry'

/** Items stream — ChatView must not subscribe; only TranscriptPane / git leaves. */
export type ChatItemsStore = {
  subscribeItems: (listener: () => void) => () => void
  getItemsRevision: () => number
  /**
   * Snapshot getter: must return the same array identity while the revision is
   * unchanged (chatStoresFor wraps controller.items). A fresh array per call
   * re-renders every identity-sensitive consumer forever — CI hung to heap OOM
   * on exactly that (chatView.errors regression, 2026-09-02).
   */
  getItems: () => UiItem[]
}

/**
 * Meta stream for meter / coarse flags. Snapshots must stay Object.is-stable
 * when the underlying value is unchanged (React useSyncExternalStore).
 */
export type ChatMetaStore = {
  subscribeMeta: (listener: () => void) => () => void
  getMetaRevision: () => number
  getContextUsage: () => ContextUsageState | null
  getTurnUsage?: () => readonly StepUsageTotals[]
  getCostHint?: () => string | null
}
