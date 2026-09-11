import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import type { UiItem } from '@shared/transcript'
import type { StepUsageTotals } from '@shared/utils/runTelemetry'
import type { ChatItemsStore, ChatMetaStore } from '../chatStores'
import type { ChatStreamController } from '@renderer/lib/hooks/createChatStreamController'

/** Bumps on workspace change, run end, and (debounced) mid-run mutating tool results. */
const MUTATING_GIT_TOOLS = new Set([
  'edit',
  'str_replace',
  'delete',
  'terminal',
  'memory_write',
  'git_commit'
])

export function useGitRevision(
  workspacePath: string | null,
  running: boolean,
  items: UiItem[],
  itemsStore?: ChatItemsStore
): [number, () => void] {
  const [revision, setRevision] = useState(0)
  const bump = useCallback(() => {
    setRevision((value) => value + 1)
  }, [])
  const wasRunning = useRef(running)
  const mutatingDoneCount = useRef(0)
  /** Skip the mount bump — useGitStatus already fetches once for the initial path. */
  const prevPathRef = useRef<string | null | undefined>(undefined)
  const itemsRef = useRef(items)
  itemsRef.current = items
  /**
   * With a store, subscription drives rescans — including `items` in the deps
   * tore the effect down and re-scanned on every streamed patch. Without a
   * store, the prop is the only signal, so it stays a dependency there. Null
   * here is a stable value, never a per-render fresh array.
   */
  const fallbackItems = itemsStore ? null : items

  useEffect(() => {
    if (wasRunning.current && !running) setRevision((value) => value + 1)
    if (!wasRunning.current && running) mutatingDoneCount.current = 0
    wasRunning.current = running
  }, [running])

  useEffect(() => {
    if (prevPathRef.current === undefined) {
      prevPathRef.current = workspacePath
      return
    }
    if (prevPathRef.current === workspacePath) return
    prevPathRef.current = workspacePath
    setRevision((value) => value + 1)
  }, [workspacePath])

  useEffect(() => {
    if (!running) return
    let timer: number | undefined
    const scan = (): void => {
      const list = itemsStore?.getItems() ?? itemsRef.current
      let count = 0
      for (const item of list) {
        if (item.kind !== 'tool') continue
        if (item.tool.status !== 'done' && item.tool.status !== 'fail') continue
        if (MUTATING_GIT_TOOLS.has(item.tool.name)) count++
      }
      if (count <= mutatingDoneCount.current) return
      mutatingDoneCount.current = count
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        setRevision((value) => value + 1)
      }, 400)
    }
    scan()
    const unsubscribe = itemsStore?.subscribeItems(scan)
    return () => {
      unsubscribe?.()
      if (timer != null) window.clearTimeout(timer)
    }
  }, [itemsStore, fallbackItems, running])

  return [revision, bump]
}

function useLiveItems(
  itemsStore: ChatItemsStore | undefined,
  items: UiItem[],
  enabled = true
): UiItem[] {
  const subscribeItems = itemsStore?.subscribeItems
  const getItemsRevision = itemsStore?.getItemsRevision
  const getItems = itemsStore?.getItems
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      enabled ? (subscribeItems?.(onStoreChange) ?? (() => {})) : () => {},
    [subscribeItems, enabled]
  )
  const getRevision = useCallback(
    () => (enabled ? (getItemsRevision?.() ?? 0) : 0),
    [getItemsRevision, enabled]
  )
  useSyncExternalStore(subscribe, getRevision, getRevision)
  return enabled && getItems ? getItems() : items
}

/**
 * Boolean-only run_error presence — Object.is-stable across stream deltas so
 * ChatView / Composer skip re-renders while the transcript grows.
 */
export function useHasTranscriptRunError(
  itemsStore: ChatItemsStore | undefined,
  items: UiItem[]
): boolean {
  const itemsRef = useRef(items)
  itemsRef.current = items
  const subscribeItems = itemsStore?.subscribeItems
  const getItems = itemsStore?.getItems
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeItems?.(onStoreChange) ?? (() => {}),
    [subscribeItems]
  )
  const getSnapshot = useCallback((): boolean => {
    const list = getItems ? getItems() : itemsRef.current
    return list.some((item) => item.kind === 'run_error')
  }, [getItems])
  const fromStore = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return getItems ? fromStore : items.some((item) => item.kind === 'run_error')
}

/**
 * Boolean-only items presence — Object.is-stable across pure stream deltas so
 * ChatView / Composer skip re-renders while the transcript grows.
 */
export function useHasChatItems(
  itemsStore: ChatItemsStore | undefined,
  items: UiItem[]
): boolean {
  const itemsRef = useRef(items)
  itemsRef.current = items
  const subscribeItems = itemsStore?.subscribeItems
  const getItems = itemsStore?.getItems
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeItems?.(onStoreChange) ?? (() => {}),
    [subscribeItems]
  )
  const getSnapshot = useCallback((): boolean => {
    if (getItems) return getItems().length > 0
    return itemsRef.current.length > 0
  }, [getItems])
  const fromStore = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return getItems ? fromStore : items.length > 0
}

export function useChatLiveItems(
  itemsStore: ChatItemsStore | undefined,
  items: UiItem[],
  enabled = true
): UiItem[] {
  return useLiveItems(itemsStore, items, enabled)
}

/** Turn receipts — subscribe on the transcript leaf, not ChatView. */
export function useResolvedTurnUsage(
  metaStore: ChatMetaStore | undefined,
  turnUsage: readonly StepUsageTotals[] | undefined
): readonly StepUsageTotals[] | undefined {
  const subscribeMeta = metaStore?.subscribeMeta
  const getMetaRevision = metaStore?.getMetaRevision
  const getTurnUsage = metaStore?.getTurnUsage
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeMeta?.(onStoreChange) ?? (() => {}),
    [subscribeMeta]
  )
  const getRevision = useCallback(() => getMetaRevision?.() ?? 0, [getMetaRevision])
  useSyncExternalStore(subscribe, getRevision, getRevision)
  if (getTurnUsage) return getTurnUsage()
  return turnUsage
}

/**
 * Write-checkpoint leaf for a run controller (e.g. an instance pane's run whose
 * checkpoint never flows through the workspace parent). Subscribes to the meta
 * stream but re-renders only when the checkpoint object identity changes —
 * token/message patches bump the meta revision without touching it.
 */
export function useControllerWriteCheckpoint(
  controller: ChatStreamController | null | undefined
): ChatStreamController['writeCheckpoint'] {
  const [value, setValue] = useState(() => controller?.writeCheckpoint ?? null)
  const valueRef = useRef(value)
  valueRef.current = value
  useEffect(() => {
    if (!controller) return
    const sync = (): void => {
      const next = controller.writeCheckpoint
      if (next !== valueRef.current) setValue(next)
    }
    sync()
    return controller.subscribeMeta(sync)
  }, [controller])
  return value
}
