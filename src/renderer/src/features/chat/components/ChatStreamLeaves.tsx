import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import type { UiItem } from '@shared/transcript'
import { extractPartialEditArgs } from '@shared/utils/partialJson'
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

/** Tools whose target is a file the run is changing right now. */
const FOLLOW_WRITE_TOOLS = new Set(['edit', 'str_replace'])
/**
 * Only the tail of the transcript can hold the "current" file, and a bounded
 * scan keeps this O(1) per streamed patch on a long run.
 */
const FOLLOW_SCAN_WINDOW = 50

export type AgentFileFocus = {
  /** Path exactly as the tool reported it — the panel normalizes it. */
  path: string
  /** Bumps on every change so re-focusing the same file still fires. */
  token: number
}

/**
 * The file the run is currently writing, for the Files panel's follow mode.
 *
 * Writes only. Following reads would yank the editor across a dozen files in a
 * single turn, and the file that changed is the one worth looking at.
 */
export function useAgentFileFocus(
  running: boolean,
  items: UiItem[],
  itemsStore?: ChatItemsStore
): AgentFileFocus | null {
  const [focus, setFocus] = useState<AgentFileFocus | null>(null)
  const itemsRef = useRef(items)
  itemsRef.current = items
  const lastPathRef = useRef<string | null>(null)
  const tokenRef = useRef(0)
  const wasRunningRef = useRef(running)
  const fallbackItems = itemsStore ? null : items

  useEffect(() => {
    // A new run re-follows its first file even when that is where the last
    // run finished, so the panel is not silent on the edit that matters.
    if (!wasRunningRef.current && running) lastPathRef.current = null
    wasRunningRef.current = running
  }, [running])

  useEffect(() => {
    if (!running) return undefined
    const scan = (): void => {
      const list = itemsStore?.getItems() ?? itemsRef.current
      const stop = Math.max(0, list.length - FOLLOW_SCAN_WINDOW)
      let found: string | null = null
      for (let i = list.length - 1; i >= stop; i -= 1) {
        const item = list[i]
        if (!item || item.kind !== 'tool') continue
        if (!FOLLOW_WRITE_TOOLS.has(item.tool.name)) continue
        // Partial-JSON aware: a streaming edit names its path long before the
        // arguments finish arriving, which is exactly when following helps.
        const args = extractPartialEditArgs(item.tool.argsPreview)
        const fromArgs = typeof args?.path === 'string' ? args.path.trim() : ''
        found = fromArgs || item.tool.summary?.trim() || null
        break
      }
      if (!found || found === lastPathRef.current) return
      lastPathRef.current = found
      tokenRef.current += 1
      setFocus({ path: found, token: tokenRef.current })
    }
    scan()
    const unsubscribe = itemsStore?.subscribeItems(scan)
    return () => {
      unsubscribe?.()
    }
  }, [itemsStore, fallbackItems, running])

  return focus
}

/**
 * What the run is doing right now, for the side rail's live markers.
 *
 * Writes are the same set follow mode uses, so the marker and the Files panel
 * never disagree about what counts as editing a file.
 *
 * Only calls still in flight count. {@link useAgentFileFocus} deliberately
 * keeps the last file it saw so the Files panel stays parked on it; a rail
 * marker that did the same would keep pulsing long after the write landed, so
 * this reads `status === 'running'` and nothing else.
 *
 * Both strings come from the same bounded tail scan: a run only ever has a
 * handful of calls open, and they are all at the end of the transcript.
 */
export type AgentLiveActivity = {
  /**
   * Path of the file a write tool is applying right now. Null when no write is
   * open; empty while a call is in flight that has not named its file yet —
   * the work is real either way, only the label is missing.
   */
  writingPath: string | null
  /** Command a terminal call is running right now, as the transcript labels it. */
  command: string | null
  /** A `create_plan` call is writing the plan right now. */
  planning: boolean
}

const NO_ACTIVITY: AgentLiveActivity = { writingPath: null, command: null, planning: false }

export function useAgentLiveActivity(
  running: boolean,
  items: UiItem[],
  itemsStore?: ChatItemsStore
): AgentLiveActivity {
  const [activity, setActivity] = useState<AgentLiveActivity>(NO_ACTIVITY)
  const itemsRef = useRef(items)
  itemsRef.current = items
  const fallbackItems = itemsStore ? null : items

  useEffect(() => {
    if (!running) {
      // A finished run has nothing in flight; leaving the last frame up would
      // pulse the rail over a run that ended.
      setActivity((prev) => (prev === NO_ACTIVITY ? prev : NO_ACTIVITY))
      return undefined
    }
    const scan = (): void => {
      const list = itemsStore?.getItems() ?? itemsRef.current
      const stop = Math.max(0, list.length - FOLLOW_SCAN_WINDOW)
      let writingPath: string | null = null
      let command: string | null = null
      let planning = false
      for (let i = list.length - 1; i >= stop; i -= 1) {
        const item = list[i]
        if (!item || item.kind !== 'tool') continue
        const tool = item.tool
        if (tool.status !== 'running') continue
        if (tool.name === 'create_plan') {
          planning = true
        } else if (command === null && tool.name === 'terminal') {
          command = tool.summary?.trim() ?? ''
        } else if (writingPath === null && FOLLOW_WRITE_TOOLS.has(tool.name)) {
          // Partial-JSON aware for the same reason follow mode is: a streaming
          // edit names its path well before its arguments finish arriving.
          const args = extractPartialEditArgs(tool.argsPreview)
          const fromArgs = typeof args?.path === 'string' ? args.path.trim() : ''
          writingPath = fromArgs || (tool.summary?.trim() ?? '')
        }
        if (writingPath !== null && command !== null && planning) break
      }
      setActivity((prev) =>
        prev.writingPath === writingPath && prev.command === command && prev.planning === planning
          ? prev
          : writingPath === null && command === null && !planning
            ? NO_ACTIVITY
            : { writingPath, command, planning }
      )
    }
    scan()
    const unsubscribe = itemsStore?.subscribeItems(scan)
    return () => {
      unsubscribe?.()
    }
  }, [itemsStore, fallbackItems, running])

  return activity
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
