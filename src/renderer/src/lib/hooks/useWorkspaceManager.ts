import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type {
  AgentEvent,
  AgentInteractionMode,
  PersistedEvent,
  RunSummary,
  ToolApprovalRequest,
  ToolApprovalDecision,
  AgentQuestionRequest,
  ProviderId,
  WorkspaceSettingsOverride,
  WorkspaceUiState,
  WorkspacesState
} from '@shared/ipc'
import type { UiAgentQuestionAnswer } from '@shared/transcript'
import { toLogErr } from '@shared/errors'
import { isResumableInterruptedRun } from '@shared/runInterrupt'
import { logger } from '@shared/logger'
import { workspacePathsEqual, findByWorkspacePath } from '@shared/workspacePathMatch'
import {
  createChatStreamController,
  EMPTY_RUN_EXPANSIONS,
  type ChatStreamController,
  type RunExpansions
} from './createChatStreamController'
import { ensureChatUiPerfDump } from './chatUiPerf'
import {
  clearWorkspaceHotUi,
  clearWorkspaceHotComposerDraft,
  getWorkspaceHotUi,
  hasWorkspaceHotUi,
  resolveHotComposerDraft,
  seedWorkspaceHotUi,
  setWorkspaceHotComposerDraft,
  setWorkspaceHotUi
} from './workspaceHotUiStore'
import {
  clearComposerAttachments,
  clearComposerAttachmentsForWorkspace,
  composerAttachmentKey,
  flushComposerAttachmentsToDisk,
  seedComposerAttachmentsFromDisk
} from './composerAttachmentStore'
import { pushToast } from '@renderer/lib/ui'
import { focusComposerMessage } from '@renderer/lib/shortcuts'

import {
  backgroundRunFinishedMessage,
  finishedBackgroundRuns,
  shouldShowBackgroundRunToast
} from '@renderer/lib/chat/backgroundRunToast'
import type { ChatPane, ChatPaneLayout, PaneDropZone, SessionDragPayload } from '@renderer/lib/chat/chatPaneLayout'
import {
  applyPaneDrop,
  closePane as closePaneInLayout,
  createPaneId,
  focusPane,
  insertDraftPaneBeside,
  loadPaneLayoutFromStorage,
  maxPaneCount,
  openRunInFocusedPane,
  removeSessionFromLayout,
  replaceFocusedPaneSession,
  sanitizePaneLayout,
  savePaneLayoutToStorage,
  setPaneSizes,
  singlePaneLayout,
  syncSinglePaneSession,
  visibleRunIds
} from '@renderer/lib/chat/chatPaneLayout'
import {
  paneCapacityReservedPx
} from '@renderer/lib/utils/layout'

export type PaneCapacityContext = {
  dockOpen: boolean
  dockWidthPx: number
}

const ACTIVE_RUNS_POLL_MS = 5_000
const ACTIVE_RUNS_WARN_INTERVAL_MS = 60_000
const INTERRUPTED_RUNS_TOAST_KEY = 'vyotiq:interrupted-runs-toast'

/**
 * Renderer boot epoch, regenerated on every module load (reload, crash
 * recovery). Main pairs it with writeGeneration to re-seed the stale-write
 * guard after a reload instead of dropping every UI-state write.
 */
const UI_WRITE_EPOCH = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/** Rehydrate ask_question cards after remount while main is still waiting. */
async function restorePendingQuestions(
  controller: ChatStreamController,
  runId: string
): Promise<void> {
  if (!window.vyotiq?.listPendingAgentQuestions) return
  const res = await window.vyotiq.listPendingAgentQuestions(runId)
  if (!res.ok) return
  for (const request of res.data) {
    controller.handleQuestionRequest(request)
  }
}

/** Rehydrate tool-approval cards after remount while main is still waiting. */
async function restorePendingApprovals(
  controller: ChatStreamController,
  runId: string
): Promise<void> {
  if (!window.vyotiq?.listPendingToolApprovals) return
  const res = await window.vyotiq.listPendingToolApprovals(runId)
  if (!res.ok) return
  for (const request of res.data) {
    controller.handleApprovalRequest(request)
  }
}

/**
 * Stable per-controller external-store accessors. Snapshots are rebuilt every
 * render, but these bound methods must keep a stable identity so
 * useSyncExternalStore consumers do not resubscribe on every render.
 */
type ChatStoreBundle = Pick<
  ChatStreamController,
  'subscribeItems' | 'getItemsRevision' | 'subscribeMeta' | 'getMetaRevision'
> & {
  getItems: () => ChatStreamController['items']
  getContextUsage: () => ChatStreamController['contextUsage']
  getTurnUsage: () => ChatStreamController['turnUsage']
  getCostHint: () => ChatStreamController['costHint']
  itemsStore: {
    subscribeItems: (listener: () => void) => () => void
    getItemsRevision: () => number
    getItems: () => ChatStreamController['items']
  }
  metaStore: {
    subscribeMeta: (listener: () => void) => () => void
    getMetaRevision: () => number
    getContextUsage: () => ChatStreamController['contextUsage']
    getTurnUsage: () => ChatStreamController['turnUsage']
    getCostHint: () => string | null
  }
}

const chatStoreBundles = new WeakMap<ChatStreamController, ChatStoreBundle>()

/** Stable no-op stores for the no-active-controller snapshot. */
const EMPTY_CHAT_STORE: ChatStoreBundle = {
  subscribeItems: () => () => {},
  getItemsRevision: () => 0,
  getItems: () => [] as ChatStreamController['items'],
  subscribeMeta: () => () => {},
  getMetaRevision: () => 0,
  getContextUsage: () => null,
  getTurnUsage: () => [] as ChatStreamController['turnUsage'],
  getCostHint: () => null,
  itemsStore: {
    subscribeItems: () => () => {},
    getItemsRevision: () => 0,
    getItems: () => [] as ChatStreamController['items']
  },
  metaStore: {
    subscribeMeta: () => () => {},
    getMetaRevision: () => 0,
    getContextUsage: () => null,
    getTurnUsage: () => [] as ChatStreamController['turnUsage'],
    getCostHint: () => null
  }
}

function chatStoresFor(controller: ChatStreamController): ChatStoreBundle {
  let bundle = chatStoreBundles.get(controller)
  if (!bundle) {
    const subscribeItems = controller.subscribeItems.bind(controller)
    const getItemsRevision = controller.getItemsRevision.bind(controller)
    const getItems = (): ChatStreamController['items'] => controller.items
    const subscribeMeta = controller.subscribeMeta.bind(controller)
    const getMetaRevision = controller.getMetaRevision.bind(controller)
    const getContextUsage = controller.getContextUsage.bind(controller)
    const getTurnUsage = controller.getTurnUsage.bind(controller)
    const getCostHint = controller.getCostHint.bind(controller)
    bundle = {
      subscribeItems,
      getItemsRevision,
      getItems,
      subscribeMeta,
      getMetaRevision,
      getContextUsage,
      getTurnUsage,
      getCostHint,
      itemsStore: { subscribeItems, getItemsRevision, getItems },
      metaStore: {
        subscribeMeta,
        getMetaRevision,
        getContextUsage,
        getTurnUsage,
        getCostHint
      }
    }
    chatStoreBundles.set(controller, bundle)
  }
  return bundle
}

const ORPHAN_SYNC_DEBOUNCE_MS = 600
const OPEN_RUN_TAB_LIMIT = 4
/** Cap orphan IPC buffers for runIds not yet mapped to a controller. */
const ORPHAN_EVENT_BUFFER_MAX = 128
const ORPHAN_APPROVAL_BUFFER_MAX = 16
const ORPHAN_QUESTION_BUFFER_MAX = 16
/** Prefer coalescing same-type usage under orphan backpressure instead of dropping. */
const ORPHAN_USAGE_TYPES = new Set<AgentEvent['type']>(['step_usage', 'context_usage'])

const ORPHAN_DELTA_TYPES = new Set<AgentEvent['type']>(['text_delta', 'thinking_delta'])
/** Never FIFO-drop these under backpressure while a non-critical remains (or incoming). */
const ORPHAN_CRITICAL_TYPES = new Set<AgentEvent['type']>([
  'tool_start',
  'tool_result',
  'tool_call_delta',
  'assistant_message',
  'thinking_done',
  'follow_up_queued',
  'follow_up_applied',
  'follow_up_dropped',
  'terminal_output_delta',
  'stream_reset',
  'status',
  'writes_checkpoint',
  'incomplete',
  'error',
  'tool_progress',
  'agent_instance_update',
  'compaction_started',
  'compaction_verifying',
  'compaction_verify_retry',
  'compaction_verify_failed',
  'compaction',
  'mode_changed',
  'goal_update',
  'loop_update'
])
const UI_PERSIST_DEBOUNCE_MS = 300
const LIST_RUNS_DEBOUNCE_MS = 300

/**
 * Under orphan backpressure, drop an older usage event only when a later
 * same-type usage remains (latest meter wins). Never sacrifice the sole meter.
 */
function coalesceOldestOrphanUsage(buffered: AgentEvent[]): boolean {
  const dropIdx = buffered.findIndex((ev) => ORPHAN_USAGE_TYPES.has(ev.type))
  if (dropIdx < 0) return false
  const victim = buffered[dropIdx]!
  for (let i = dropIdx + 1; i < buffered.length; i++) {
    if (buffered[i]!.type === victim.type) {
      buffered.splice(dropIdx, 1)
      return true
    }
  }
  return false
}

/**
 * Under orphan backpressure, fold oldest tool_call_delta into a later delta for
 * the same toolCallId (arguments concatenate like the live stream path).
 */
function coalesceOldestOrphanToolCallDelta(buffered: AgentEvent[]): boolean {
  const dropIdx = buffered.findIndex((ev) => ev.type === 'tool_call_delta')
  if (dropIdx < 0) return false
  const victim = buffered[dropIdx]!
  if (victim.type !== 'tool_call_delta') return false
  for (let i = dropIdx + 1; i < buffered.length; i++) {
    const next = buffered[i]!
    if (next.type !== 'tool_call_delta') continue
    if (next.toolCallId !== victim.toolCallId) continue
    buffered[i] = {
      ...next,
      argumentsDelta: victim.argumentsDelta + next.argumentsDelta,
      ...(victim.name && !next.name ? { name: victim.name } : {})
    }
    buffered.splice(dropIdx, 1)
    return true
  }
  return false
}

/**
 * Under orphan backpressure, fold the oldest stream delta into a later same-type
 * delta so token text is preserved instead of discarded.
 */
function coalesceOldestOrphanDelta(buffered: AgentEvent[]): boolean {
  const dropIdx = buffered.findIndex((ev) => ORPHAN_DELTA_TYPES.has(ev.type))
  if (dropIdx < 0) return false
  const victim = buffered[dropIdx]!
  for (let i = dropIdx + 1; i < buffered.length; i++) {
    const next = buffered[i]!
    if (next.type !== victim.type) continue
    if (victim.type === 'text_delta' && next.type === 'text_delta') {
      buffered[i] = { ...next, text: victim.text + next.text }
      buffered.splice(dropIdx, 1)
      return true
    }
    if (victim.type === 'thinking_delta' && next.type === 'thinking_delta') {
      if (
        victim.step !== undefined &&
        next.step !== undefined &&
        victim.step !== next.step
      ) {
        continue
      }
      buffered[i] = { ...next, text: victim.text + next.text }
      buffered.splice(dropIdx, 1)
      return true
    }
  }
  return false
}

/** @internal Exported for tests. */
export const WORKSPACE_MANAGER_LIMITS = {
  OPEN_RUN_TAB_LIMIT,
  ORPHAN_EVENT_BUFFER_MAX,
  ORPHAN_APPROVAL_BUFFER_MAX,
  ORPHAN_QUESTION_BUFFER_MAX
} as const

export type WorkspaceUiSlice = {
  scrollTop: number
  scrollTopByRunId: Record<string, number>
  composerDraft: string
  composerDraftByRunId: Record<string, string>
  agentMode: AgentInteractionMode
  /** Teammate profile bound per chat bucket (runId or draft key). */
  agentProfileIdByRunId: Record<string, string>
  /** Whether this workspace's group is expanded in the sidebar (undefined = default). */
  expanded?: boolean
  /** Persisted per-run card expansion state (tool/group/thinking, collapsed turns). */
  expansionsByRunId: Record<string, RunExpansions>
}

const DRAFT_SCROLL_KEY = '__draft__'

function scrollKeyForRun(runId: string | null): string {
  return runId ?? DRAFT_SCROLL_KEY
}

function draftKeyForRun(runId: string | null): string {
  return runId ?? DRAFT_SCROLL_KEY
}

/** @internal */
export function resolveComposerDraft(
  ui: Pick<WorkspaceUiSlice, 'composerDraft' | 'composerDraftByRunId'>,
  runId: string | null
): string {
  const key = draftKeyForRun(runId)
  if (key in ui.composerDraftByRunId) return ui.composerDraftByRunId[key] ?? ''
  if (!runId) return ui.composerDraft
  // Pre-per-run persistence: single composerDraft + empty map while a run is active.
  if (ui.composerDraft && Object.keys(ui.composerDraftByRunId).length === 0) {
    return ui.composerDraft
  }
  return ''
}

/** @internal — drop one run's draft entry (identity-stable when absent). */
export function omitRunComposerDraft(
  composerDraftByRunId: Record<string, string>,
  runId: string
): Record<string, string> {
  if (!(runId in composerDraftByRunId)) return composerDraftByRunId
  const { [runId]: _removed, ...rest } = composerDraftByRunId
  return rest
}

/**
 * Copy legacy workspace `composerDraft` into the per-run map when upgrading old UI state.
 * @internal
 */
export function migrateLegacyComposerDraftMap(
  ui: Pick<WorkspaceUiSlice, 'composerDraft' | 'composerDraftByRunId'>,
  activeRunId: string | null
): Record<string, string> {
  const map = { ...ui.composerDraftByRunId }
  if (!ui.composerDraft) return map
  if (!(DRAFT_SCROLL_KEY in map)) {
    map[DRAFT_SCROLL_KEY] = ui.composerDraft
  }
  if (
    activeRunId &&
    !(activeRunId in map) &&
    Object.keys(ui.composerDraftByRunId).length === 0
  ) {
    map[activeRunId] = ui.composerDraft
  }
  return map
}

/** Keep scroll entries for open tabs and active run; draft only while drafting. @internal */
export function pruneScrollTopByRunId(
  scrollTopByRunId: Record<string, number>,
  keep: { openRunIds: string[]; activeRunId: string | null }
): Record<string, number> {
  const allowed = new Set<string>([...keep.openRunIds])
  if (keep.activeRunId) allowed.add(keep.activeRunId)
  else allowed.add(DRAFT_SCROLL_KEY)
  const next: Record<string, number> = {}
  for (const [key, value] of Object.entries(scrollTopByRunId)) {
    if (allowed.has(key)) next[key] = value
  }
  return next
}

/** Remove one deleted run's scroll entry. @internal */
export function omitRunScrollTop(
  scrollTopByRunId: Record<string, number>,
  runId: string
): Record<string, number> {
  if (!(runId in scrollTopByRunId)) return scrollTopByRunId
  const { [runId]: _removed, ...rest } = scrollTopByRunId
  return rest
}

/** Drop open tabs / active run that no longer exist on disk. @internal */
export function reconcileOpenRunIds(
  openRunIds: string[],
  activeRunId: string | null,
  runIdsOnDisk: string[],
  previouslyKnownRunIds: string[]
): { openRunIds: string[]; activeRunId: string | null; changed: boolean } {
  const existing = new Set(runIdsOnDisk)
  const stale = new Set(previouslyKnownRunIds.filter((id) => !existing.has(id)))
  if (stale.size === 0) {
    return { openRunIds, activeRunId, changed: false }
  }
  const pruned = openRunIds.filter((id) => !stale.has(id))
  let nextActive = activeRunId
  if (nextActive && stale.has(nextActive)) {
    nextActive = pruned[pruned.length - 1] ?? null
  }
  if (nextActive && !pruned.includes(nextActive)) {
    pruned.push(nextActive)
  }
  const changed =
    pruned.length !== openRunIds.length ||
    pruned.some((id, i) => id !== openRunIds[i]) ||
    nextActive !== activeRunId
  return { openRunIds: pruned, activeRunId: nextActive, changed }
}

export type WorkspaceContext = {
  path: string
  runs: RunSummary[]
  /** Inline agent instances nested under parent chats in the sidebar. */
  instanceRuns: RunSummary[]
  /** Older pages loaded on demand beyond the sidebar cap (deduped against `runs`). */
  olderRuns: RunSummary[]
  runsCapped: boolean
  runsError: string | null
  /** False until the first listRuns settles — drives the sidebar skeleton. */
  runsLoaded: boolean
  activeRunId: string | null
  openRunIds: string[]
  backgroundRunIds: Set<string>
  sessionQuery: string
  ui: WorkspaceUiSlice
  settingsOverride: WorkspaceSettingsOverride | null
}

function defaultUiState(): WorkspaceUiState {
  return {
    activeRunId: null,
    openRunIds: [],
    scrollTop: 0,
    scrollTopByRunId: {},
    composerDraft: '',
    composerDraftByRunId: {},
    agentMode: 'agent',
    agentProfileIdByRunId: {},
    expansionsByRunId: {}
  }
}

function draftControllerKey(workspacePath: string): string {
  return `__draft__:${workspacePath}`
}

function uiStateFromContext(ctx: WorkspaceContext): WorkspaceUiState {
  const scrollTop =
    ctx.ui.scrollTopByRunId[scrollKeyForRun(ctx.activeRunId)] ?? ctx.ui.scrollTop
  return {
    activeRunId: ctx.activeRunId,
    openRunIds: [...ctx.openRunIds],
    scrollTop,
    scrollTopByRunId: pruneScrollTopByRunId(ctx.ui.scrollTopByRunId, {
      openRunIds: ctx.openRunIds,
      activeRunId: ctx.activeRunId
    }),
    composerDraft: ctx.ui.composerDraft,
    composerDraftByRunId: { ...ctx.ui.composerDraftByRunId },
    agentMode: ctx.ui.agentMode,
    agentProfileIdByRunId: { ...ctx.ui.agentProfileIdByRunId },
    expanded: ctx.ui.expanded,
    expansionsByRunId: pruneExpansionsByRunId(ctx.ui.expansionsByRunId, {
      openRunIds: ctx.openRunIds,
      activeRunId: ctx.activeRunId
    })
  }
}

/** Keep persisted expansion state bounded to open (or recently open) runs. */
function pruneExpansionsByRunId(
  expansions: Record<string, RunExpansions>,
  opts: { openRunIds: string[]; activeRunId: string | null }
): Record<string, RunExpansions> {
  const keep = new Set([...opts.openRunIds, ...(opts.activeRunId ? [opts.activeRunId] : [])])
  const out: Record<string, RunExpansions> = {}
  for (const [runId, value] of Object.entries(expansions)) {
    if (keep.has(runId)) out[runId] = value
  }
  return out
}

function contextFromRegistry(path: string, registry: WorkspacesState): WorkspaceContext {
  const ui = registry.uiStateByPath[path] ?? defaultUiState()
  let scrollTopByRunId = { ...(ui.scrollTopByRunId ?? {}) }
  if (ui.scrollTop > 0 && ui.activeRunId && scrollTopByRunId[ui.activeRunId] === undefined) {
    scrollTopByRunId[ui.activeRunId] = ui.scrollTop
  } else if (ui.scrollTop > 0 && !ui.activeRunId && scrollTopByRunId[DRAFT_SCROLL_KEY] === undefined) {
    scrollTopByRunId[DRAFT_SCROLL_KEY] = ui.scrollTop
  }
  scrollTopByRunId = pruneScrollTopByRunId(scrollTopByRunId, {
    openRunIds: ui.openRunIds ?? [],
    activeRunId: ui.activeRunId ?? null
  })
  return {
    path,
    runs: [],
    instanceRuns: [],
    olderRuns: [],
    runsCapped: false,
    runsError: null,
    runsLoaded: false,
    activeRunId: ui.activeRunId,
    openRunIds: [...ui.openRunIds],
    backgroundRunIds: new Set(),
    sessionQuery: '',
    ui: {
      scrollTop: ui.scrollTop,
      scrollTopByRunId,
      composerDraft: ui.composerDraft,
      composerDraftByRunId: { ...(ui.composerDraftByRunId ?? {}) },
      agentMode: ui.agentMode ?? 'agent',
      agentProfileIdByRunId: { ...(ui.agentProfileIdByRunId ?? {}) },
      expanded: ui.expanded,
      expansionsByRunId: { ...(ui.expansionsByRunId ?? {}) }
    },
    settingsOverride:
      findSettingsOverride(registry.settingsOverridesByPath, path) ?? null
  }
}

function findSettingsOverride(
  overrides: WorkspacesState['settingsOverridesByPath'],
  path: string
): WorkspaceSettingsOverride | null {
  return findByWorkspacePath(overrides, path)
}

export function useWorkspaceManager(options?: {
  /** Inline instance panes currently mounted (any split pane, not only the focused one). */
  openInstanceRunIds?: readonly string[]
  /** Effective provider/model for a workspace — the default until a session pins its own. */
  getDefaultProviderModelForWorkspace?: (
    workspacePath: string
  ) => { provider: ProviderId; model: string } | null
  /** Teammate model pin lookup — seeds a session's provider/model from its bound profile. */
  getAgentProfileModelPin?: (profileId: string) => { provider: ProviderId; model: string } | null
  getValidAgentProfileIds?: () => ReadonlySet<string> | null
  /** Settings `maxChatPanes`: 0 = auto (viewport-derived), 1–6 = fixed limit. */
  maxChatPanes?: number
}) {
  const openInstanceRunIdsRef = useRef<readonly string[]>(options?.openInstanceRunIds ?? [])
  openInstanceRunIdsRef.current = options?.openInstanceRunIds ?? []
  const getDefaultProviderModelRef = useRef(options?.getDefaultProviderModelForWorkspace)
  getDefaultProviderModelRef.current = options?.getDefaultProviderModelForWorkspace
  const getAgentProfileModelPinRef = useRef(options?.getAgentProfileModelPin)
  getAgentProfileModelPinRef.current = options?.getAgentProfileModelPin
  const getValidAgentProfileIdsRef = useRef(options?.getValidAgentProfileIds)
  getValidAgentProfileIdsRef.current = options?.getValidAgentProfileIds
  const maxChatPanesRef = useRef(options?.maxChatPanes ?? 0)
  maxChatPanesRef.current = options?.maxChatPanes ?? 0
  const [registry, setRegistry] = useState<WorkspacesState | null>(null)
  const [contexts, setContexts] = useState<Record<string, WorkspaceContext>>({})
  const [activeRuns, setActiveRuns] = useState<{ runId: string; workspacePath: string }[]>([])
  const [revision, setRevision] = useState(0)
  const [scrollRestoreToken, setScrollRestoreToken] = useState(0)
  const [chatSurfaceEpoch, setChatSurfaceEpoch] = useState(0)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [paneLayout, setPaneLayout] = useState<ChatPaneLayout | null>(null)

  const controllersRef = useRef(new Map<string, ChatStreamController>())
  const autoResumeAttemptedRef = useRef(new Set<string>())
  const autoResumeQueueRef = useRef<Array<() => Promise<void>>>([])
  const autoResumeDrainingRef = useRef(false)
  const paneLayoutRef = useRef<ChatPaneLayout | null>(null)
  const paneLayoutHydratedRef = useRef(false)
  /** Pane sessions whose transcript load failed; retried on layout commits. */
  const paneLoadRetryRef = useRef(new Set<string>())
  const paneCapacityContextRef = useRef<PaneCapacityContext>({
    dockOpen: false,
    dockWidthPx: 0
  })
  const contextsRef = useRef(contexts)
  const registryRef = useRef(registry)
  const persistTimersRef = useRef(new Map<string, number>())
  const uiWriteGenerationRef = useRef(new Map<string, number>())
  const eventBufferRef = useRef(new Map<string, AgentEvent[]>())
  const approvalBufferRef = useRef(new Map<string, ToolApprovalRequest[]>())
  const questionBufferRef = useRef(new Map<string, AgentQuestionRequest[]>())
  const switchReqIdRef = useRef(0)
  const runIdToWorkspaceRef = useRef(new Map<string, string>())
  /** Runs whose controller/routing was disposed; drop late events until reopened. */
  const forgottenRunIdsRef = useRef(new Set<string>())
  const controllerLruRef = useRef<string[]>([])
  const backgroundRunIdsRef = useRef(new Set<string>())
  const refreshRunsRef = useRef<(path: string) => Promise<void>>(async () => {})
  const openRunTabInWorkspaceRef = useRef<
    (workspacePath: string, runId: string | null) => void
  >(() => {})
  const lastActiveRunsWarnAtRef = useRef(0)
  const activeRunsRef = useRef<{ runId: string; workspacePath: string }[]>([])
  const orphanSyncTimersRef = useRef(new Map<string, number>())

  const bump = useCallback(() => setRevision((r) => r + 1), [])

  useEffect(() => {
    registryRef.current = registry
  }, [registry])

  useEffect(() => {
    ensureChatUiPerfDump()
  }, [])


  /** True when this run's transcript is mounted in any open pane. */
  const isRunUiVisible = useCallback((runId: string): boolean => {
    if (backgroundRunIdsRef.current.has(runId)) return false
    if (openInstanceRunIdsRef.current.includes(runId)) return true
    const layout = paneLayoutRef.current
    if (layout?.panes.some((pane) => pane.runId === runId)) return true

    const ws = runIdToWorkspaceRef.current.get(runId)
    if (!ws) return false

    if (layout && layout.panes.length > 1) {
      for (const pane of layout.panes) {
        if (pane.runId !== null) continue
        if (!workspacePathsEqual(pane.workspacePath, ws)) continue
        const ctx = findByWorkspacePath(contextsRef.current, ws)
        if (ctx?.activeRunId === runId) return true
      }
      return false
    }

    const activePath = registryRef.current?.activePath
    if (!activePath || !workspacePathsEqual(ws, activePath)) return false
    const ctx = findByWorkspacePath(contextsRef.current, ws)
    return ctx?.activeRunId === runId
  }, [])

  const lastUiSubscribeKeyRef = useRef('')
  const lastUiSubscribeIdsRef = useRef<string[]>([])

  const collectVisibleRunIds = useCallback((): string[] => {
    const ids = new Set<string>()
    for (const id of openInstanceRunIdsRef.current) {
      if (id) ids.add(id)
    }
    const layout = paneLayoutRef.current
    if (layout) {
      for (const pane of layout.panes) {
        if (pane.runId) ids.add(pane.runId)
      }
    }
    for (const entry of activeRunsRef.current) {
      if (isRunUiVisible(entry.runId)) ids.add(entry.runId)
    }
    if (layout && layout.panes.length > 1) {
      return [...ids]
    }
    const activePath = registryRef.current?.activePath
    if (activePath) {
      const ctx = findByWorkspacePath(contextsRef.current, activePath)
      if (ctx?.activeRunId && isRunUiVisible(ctx.activeRunId)) ids.add(ctx.activeRunId)
    }
    return [...ids]
  }, [isRunUiVisible])

  const syncChatUiSubscriptions = useCallback((): void => {
    if (!window.vyotiq?.chatUiSubscribe) return
    const ids = collectVisibleRunIds()
    const key = ids.slice().sort().join('\0')
    if (key === lastUiSubscribeKeyRef.current) return
    const prev = lastUiSubscribeIdsRef.current
    lastUiSubscribeKeyRef.current = key
    lastUiSubscribeIdsRef.current = ids
    const nextSet = new Set(ids)
    for (const id of prev) {
      if (nextSet.has(id)) continue
      const ctrl = controllersRef.current.get(id)
      if (ctrl && (ctrl.running || ctrl.pendingRun)) {
        ctrl.markUiCatchUpNeeded()
        ctrl.setUiSuspended(true)
      }
    }
    void window.vyotiq
      .chatUiSubscribe({ runIds: ids })
      .catch((err: unknown) => logger.warn('chatUiSubscribe failed', { scope: 'chat', err }))
  }, [collectVisibleRunIds])

  const applyUiSuspendForController = useCallback(
    (runId: string, ctrl: ChatStreamController): void => {
      if (isRunUiVisible(runId)) {
        void ctrl.resumeUiIfNeeded()
      } else {
        ctrl.setUiSuspended(true)
      }
    },
    [isRunUiVisible]
  )

  const suspendAllExceptVisible = useCallback((visible: Set<string>): void => {
    for (const [key, ctrl] of controllersRef.current.entries()) {
      if (key.startsWith('__draft__:')) continue
      const id = ctrl.runId ?? null
      if (!id) continue
      if (visible.has(id)) {
        void ctrl.resumeUiIfNeeded()
      } else {
        ctrl.setUiSuspended(true)
      }
    }
  }, [])

  const suspendAllExcept = useCallback(
    (visibleRunId: string | null): void => {
      const layout = paneLayoutRef.current
      if (layout) {
        suspendAllExceptVisible(visibleRunIds(layout))
        return
      }
      const visible = new Set<string>()
      if (visibleRunId) visible.add(visibleRunId)
      suspendAllExceptVisible(visible)
    },
    [suspendAllExceptVisible]
  )

  const commitPaneLayout = useCallback(
    (next: ChatPaneLayout): void => {
      paneLayoutRef.current = next
      setPaneLayout(next)
      savePaneLayoutToStorage(next)
      suspendAllExceptVisible(visibleRunIds(next))
      bump()
    },
    [bump, suspendAllExceptVisible]
  )

  useEffect(() => {
    const merged: Record<string, WorkspaceContext> = { ...contexts }
    for (const path of Object.keys(contextsRef.current)) {
      const refCtx = contextsRef.current[path]
      const stateCtx = merged[path]
      if (!refCtx) continue
      if (!stateCtx) {
        merged[path] = refCtx
        continue
      }
      const refScroll = refCtx.ui.scrollTopByRunId
      const stateScroll = stateCtx.ui.scrollTopByRunId
      const scrollChanged =
        refCtx.ui.scrollTop !== stateCtx.ui.scrollTop ||
        Object.keys(refScroll).some((key) => refScroll[key] !== stateScroll[key])
      // Prefer ref for keystroke-hot fields so draft/query isolation is not wiped
      // when React state lags behind contextsRef.
      merged[path] = {
        ...stateCtx,
        sessionQuery: refCtx.sessionQuery,
        ui: {
          ...stateCtx.ui,
          composerDraft: refCtx.ui.composerDraft,
          composerDraftByRunId: { ...stateCtx.ui.composerDraftByRunId, ...refCtx.ui.composerDraftByRunId },
          scrollTop: scrollChanged ? refCtx.ui.scrollTop : stateCtx.ui.scrollTop,
          scrollTopByRunId: scrollChanged
            ? { ...stateScroll, ...refScroll }
            : stateCtx.ui.scrollTopByRunId
        }
      }
    }
    contextsRef.current = merged
  }, [contexts])

  const schedulePersistUiState = useCallback((path: string, snapshot?: WorkspaceContext) => {
    const existing = persistTimersRef.current.get(path)
    if (existing) window.clearTimeout(existing)
    const timerId = window.setTimeout(() => {
      persistTimersRef.current.delete(path)
      const ctx = snapshot ?? contextsRef.current[path]
      if (!ctx) return
      const update = window.vyotiq?.updateWorkspaceUiState
      if (!update) return
      const gen = (uiWriteGenerationRef.current.get(path) ?? 0) + 1
      uiWriteGenerationRef.current.set(path, gen)
      void Promise.resolve(
        update(path, { ...uiStateFromContext(ctx), writeGeneration: gen, writeEpoch: UI_WRITE_EPOCH })
      ).then((res) => {
        if (!res || res.ok) return
        logger.warn('updateWorkspaceUiState failed', {
          scope: 'workspaces',
          path,
          err: toLogErr(res.error)
        })
      })
    }, UI_PERSIST_DEBOUNCE_MS)
    persistTimersRef.current.set(path, timerId)
  }, [])

  // Cancel pending UI-state persist timers on unmount. A debounce that fires
  // after the host environment is gone touches `window` post-teardown and the
  // unhandled error fails the whole vitest run even when every test passes
  // (CI run 33769648262 macos "Test (with coverage)", useWorkspaceManager.ts:749).
  useEffect(
    () => () => {
      for (const timer of persistTimersRef.current.values()) window.clearTimeout(timer)
      persistTimersRef.current.clear()
    },
    []
  )

  const flushPersistUiState = useCallback((path?: string) => {
    if (path) {
      const timer = persistTimersRef.current.get(path)
      if (timer) {
        window.clearTimeout(timer)
        persistTimersRef.current.delete(path)
      }
    } else {
      for (const timer of persistTimersRef.current.values()) {
        window.clearTimeout(timer)
      }
      persistTimersRef.current.clear()
    }
    const paths = path ? [path] : Object.keys(contextsRef.current)
    for (const workspacePath of paths) {
      const ctx = contextsRef.current[workspacePath]
      if (!ctx) continue
      const gen = (uiWriteGenerationRef.current.get(workspacePath) ?? 0) + 1
      uiWriteGenerationRef.current.set(workspacePath, gen)
      const ui = { ...uiStateFromContext(ctx), writeGeneration: gen, writeEpoch: UI_WRITE_EPOCH }
      const api = window.vyotiq
      if (!api) continue
      const sync = (
        api as typeof api & {
          updateWorkspaceUiStateSync?: (p: string, u: WorkspaceUiState) => void
        }
      ).updateWorkspaceUiStateSync
      if (sync) {
        sync(workspacePath, ui)
      } else {
        void api.updateWorkspaceUiState?.(workspacePath, ui)
      }
    }
  }, [])

  const flushBufferedEvents = useCallback(
    (runId: string, ctrl: ChatStreamController) => {
      const buffered = eventBufferRef.current.get(runId)
      if (!buffered?.length) return
      eventBufferRef.current.delete(runId)
      for (const event of buffered) ctrl.handleEvent(event)
    },
    []
  )

  const flushBufferedApprovals = useCallback(
    (runId: string, ctrl: ChatStreamController) => {
      const buffered = approvalBufferRef.current.get(runId)
      if (!buffered?.length) return
      approvalBufferRef.current.delete(runId)
      for (const request of buffered) ctrl.handleApprovalRequest(request)
    },
    []
  )

  const flushBufferedQuestions = useCallback(
    (runId: string, ctrl: ChatStreamController) => {
      const buffered = questionBufferRef.current.get(runId)
      if (!buffered?.length) return
      questionBufferRef.current.delete(runId)
      for (const request of buffered) ctrl.handleQuestionRequest(request)
    },
    []
  )

  const bufferOrphanEvent = useCallback((runId: string, event: AgentEvent): void => {
    if (forgottenRunIdsRef.current.has(runId)) return
    const buffered = eventBufferRef.current.get(runId) ?? []
    if (buffered.length >= ORPHAN_EVENT_BUFFER_MAX) {
      if (coalesceOldestOrphanDelta(buffered)) {
        // Folded older stream delta into a later one.
      } else if (coalesceOldestOrphanToolCallDelta(buffered)) {
        // Folded older tool_call_delta into a later same-id delta.
      } else if (coalesceOldestOrphanUsage(buffered)) {
        // Dropped an older usage event; a newer same-type meter remains.
      } else {
        // Prefer freeing stream deltas, then usage meters, over tool/status chrome.
        const deltaIdx = buffered.findIndex((ev) => ORPHAN_DELTA_TYPES.has(ev.type))
        if (deltaIdx >= 0) buffered.splice(deltaIdx, 1)
        else {
          const usageIdx = buffered.findIndex((ev) => ORPHAN_USAGE_TYPES.has(ev.type))
          if (usageIdx >= 0) buffered.splice(usageIdx, 1)
          else {
            const nonCriticalIdx = buffered.findIndex((ev) => !ORPHAN_CRITICAL_TYPES.has(ev.type))
            if (nonCriticalIdx >= 0) buffered.splice(nonCriticalIdx, 1)
            else if (!ORPHAN_CRITICAL_TYPES.has(event.type)) {
              // Buffer is all critical — drop the incoming non-critical instead.
              return
            } else {
              buffered.shift()
            }
          }
        }
      }
    }
    buffered.push(event)
    eventBufferRef.current.set(runId, buffered)
  }, [])

  const bufferOrphanApproval = useCallback((runId: string, request: ToolApprovalRequest): void => {
    if (forgottenRunIdsRef.current.has(runId)) return
    const buffered = approvalBufferRef.current.get(runId) ?? []
    if (buffered.length >= ORPHAN_APPROVAL_BUFFER_MAX) {
      buffered.shift()
    }
    buffered.push(request)
    approvalBufferRef.current.set(runId, buffered)
  }, [])

  const bufferOrphanQuestion = useCallback((runId: string, request: AgentQuestionRequest): void => {
    if (forgottenRunIdsRef.current.has(runId)) return
    const buffered = questionBufferRef.current.get(runId) ?? []
    if (buffered.length >= ORPHAN_QUESTION_BUFFER_MAX) {
      buffered.shift()
    }
    buffered.push(request)
    questionBufferRef.current.set(runId, buffered)
  }, [])

  const forgetRunRouting = useCallback((runId: string): void => {
    forgottenRunIdsRef.current.add(runId)
    eventBufferRef.current.delete(runId)
    approvalBufferRef.current.delete(runId)
    questionBufferRef.current.delete(runId)
    runIdToWorkspaceRef.current.delete(runId)
    controllersRef.current.get(runId)?.dispose()
    controllersRef.current.delete(runId)
    const lruIdx = controllerLruRef.current.indexOf(runId)
    if (lruIdx >= 0) controllerLruRef.current.splice(lruIdx, 1)
  }, [])

  const touchLru = useCallback((runId: string) => {
    const lru = controllerLruRef.current
    const idx = lru.indexOf(runId)
    if (idx >= 0) lru.splice(idx, 1)
    lru.push(runId)
  }, [])

  const registerRunId = useCallback(
    (runId: string, workspacePath: string) => {
      forgottenRunIdsRef.current.delete(runId)
      runIdToWorkspaceRef.current.set(runId, workspacePath)
      touchLru(runId)
      const ctrl = controllersRef.current.get(runId)
      if (ctrl) {
        flushBufferedEvents(runId, ctrl)
        flushBufferedApprovals(runId, ctrl)
        flushBufferedQuestions(runId, ctrl)
      }
    },
    [flushBufferedApprovals, flushBufferedEvents, flushBufferedQuestions, touchLru]
  )

  const maybeEvictControllers = useCallback(
    (workspacePath: string, openRunIds: string[], activeRunId: string | null) => {
      if (openRunIds.length <= OPEN_RUN_TAB_LIMIT) return
      const excess = openRunIds.length - OPEN_RUN_TAB_LIMIT
      const candidates = controllerLruRef.current.filter((runId) => {
        if (!openRunIds.includes(runId)) return false
        if (runId === activeRunId) return false
        const ctrl = controllersRef.current.get(runId)
        if (!ctrl) return false
        if (ctrl.running || ctrl.pendingRun) return false
        return true
      })
      for (let i = 0; i < excess && i < candidates.length; i++) {
        forgetRunRouting(candidates[i]!)
      }
    },
    [forgetRunRouting]
  )

  const ensureController = useCallback(
    (workspacePath: string, runId: string | null): ChatStreamController => {
      const key = runId ?? draftControllerKey(workspacePath)
      const existing = controllersRef.current.get(key)
      if (existing) return existing

      const onRunIdAssigned = (assignedId: string): void => {
        const draftKey = draftControllerKey(workspacePath)
        const current = controllersRef.current.get(key)
        if (current && key !== assignedId) {
          const existingAssigned = controllersRef.current.get(assignedId)
          if (!existingAssigned || existingAssigned === current) {
            controllersRef.current.set(assignedId, current)
            if (controllersRef.current.get(key) === current) {
              controllersRef.current.delete(key)
            }
            touchLru(assignedId)
          } else if (key === draftKey && controllersRef.current.get(key) === current) {
            // Stream events may have created a run-scoped controller before chatStart
            // returned — keep the draft that owns the optimistic user send.
            existingAssigned.dispose()
            controllersRef.current.set(assignedId, current)
            controllersRef.current.delete(key)
            touchLru(assignedId)
          }
        }
        registerRunId(assignedId, workspacePath)
        // Draft expansion state now belongs to the assigned run bucket.
        if (expansionRunId == null) expansionRunId = assignedId
        const ctx = contextsRef.current[workspacePath]
        if (!ctx) {
          void refreshRunsRef.current(workspacePath)
          return
        }
        if (ctx.activeRunId === assignedId) {
          void refreshRunsRef.current(workspacePath)
          return
        }

        let openRunIds: string[]
        if (
          ctx.activeRunId &&
          ctx.activeRunId !== assignedId &&
          ctx.openRunIds.includes(ctx.activeRunId)
        ) {
          openRunIds = ctx.openRunIds.map((id) => (id === ctx.activeRunId ? assignedId : id))
          if (!openRunIds.includes(assignedId)) {
            openRunIds = [...openRunIds, assignedId]
          }
        } else if (ctx.openRunIds.includes(assignedId)) {
          openRunIds = ctx.openRunIds
        } else {
          openRunIds = [...ctx.openRunIds, assignedId]
        }

        maybeEvictControllers(workspacePath, openRunIds, assignedId)
        const nextCtx: WorkspaceContext = {
          ...ctx,
          activeRunId: assignedId,
          openRunIds
        }
        contextsRef.current = { ...contextsRef.current, [workspacePath]: nextCtx }
        setContexts((prev) => ({
          ...prev,
          [workspacePath]: nextCtx
        }))
        schedulePersistUiState(workspacePath, nextCtx)
        void refreshRunsRef.current(workspacePath)
      }

      const onTerminal = (): void => {
        void refreshRunsRef.current(workspacePath)
      }

      // Expansion state persists per run; a draft controller buckets under the
      // draft key until a run id is assigned.
      let expansionRunId: string | null = runId
      const expansionBucketKey = (): string => expansionRunId ?? DRAFT_SCROLL_KEY
      // Profile binding migrates with the same draft → run bucket transition.
      let profileBindingRunId: string | null = runId
      const profileBucketKey = (): string => profileBindingRunId ?? DRAFT_SCROLL_KEY

      const controller = createChatStreamController({
        workspacePath,
        runId,
        onRunIdAssigned: (assignedRunId) => {
          // Migrate the draft's profile binding into the assigned run bucket —
          // the closure bucket below changes with profileBindingRunId, but the
          // persisted map only had the value under the draft key, so the
          // composer picker reset and follow-up sends dropped the teammate.
          const ctx0 = contextsRef.current[workspacePath]
          const draftBinding = ctx0?.ui.agentProfileIdByRunId?.[DRAFT_SCROLL_KEY]
          if (
            ctx0 &&
            draftBinding != null &&
            ctx0.ui.agentProfileIdByRunId?.[assignedRunId] == null
          ) {
            const { [DRAFT_SCROLL_KEY]: _drop, ...restBindings } = ctx0.ui.agentProfileIdByRunId
            const nextCtx0: WorkspaceContext = {
              ...ctx0,
              ui: {
                ...ctx0.ui,
                agentProfileIdByRunId: {
                  ...restBindings,
                  [assignedRunId]: draftBinding
                }
              }
            }
            contextsRef.current = { ...contextsRef.current, [workspacePath]: nextCtx0 }
            setContexts((prev) => ({ ...prev, [workspacePath]: nextCtx0 }))
            schedulePersistUiState(workspacePath, nextCtx0)
          }
          profileBindingRunId = assignedRunId
          onRunIdAssigned(assignedRunId)
        },
        onTerminal,
        getAgentMode: () => contextsRef.current[workspacePath]?.ui.agentMode ?? 'agent',
        getAgentProfileId: () =>
          contextsRef.current[workspacePath]?.ui.agentProfileIdByRunId?.[
            profileBucketKey()
          ] ?? null,
        getDefaultProviderModel: () =>
          getDefaultProviderModelRef.current?.(workspacePath) ?? null,
        onAgentModeChange: (mode) => {
          const ctx = contextsRef.current[workspacePath]
          if (!ctx || ctx.ui.agentMode === mode) return
          const nextCtx: WorkspaceContext = {
            ...ctx,
            ui: { ...ctx.ui, agentMode: mode }
          }
          contextsRef.current = { ...contextsRef.current, [workspacePath]: nextCtx }
          setContexts((prev) => ({ ...prev, [workspacePath]: nextCtx }))
          schedulePersistUiState(workspacePath, nextCtx)
        },
        initialExpansions:
          contextsRef.current[workspacePath]?.ui.expansionsByRunId[
            runId ?? DRAFT_SCROLL_KEY
          ] ?? EMPTY_RUN_EXPANSIONS,
        onExpansionsChange: (next) => {
          const ctx = contextsRef.current[workspacePath]
          if (!ctx) return
          const bucketKey = expansionBucketKey()
          const nextCtx: WorkspaceContext = {
            ...ctx,
            ui: {
              ...ctx.ui,
              expansionsByRunId: { ...ctx.ui.expansionsByRunId, [bucketKey]: next }
            }
          }
          contextsRef.current = { ...contextsRef.current, [workspacePath]: nextCtx }
          setContexts((prev) => ({ ...prev, [workspacePath]: nextCtx }))
          schedulePersistUiState(workspacePath, nextCtx)
        }
      })
      controllersRef.current.set(key, controller)
      // Seed the session's provider/model from the teammate pin at creation —
      // session-scoped only: a later manual pick overrides it and nothing is
      // written to the workspace/global default. Creation happens once per
      // session, so remounts (dictation, panes) never re-fire it.
      const boundProfileId =
        contextsRef.current[workspacePath]?.ui.agentProfileIdByRunId?.[
          runId ?? DRAFT_SCROLL_KEY
        ] ?? null
      const pin = boundProfileId ? getAgentProfileModelPinRef.current?.(boundProfileId) : null
      if (pin) controller.setProviderModel(pin.provider, pin.model)
      if (runId) {
        registerRunId(runId, workspacePath)
        void restorePendingQuestions(controller, runId)
        void restorePendingApprovals(controller, runId)
      }
      return controller
    },
    [bump, maybeEvictControllers, registerRunId, schedulePersistUiState, touchLru]
  )

  const refreshRuns = useCallback(
    async (workspacePath: string): Promise<void> => {
      if (!workspacePath.trim()) return
      if (!window.vyotiq?.listRuns) return
      const res = await window.vyotiq.listRuns(workspacePath)
      setContexts((prev) => {
        const ctx = prev[workspacePath]
        if (!ctx) return prev
        if (res.ok) {
          const runIds = res.data.runs.map((r) => r.runId)
          const reconciled = reconcileOpenRunIds(
            ctx.openRunIds,
            ctx.activeRunId,
            runIds,
            ctx.runs.map((r) => r.runId)
          )
          const validProfileIds = getValidAgentProfileIdsRef.current?.() ?? null
          const hydratedBindings = { ...ctx.ui.agentProfileIdByRunId }
          let bindingsChanged = false
          if (validProfileIds) {
            for (const run of [...res.data.runs, ...(res.data.instanceRuns ?? [])]) {
              if (
                run.agentProfileId &&
                validProfileIds.has(run.agentProfileId) &&
                hydratedBindings[run.runId] == null
              ) {
                hydratedBindings[run.runId] = run.agentProfileId
                bindingsChanged = true
              }
            }
          }
          const nextCtx: WorkspaceContext = {
            ...ctx,
            runs: res.data.runs,
            instanceRuns: res.data.instanceRuns ?? [],
            runsCapped: res.data.capped,
            runsError: null,
            runsLoaded: true,
            ...(bindingsChanged
              ? { ui: { ...ctx.ui, agentProfileIdByRunId: hydratedBindings } }
              : {}),
            ...(reconciled.changed
              ? {
                  openRunIds: reconciled.openRunIds,
                  activeRunId: reconciled.activeRunId,
                  ui: {
                    ...ctx.ui,
                    agentProfileIdByRunId: hydratedBindings,
                    scrollTopByRunId: pruneScrollTopByRunId(ctx.ui.scrollTopByRunId, {
                      openRunIds: reconciled.openRunIds,
                      activeRunId: reconciled.activeRunId
                    })
                  }
                }
              : {})
          }
          contextsRef.current = { ...contextsRef.current, [workspacePath]: nextCtx }
          if (reconciled.changed || bindingsChanged) {
            schedulePersistUiState(workspacePath, nextCtx)
          }
          return {
            ...prev,
            [workspacePath]: nextCtx
          }
        }
        logger.warn('listRuns failed', { scope: 'runs', err: toLogErr(res.error) })
        return {
          ...prev,
          [workspacePath]: {
            ...ctx,
            runs: [],
            instanceRuns: [],
            runsCapped: false,
            runsError: res.error,
            runsLoaded: true
          }
        }
      })
      if (res.ok) {
        const resumableCount = res.data.runs.filter(isResumableInterruptedRun).length
        if (
          resumableCount > 0 &&
          typeof sessionStorage !== 'undefined' &&
          !sessionStorage.getItem(INTERRUPTED_RUNS_TOAST_KEY)
        ) {
          sessionStorage.setItem(INTERRUPTED_RUNS_TOAST_KEY, '1')
          pushToast(
            `${resumableCount} interrupted run${resumableCount === 1 ? '' : 's'} — open a chat and tap Continue`
          )
        }
      }
      bump()
    },
    [bump, schedulePersistUiState]
  )

  refreshRunsRef.current = refreshRuns

  /**
   * Auto-resume queue: one interrupted run at a time. A crash can leave many
   * runs marked resumable; resuming them concurrently stampedes the provider,
   * the indexer, and the machine.
   */
  const drainAutoResumeQueue = useCallback(async (): Promise<void> => {
    if (autoResumeDrainingRef.current) return
    autoResumeDrainingRef.current = true
    try {
      while (autoResumeQueueRef.current.length > 0) {
        const task = autoResumeQueueRef.current.shift()!
        try {
          await task()
        } catch {
          // resumeInterrupted surfaces its own errors/toasts.
        }
        await new Promise((resolve) => setTimeout(resolve, 750))
      }
    } finally {
      autoResumeDrainingRef.current = false
    }
  }, [])

  // First resume waits for browser idle so first paint + hydration win;
  // subsequent resumes keep the existing 750ms serialization.
  const autoResumeDrainScheduledRef = useRef(false)
  const scheduleAutoResumeDrain = useCallback((): void => {
    if (autoResumeDrainScheduledRef.current) return
    autoResumeDrainScheduledRef.current = true
    const start = (): void => {
      autoResumeDrainScheduledRef.current = false
      void drainAutoResumeQueue()
    }
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(start, { timeout: 2000 })
    } else {
      window.setTimeout(start, 1000)
    }
  }, [drainAutoResumeQueue])

  const loadRunTranscript = useCallback(
    async (
      workspacePath: string,
      runId: string,
      opts?: { isCurrent?: () => boolean; allowAutoResume?: boolean }
    ): Promise<boolean> => {
      const ctrl = ensureController(workspacePath, runId)
      if (ctrl.running || ctrl.pendingRun) return true
      if (!window.vyotiq?.loadRun) return true
      const stillCurrent = (): boolean => {
        if (opts?.isCurrent && !opts.isCurrent()) return false
        if (ctrl.disposed) return false
        return controllersRef.current.get(runId) === ctrl
      }
      ctrl.setTranscriptLoading(true)
      let autoResumeAfterLoad = false
      try {
        const res = await window.vyotiq.loadRun(workspacePath, runId)
        if (!stillCurrent()) return true
        if (!res.ok) {
          logger.warn('loadRun failed on restore', {
            scope: 'runs',
            correlationId: runId,
            err: res.error
          })
          setContexts((prev) => {
            const ctx = prev[workspacePath]
            if (!ctx) return prev
            return {
              ...prev,
              [workspacePath]: { ...ctx, runsError: res.error }
            }
          })
          bump()
          return false
        }
        let events: PersistedEvent[] = []
        if (window.vyotiq.loadRunEvents) {
          const eventsRes = await window.vyotiq.loadRunEvents(workspacePath, runId)
          if (!stillCurrent()) return true
          if (eventsRes.ok) {
            events = eventsRes.data
          } else {
            logger.warn('loadRunEvents failed on restore', {
              scope: 'runs',
              correlationId: runId,
              err: eventsRes.error
            })
            setContexts((prev) => {
              const ctx = prev[workspacePath]
              if (!ctx) return prev
              return {
                ...prev,
                [workspacePath]: { ...ctx, runsError: eventsRes.error }
              }
            })
            bump()
          }
        }
        if (!stillCurrent()) return true
        ctrl.hydrateTranscript(res.data.messages, events, {
          hasEarlier: res.data.hasEarlier,
          earlierCursor: res.data.earlierCursor
        })
        bump()
        if (
          stillCurrent() &&
          !ctrl.running &&
          !ctrl.pendingRun &&
          // Inline instances are inspect-only: main never relaunches them
          // (startAgentRun suppresses goal relaunch for inlineInstance runs).
          res.data.inlineInstance !== true &&
          isResumableInterruptedRun(
            res.data.status
              ? {
                  status: res.data.status,
                  resumable: res.data.resumable,
                  error: res.data.error
                }
              : null
          ) &&
          !autoResumeAttemptedRef.current.has(runId) &&
          opts?.allowAutoResume === true
        ) {
          const settingsRes = await window.vyotiq.getSettings()
          if (!stillCurrent()) return true
          if (settingsRes.ok && settingsRes.data.autoResumeInterruptedRuns) {
            autoResumeAttemptedRef.current.add(runId)
            autoResumeAfterLoad = true
          }
        }
      } finally {
        if (stillCurrent()) ctrl.setTranscriptLoading(false)
        if (stillCurrent() && autoResumeAfterLoad) {
          // Serialize resumes: a crash can leave dozens of interrupted runs and
          // resuming them all at once stampedes the provider and the machine.
          autoResumeQueueRef.current.push(async () => {
            if (ctrl.disposed) return
            pushToast('Resuming interrupted run…')
            await ctrl.resumeInterrupted()
          })
          scheduleAutoResumeDrain()
        }
      }
      return true
    },
    [bump, drainAutoResumeQueue, ensureController]
  )

  const loadRunIntoTab = useCallback(
    async (workspacePath: string, runId: string): Promise<void> => {
      const ok = await loadRunTranscript(workspacePath, runId, { allowAutoResume: true })
      if (!ok) paneLoadRetryRef.current.add(runId)
      else paneLoadRetryRef.current.delete(runId)
    },
    [loadRunTranscript]
  )

  const reattachActiveRuns = useCallback(
    async (entries: { runId: string; workspacePath: string }[]): Promise<void> => {
      let didReattach = false
      for (const entry of entries) {
        runIdToWorkspaceRef.current.set(entry.runId, entry.workspacePath)
        if (!isRunUiVisible(entry.runId)) continue
        const ctrl = ensureController(entry.workspacePath, entry.runId)
        if (!ctrl.running) {
          await ctrl.reattachActiveRun(entry.runId)
          didReattach = true
        }
        await restorePendingQuestions(ctrl, entry.runId)
        await restorePendingApprovals(ctrl, entry.runId)
        applyUiSuspendForController(entry.runId, ctrl)
      }
      syncChatUiSubscriptions()
      if (didReattach) bump()
    },
    [applyUiSuspendForController, bump, ensureController, isRunUiVisible, syncChatUiSubscriptions]
  )

  const pollActiveRuns = useCallback(async (): Promise<void> => {
    if (!window.vyotiq?.listActiveRuns) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    const res = await window.vyotiq.listActiveRuns()
    if (!res.ok) {
      const now = Date.now()
      if (now - lastActiveRunsWarnAtRef.current >= ACTIVE_RUNS_WARN_INTERVAL_MS) {
        lastActiveRunsWarnAtRef.current = now
        logger.warn('listActiveRuns failed', { scope: 'runs', err: toLogErr(res.error) })
      }
      return
    }
    const prevActive = activeRunsRef.current
    const nextActive = res.data
    const activeChanged =
      prevActive.length !== nextActive.length ||
      prevActive.some(
        (entry, i) =>
          entry.runId !== nextActive[i]?.runId ||
          !workspacePathsEqual(entry.workspacePath, nextActive[i]!.workspacePath)
      )
    activeRunsRef.current = nextActive
    if (activeChanged) {
      setActiveRuns(nextActive)
    }
    for (const entry of prevActive) {
      if (
        nextActive.some(
          (r) => r.runId === entry.runId && workspacePathsEqual(r.workspacePath, entry.workspacePath)
        )
      ) {
        continue
      }
      void refreshRunsRef.current(entry.workspacePath)
    }
    for (const entry of finishedBackgroundRuns(
      prevActive,
      nextActive,
      backgroundRunIdsRef.current
    )) {
      const ctx = findByWorkspacePath(contextsRef.current, entry.workspacePath)
      const run =
        ctx?.runs.find((r) => r.runId === entry.runId) ??
        ctx?.instanceRuns.find((r) => r.runId === entry.runId)
      const layout = paneLayoutRef.current
      const focusedPane = layout
        ? (layout.panes.find((p) => p.paneId === layout.focusedPaneId) ?? layout.panes[0] ?? null)
        : null
      const focusedId =
        focusedPane?.runId ??
        (registryRef.current?.activePath
          ? contextsRef.current[registryRef.current.activePath]?.activeRunId
          : null) ??
        null
      if (
        shouldShowBackgroundRunToast({
          windowFocused: typeof document !== 'undefined' && document.hasFocus(),
          focusedRunId: focusedId,
          finishedRunId: entry.runId
        })
      ) {
        pushToast(backgroundRunFinishedMessage(run?.goal), 'info', 6000, () => {
          openRunTabInWorkspaceRef.current(entry.workspacePath, entry.runId)
        })
      }
      backgroundRunIdsRef.current.delete(entry.runId)
    }
    const activeIds = new Set(nextActive.map((entry) => entry.runId))
    await reattachActiveRuns(nextActive)
    for (const [key, ctrl] of controllersRef.current.entries()) {
      const id = ctrl.runId
      if (!id) continue
      if (activeIds.has(id)) {
        const pending = orphanSyncTimersRef.current.get(key)
        if (pending) {
          window.clearTimeout(pending)
          orphanSyncTimersRef.current.delete(key)
        }
        continue
      }
      if (!ctrl.running && !ctrl.pendingRun) {
        const pending = orphanSyncTimersRef.current.get(key)
        if (pending) {
          window.clearTimeout(pending)
          orphanSyncTimersRef.current.delete(key)
        }
        continue
      }
      if (orphanSyncTimersRef.current.has(key)) continue
      const timerId = window.setTimeout(() => {
        orphanSyncTimersRef.current.delete(key)
        if (typeof window === 'undefined') return
        const current = controllersRef.current.get(key)
        if (!current?.runId || current.runId !== id) return
        if (!current.running && !current.pendingRun) return
        void (async () => {
          if (window.vyotiq?.listActiveRuns) {
            const fresh = await window.vyotiq.listActiveRuns()
            if (fresh.ok && fresh.data.some((entry) => entry.runId === id)) return
          }
          await current.syncFromDisk(id)
          bump()
        })()
      }, ORPHAN_SYNC_DEBOUNCE_MS)
      orphanSyncTimersRef.current.set(key, timerId)
    }
    if (activeChanged) bump()
  }, [reattachActiveRuns, bump])

  const applyRegistry = useCallback((state: WorkspacesState) => {
    registryRef.current = state
    const prev = contextsRef.current
    const next: Record<string, WorkspaceContext> = {}
    for (const path of state.openPaths) {
      const existing = prev[path]
      if (existing) {
        const ui = state.uiStateByPath[path] ?? defaultUiState()
        const refUi = prev[path]?.ui
        const scrollTopByRunId = { ...(ui.scrollTopByRunId ?? {}) }
        if (ui.scrollTop > 0 && ui.activeRunId && scrollTopByRunId[ui.activeRunId] === undefined) {
          scrollTopByRunId[ui.activeRunId] = ui.scrollTop
        }
        const composerDraft = refUi?.composerDraft ?? existing.ui.composerDraft ?? ui.composerDraft
        const composerDraftByRunId = migrateLegacyComposerDraftMap(
          {
            composerDraft,
            composerDraftByRunId: {
              ...(ui.composerDraftByRunId ?? {}),
              ...existing.ui.composerDraftByRunId,
              ...(refUi?.composerDraftByRunId ?? {})
            }
          },
          existing.activeRunId ?? ui.activeRunId
        )
        next[path] = {
          ...existing,
          activeRunId: existing.activeRunId ?? ui.activeRunId,
          openRunIds:
            existing.openRunIds.length > 0 ? existing.openRunIds : [...ui.openRunIds],
          ui: {
            scrollTop: refUi?.scrollTop ?? existing.ui.scrollTop ?? ui.scrollTop,
            scrollTopByRunId: {
              ...scrollTopByRunId,
              ...existing.ui.scrollTopByRunId,
              ...(refUi?.scrollTopByRunId ?? {})
            },
            composerDraft,
            composerDraftByRunId,
            agentMode: existing.ui.agentMode ?? refUi?.agentMode ?? ui.agentMode ?? 'agent',
            agentProfileIdByRunId: {
              ...(ui.agentProfileIdByRunId ?? {}),
              ...existing.ui.agentProfileIdByRunId,
              ...(refUi?.agentProfileIdByRunId ?? {})
            },
            expanded: existing.ui.expanded ?? refUi?.expanded ?? ui.expanded,
            expansionsByRunId: {
              ...(ui.expansionsByRunId ?? {}),
              ...(refUi?.expansionsByRunId ?? {}),
              ...(existing.ui.expansionsByRunId ?? {})
            }
          },
          settingsOverride: findSettingsOverride(state.settingsOverridesByPath, path)
        }
      } else {
        next[path] = contextFromRegistry(path, state)
      }
    }
    contextsRef.current = next
    setRegistry(state)
    setContexts(next)
  }, [])

  useEffect(() => {
    if (!registry) return
    const open = new Set(registry.openPaths)
    // Seed persisted composer attachments (staged images/files/audio) once per
    // workspace open — merges into memory without clobbering newer local state.
    for (const path of open) {
      void seedComposerAttachmentsFromDisk(path)
    }
    for (const path of open) {
      const ctx = contextsRef.current[path] ?? contexts[path]
      if (!ctx) continue
      if (!hasWorkspaceHotUi(path)) {
        const migrated = migrateLegacyComposerDraftMap(ctx.ui, ctx.activeRunId)
        seedWorkspaceHotUi(path, {
          composerDraft: ctx.ui.composerDraft,
          composerDraftByRunId: migrated,
          sessionQuery: ctx.sessionQuery
        })
      } else {
        // Keep store draft in sync when registry restores a non-empty draft onto an empty store path.
        const hot = getWorkspaceHotUi(path)
        const migrated = migrateLegacyComposerDraftMap(ctx.ui, ctx.activeRunId)
        const needsWorkspaceDraft =
          resolveHotComposerDraft(hot, null) === '' && ctx.ui.composerDraft !== ''
        const missingRunDrafts = Object.entries(migrated).some(
          ([key, value]) => value && !(key in hot.composerDraftByRunId)
        )
        if (needsWorkspaceDraft || missingRunDrafts) {
          seedWorkspaceHotUi(path, {
            composerDraft: needsWorkspaceDraft
              ? ctx.ui.composerDraft
              : resolveHotComposerDraft(hot, null) || ctx.ui.composerDraft,
            composerDraftByRunId: {
              ...migrated,
              ...hot.composerDraftByRunId
            },
            sessionQuery: hot.sessionQuery || ctx.sessionQuery
          })
        }
      }
    }
    for (const path of Object.keys(contexts)) {
      if (!open.has(path)) {
        clearWorkspaceHotUi(path)
        clearComposerAttachmentsForWorkspace(path)
      }
    }
  }, [registry, contexts])

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      if (!window.vyotiq?.getWorkspaces) return
      const res = await window.vyotiq.getWorkspaces()
      if (cancelled) return
      if (!res.ok) {
        logger.error('getWorkspaces failed', { scope: 'workspaces', err: toLogErr(res.error) })
        setWorkspaceError(res.error)
        return
      }
      applyRegistry(res.data)
      for (const path of res.data.openPaths.filter((p) => p.trim())) {
        if (cancelled) return
        const ui = res.data.uiStateByPath[path] ?? defaultUiState()
        for (const runId of ui.openRunIds) {
          ensureController(path, runId)
        }
        if (ui.activeRunId) {
          const activePath = res.data.activePath
          const isActiveWorkspace =
            activePath != null && workspacePathsEqual(path, activePath)
          if (isActiveWorkspace) {
            await loadRunTranscript(path, ui.activeRunId, {
              isCurrent: () => !cancelled,
              allowAutoResume: true
            })
          }
        }
        if (cancelled) return
        void refreshRuns(path)
      }
      if (cancelled) return
      if (window.vyotiq.listActiveRuns) {
        const activeRes = await window.vyotiq.listActiveRuns()
        if (cancelled) return
        if (activeRes.ok) {
          setActiveRuns(activeRes.data)
          await reattachActiveRuns(activeRes.data)
        }
      }
      if (cancelled) return
      if (res.data.activePath) {
        const ui = res.data.uiStateByPath[res.data.activePath] ?? defaultUiState()
        const key = scrollKeyForRun(ui.activeRunId)
        const restoreTop = ui.scrollTopByRunId?.[key] ?? ui.scrollTop
        if (restoreTop > 0) {
          setScrollRestoreToken((t) => t + 1)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [applyRegistry, ensureController, loadRunTranscript, refreshRuns, reattachActiveRuns])

  useEffect(() => {
    const onBeforeUnload = (): void => {
      flushPersistUiState()
      void flushComposerAttachmentsToDisk()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [flushPersistUiState])

  useEffect(() => {
    if (!window.vyotiq?.onChatEvent) return
    return window.vyotiq.onChatEvent((event) => {
      if (event.type === 'goal_update' && event.notice) {
        pushToast(event.notice)
      }
      if (event.type === 'goal_update' || event.type === 'loop_update') {
        const ws = runIdToWorkspaceRef.current.get(event.runId)
        if (ws) void refreshRunsRef.current(ws)
      }
      const ctrl = controllersRef.current.get(event.runId)
      if (!ctrl) {
        bufferOrphanEvent(event.runId, event)
        return
      }
      if (isRunUiVisible(event.runId)) {
        void ctrl.resumeUiIfNeeded()
      } else {
        ctrl.setUiSuspended(true)
      }
      ctrl.handleEvent(event)
    })
  }, [bufferOrphanEvent, isRunUiVisible])

  useEffect(() => {
    if (!window.vyotiq?.onToolApprovalRequest) return
    return window.vyotiq.onToolApprovalRequest((request) => {
      const ctrl = controllersRef.current.get(request.runId)
      if (!ctrl) {
        bufferOrphanApproval(request.runId, request)
        return
      }
      ctrl.handleApprovalRequest(request)
    })
  }, [bufferOrphanApproval])

  useEffect(() => {
    if (!window.vyotiq?.onAgentQuestionRequest) return
    return window.vyotiq.onAgentQuestionRequest((request) => {
      const ctrl = controllersRef.current.get(request.runId)
      if (!ctrl) {
        bufferOrphanQuestion(request.runId, request)
        return
      }
      ctrl.handleQuestionRequest(request)
    })
  }, [bufferOrphanQuestion])

  useEffect(() => {
    void pollActiveRuns()
    const id = window.setInterval(() => void pollActiveRuns(), ACTIVE_RUNS_POLL_MS)
    const onFocus = (): void => {
      void pollActiveRuns()
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void pollActiveRuns()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      for (const timer of orphanSyncTimersRef.current.values()) {
        window.clearTimeout(timer)
      }
      orphanSyncTimersRef.current.clear()
    }
  }, [pollActiveRuns])

  const activeWorkspace = registry?.activePath ?? null
  const openWorkspaces = registry?.openPaths ?? []
  const activeContext = activeWorkspace
    ? findByWorkspacePath(contexts, activeWorkspace)
    : null

  /** Persisted sidebar expand/collapse per workspace (defaults to active expanded). */
  const workspaceExpandedByPath = useMemo(() => {
    const map: Record<string, boolean> = {}
    for (const [path, ctx] of Object.entries(contexts)) {
      map[path] =
        ctx.ui.expanded ??
        (activeWorkspace != null && workspacePathsEqual(path, activeWorkspace))
    }
    return map
  }, [contexts, activeWorkspace])

  const setWorkspaceExpanded = useCallback(
    (path: string, expanded: boolean): void => {
      const ctx = contextsRef.current[path]
      if (!ctx || ctx.ui.expanded === expanded) return
      const nextCtx: WorkspaceContext = {
        ...ctx,
        ui: { ...ctx.ui, expanded }
      }
      contextsRef.current = { ...contextsRef.current, [path]: nextCtx }
      setContexts((prev) => ({ ...prev, [path]: nextCtx }))
      schedulePersistUiState(path, nextCtx)
    },
    [schedulePersistUiState]
  )

  const getReservedPx = useCallback((): number => {
    const ctx = paneCapacityContextRef.current
    return paneCapacityReservedPx({
      dockOpen: ctx.dockOpen,
      dockWidthPx: ctx.dockWidthPx
    })
  }, [])

  const getMaxPaneCount = useCallback((): number => {
    const override = maxChatPanesRef.current
    if (override > 0) return override
    return maxPaneCount(
      typeof window !== 'undefined' ? window.innerWidth : 1200,
      getReservedPx()
    )
  }, [getReservedPx])

  useEffect(() => {
    if (paneLayoutHydratedRef.current || !activeWorkspace) return
    paneLayoutHydratedRef.current = true
    const fallback = singlePaneLayout(
      activeWorkspace,
      activeContext?.activeRunId ?? null,
      createPaneId()
    )
    const stored = loadPaneLayoutFromStorage()
    const openPaths = registryRef.current?.openPaths ?? [activeWorkspace]
    // Same capacity source as drop-time splits — the maxChatPanes override
    // must decide restores too, not just the viewport formula.
    const maxPanes = getMaxPaneCount()
    const initial =
      (stored ? sanitizePaneLayout(stored, openPaths, maxPanes) : null) ?? fallback
    paneLayoutRef.current = initial
    setPaneLayout(initial)
    savePaneLayoutToStorage(initial)
    suspendAllExceptVisible(visibleRunIds(initial))
    for (const pane of initial.panes) {
      if (!pane.runId) continue
      ensureController(pane.workspacePath, pane.runId)
      void loadRunTranscript(pane.workspacePath, pane.runId, {
        allowAutoResume: workspacePathsEqual(pane.workspacePath, activeWorkspace)
      }).then((ok) => {
        if (!ok && pane.runId) paneLoadRetryRef.current.add(pane.runId)
      })
    }
  }, [
    activeContext?.activeRunId,
    activeWorkspace,
    ensureController,
    getMaxPaneCount,
    loadRunTranscript,
    suspendAllExceptVisible
  ])

  // Every committed pane must show its session. Drop/click paths load the
  // transcript fire-and-forget and can silently lose the race (a suspend
  // window, an eviction re-key, a failed one-shot) — then the pane sits empty
  // forever with no error anywhere. Guarantee it here: on every layout commit,
  // hydrate any pane run whose controller is missing or has no content yet.
  // Never touch controllers that are loading, live, or already hold state —
  // an item-less controller can legitimately hold orphan-flushed usage meters.
  useEffect(() => {
    if (!paneLayout) return
    for (const pane of paneLayout.panes) {
      if (!pane.runId) continue
      const ctrl = controllersRef.current.get(pane.runId)
      if (
        ctrl &&
        (ctrl.running ||
          ctrl.pendingRun ||
          ctrl.transcriptLoading ||
          ctrl.items.length > 0 ||
          ctrl.getContextUsage() != null)
      ) {
        paneLoadRetryRef.current.delete(pane.runId)
        continue
      }
      void loadRunTranscript(pane.workspacePath, pane.runId).then((ok) => {
        if (!ok && pane.runId) paneLoadRetryRef.current.add(pane.runId)
        else if (pane.runId) paneLoadRetryRef.current.delete(pane.runId)
      })
    }
  }, [loadRunTranscript, paneLayout])

  useEffect(() => {
    if (!paneLayoutHydratedRef.current || !activeWorkspace || !paneLayoutRef.current) return
    if (paneLayoutRef.current.panes.length !== 1) return
    const pane = paneLayoutRef.current.panes[0]!
    // Do not overwrite a sole pane that still shows another workspace after close.
    if (!workspacePathsEqual(pane.workspacePath, activeWorkspace)) return
    const synced = syncSinglePaneSession(
      paneLayoutRef.current,
      activeWorkspace,
      activeContext?.activeRunId ?? null
    )
    if (synced !== paneLayoutRef.current) {
      commitPaneLayout(synced)
    }
  }, [activeContext?.activeRunId, activeWorkspace, commitPaneLayout])

  const openInstanceRunIdsKey = (options?.openInstanceRunIds ?? []).join('\0')

  useEffect(() => {
    syncChatUiSubscriptions()
  }, [
    openInstanceRunIdsKey,
    paneLayout,
    activeContext?.activeRunId,
    activeWorkspace,
    syncChatUiSubscriptions
  ])

  const getFocusedPane = useCallback((): ChatPane | null => {
    const layout = paneLayoutRef.current
    if (!layout) return null
    return (
      layout.panes.find((p) => p.paneId === layout.focusedPaneId) ?? layout.panes[0] ?? null
    )
  }, [])

  const getPaneById = useCallback((paneId: string): ChatPane | null => {
    const layout = paneLayoutRef.current
    if (!layout) return null
    return layout.panes.find((p) => p.paneId === paneId) ?? null
  }, [])

  const setPaneCapacityContext = useCallback((ctx: PaneCapacityContext): void => {
    paneCapacityContextRef.current = ctx
    // Dock open/close shrinks the chat row — clamp dock width in ChatView instead
    // of dropping existing panes here.
  }, [])

  const focusPaneById = useCallback(
    (paneId: string): void => {
      const layout = paneLayoutRef.current
      if (!layout || layout.focusedPaneId === paneId) return
      const next = focusPane(layout, paneId)
      paneLayoutRef.current = next
      setPaneLayout(next)
      savePaneLayoutToStorage(next)
      bump()
    },
    [bump]
  )

  const setPaneSizesByIndex = useCallback(
    (sizes: number[]): void => {
      const layout = paneLayoutRef.current
      if (!layout) return
      commitPaneLayout(setPaneSizes(layout, sizes))
    },
    [commitPaneLayout]
  )

  // Pane count is preserved on resize/dock; overflow scroll handles tight rows.
  // New splits are refused via getMaxPaneCount in applyPaneDrop.

  const isSessionOpenInPane = useCallback(
    (workspacePath: string, runId: string): boolean => {
      const layout = paneLayoutRef.current
      if (!layout) return false
      return layout.panes.some(
        (p) => workspacePathsEqual(p.workspacePath, workspacePath) && p.runId === runId
      )
    },
    [paneLayout]
  )

  const isSessionFocusedInPane = useCallback(
    (workspacePath: string, runId: string): boolean => {
      const focused = getFocusedPane()
      if (!focused) return false
      return (
        workspacePathsEqual(focused.workspacePath, workspacePath) && focused.runId === runId
      )
    },
    [getFocusedPane, paneLayout]
  )

  const isMultiPane = (paneLayout?.panes.length ?? 0) > 1

  const switchWorkspace = useCallback(
    async (path: string): Promise<void> => {
      if (!window.vyotiq?.setActiveWorkspace) return
      // Clicking the already-active workspace name is a no-op; skip the IPC
      // round-trip, registry re-apply, and chat-surface epoch bump.
      if (activeWorkspace && workspacePathsEqual(activeWorkspace, path)) return
      if (activeWorkspace) flushPersistUiState(activeWorkspace)
      const reqId = ++switchReqIdRef.current
      const res = await window.vyotiq.setActiveWorkspace(path)
      if (reqId !== switchReqIdRef.current) return
      if (res.ok) {
        setWorkspaceError(null)
        applyRegistry(res.data)
        const ctx = contextsRef.current[path]
        const visibleRunId = ctx?.activeRunId ?? null
        const layout = paneLayoutRef.current
        if (layout?.panes.length === 1) {
          commitPaneLayout(syncSinglePaneSession(layout, path, visibleRunId))
        } else {
          suspendAllExcept(visibleRunId)
        }
        if (visibleRunId) {
          backgroundRunIdsRef.current.delete(visibleRunId)
          const ctrl = ensureController(path, visibleRunId)
          if (!ctrl.running && !ctrl.pendingRun && ctrl.items.length === 0) {
            void loadRunTranscript(path, visibleRunId, { allowAutoResume: true })
          }
          void ctrl.resumeUiIfNeeded()
        }
        setChatSurfaceEpoch((t) => t + 1)
        setScrollRestoreToken((t) => t + 1)
      } else {
        setWorkspaceError(res.error)
      }
    },
    [
      activeWorkspace,
      applyRegistry,
      commitPaneLayout,
      ensureController,
      flushPersistUiState,
      loadRunTranscript,
      suspendAllExcept
    ]
  )

  const addWorkspace = useCallback(
    async (
      path?: string
    ): Promise<{ activePath: string; activeRunId: string | null } | null> => {
      if (!window.vyotiq?.addWorkspace) return null
      const res = await window.vyotiq.addWorkspace(path)
      if (res.ok) {
        setWorkspaceError(null)
        applyRegistry(res.data)
        for (const p of res.data.openPaths) {
          setContexts((prev) => {
            if (prev[p]) return prev
            return { ...prev, [p]: contextFromRegistry(p, res.data) }
          })
          void refreshRuns(p)
        }
        // Mirror switchWorkspace: load the newly active workspace's active run
        // transcript. Main reuses a persisted activeRunId on re-add, so without
        // this the chat pane would point at a run with no hydrated transcript.
        const addedActive = res.data.activePath
        if (addedActive) {
          const ctx = contextsRef.current[addedActive]
          const visibleRunId = ctx?.activeRunId ?? null
          if (visibleRunId) {
            const ctrl = ensureController(addedActive, visibleRunId)
            if (!ctrl.running && !ctrl.pendingRun && ctrl.items.length === 0) {
              void loadRunTranscript(addedActive, visibleRunId, { allowAutoResume: true })
            }
            void ctrl.resumeUiIfNeeded()
          }
          setChatSurfaceEpoch((t) => t + 1)
          setScrollRestoreToken((t) => t + 1)
          // Composer focus for a fresh workspace is owned by App after setView('chat')
          // so focus runs once Chat is mounted. Returning activeRunId lets App open a
          // draft session when null, or keep the persisted run on re-add.
          return { activePath: addedActive, activeRunId: visibleRunId }
        }
        return null
      } else {
        setWorkspaceError(res.error)
        return null
      }
    },
    [applyRegistry, ensureController, loadRunTranscript, refreshRuns]
  )

  const removeWorkspace = useCallback(
    async (path: string, deleteStorage?: boolean): Promise<void> => {
      const activeForWorkspace = activeRunsRef.current.filter((run) =>
        workspacePathsEqual(run.workspacePath, path)
      )
      flushPersistUiState(path)

      if (!window.vyotiq?.removeWorkspace) return
      const res = await window.vyotiq.removeWorkspace(
        path,
        activeForWorkspace.length > 0,
        deleteStorage
      )
      if (res.ok) {
        for (const run of activeForWorkspace) {
          backgroundRunIdsRef.current.delete(run.runId)
          forgetRunRouting(run.runId)
        }
        setWorkspaceError(null)
        applyRegistry(res.data)
        setContexts((prev) => {
          const next = { ...prev }
          delete next[path]
          return next
        })
        const layout = paneLayoutRef.current
        if (layout) {
          const sanitized = sanitizePaneLayout(
            layout,
            res.data.openPaths,
            getMaxPaneCount()
          )
          if (sanitized) {
            commitPaneLayout(sanitized)
          } else if (res.data.activePath) {
            const ctx = contextsRef.current[res.data.activePath]
            commitPaneLayout(
              singlePaneLayout(res.data.activePath, ctx?.activeRunId ?? null)
            )
          } else {
            paneLayoutRef.current = null
            setPaneLayout(null)
          }
        }
      } else {
        setWorkspaceError(res.error)
      }
    },
    [applyRegistry, commitPaneLayout, flushPersistUiState, forgetRunRouting, getMaxPaneCount]
  )

  const getRunController = useCallback(
    (runId: string | null, workspacePath?: string | null): ChatStreamController | null => {
      const path =
        workspacePath ??
        getFocusedPane()?.workspacePath ??
        activeWorkspace
      if (!path) return null
      return ensureController(path, runId)
    },
    [activeWorkspace, ensureController, getFocusedPane]
  )

  const openRunTabInWorkspace = useCallback(
    (
      workspacePath: string,
      runId: string | null,
      options?: { syncLayout?: boolean }
    ): void => {
      const syncLayout = options?.syncLayout !== false
      const entryKey =
        contextsRef.current[workspacePath] !== undefined
          ? workspacePath
          : (Object.keys(contextsRef.current).find((k) =>
              workspacePathsEqual(k, workspacePath)
            ) ?? workspacePath)
      const ctx = contextsRef.current[entryKey] ?? findByWorkspacePath(contextsRef.current, workspacePath)
      if (!ctx) return
      const sameTab = ctx.activeRunId === runId
      const openRunIds =
        runId && !ctx.openRunIds.includes(runId) ? [...ctx.openRunIds, runId] : ctx.openRunIds
      const nextCtx = {
        ...ctx,
        activeRunId: runId,
        openRunIds
      }
      maybeEvictControllers(entryKey, openRunIds, runId)
      if (runId) backgroundRunIdsRef.current.delete(runId)
      const ctrl = ensureController(entryKey, runId)
      contextsRef.current = { ...contextsRef.current, [entryKey]: nextCtx }
      setContexts((prev) => ({
        ...prev,
        [entryKey]: nextCtx
      }))
      schedulePersistUiState(entryKey, nextCtx)
      const layout = paneLayoutRef.current
      if (syncLayout && layout && layout.panes.length === 1) {
        const synced = syncSinglePaneSession(layout, entryKey, runId)
        paneLayoutRef.current = synced
        setPaneLayout(synced)
        savePaneLayoutToStorage(synced)
        suspendAllExceptVisible(visibleRunIds(synced))
      } else if (syncLayout && layout) {
        const next = replaceFocusedPaneSession(layout, entryKey, runId)
        paneLayoutRef.current = next
        setPaneLayout(next)
        savePaneLayoutToStorage(next)
        suspendAllExceptVisible(visibleRunIds(next))
      } else if (layout) {
        suspendAllExceptVisible(visibleRunIds(layout))
      } else {
        suspendAllExcept(runId)
      }
      if (runId) {
        void ctrl.resumeUiIfNeeded()
      }
      if (!sameTab) {
        flushPersistUiState(entryKey)
        setChatSurfaceEpoch((t) => t + 1)
        setScrollRestoreToken((t) => t + 1)
      }
      bump()
    },
    [
      bump,
      ensureController,
      flushPersistUiState,
      maybeEvictControllers,
      schedulePersistUiState,
      suspendAllExcept,
      suspendAllExceptVisible
    ]
  )

  openRunTabInWorkspaceRef.current = openRunTabInWorkspace

  const openRunTab = useCallback(
    (runId: string | null): void => {
      const path = getFocusedPane()?.workspacePath ?? activeWorkspace
      if (!path) return
      openRunTabInWorkspace(path, runId)
    },
    [activeWorkspace, getFocusedPane, openRunTabInWorkspace]
  )

  const openNewChatInPane = useCallback(
    (paneId: string): void => {
      const layout = paneLayoutRef.current
      const pane = layout?.panes.find((p) => p.paneId === paneId) ?? null
      const path = pane?.workspacePath ?? activeWorkspace
      if (!path) return
      openRunTabInWorkspace(path, null, { syncLayout: false })
      if (layout && pane) {
        commitPaneLayout({
          ...layout,
          panes: layout.panes.map((p) =>
            p.paneId === paneId ? { ...p, workspacePath: path, runId: null } : p
          )
        })
        return
      }
      openRunTab(null)
    },
    [activeWorkspace, commitPaneLayout, openRunTab, openRunTabInWorkspace]
  )

  /**
   * Insert an empty draft pane beside the focused one. Refuses when the
   * focused pane is itself a draft — drafts share one composer/controller per
   * workspace, so two of them would edit the same text.
   */
  const splitFocusedPane = useCallback((): boolean => {
    const layout = paneLayoutRef.current
    const focused = layout
      ? (layout.panes.find((p) => p.paneId === layout.focusedPaneId) ??
        layout.panes[0] ??
        null)
      : null
    if (!focused || focused.runId == null) return false
    const next = insertDraftPaneBeside(
      layout!,
      focused.paneId,
      getMaxPaneCount()
    )
    if (!next) return false
    openRunTabInWorkspace(focused.workspacePath, null, { syncLayout: false })
    commitPaneLayout(next)
    return true
  }, [commitPaneLayout, getMaxPaneCount, openRunTabInWorkspace])

  const openRunInWorkspace = useCallback(
    async (path: string, runId: string): Promise<void> => {
      const multi = (paneLayoutRef.current?.panes.length ?? 0) > 1
      if (!multi) {
        if (!activeWorkspace || !workspacePathsEqual(activeWorkspace, path)) {
          await switchWorkspace(path)
        }
        openRunTabInWorkspace(path, runId)
        if (paneLayoutRef.current) {
          commitPaneLayout(
            syncSinglePaneSession(paneLayoutRef.current, path, runId)
          )
        }
        return
      }
      // Layout owns focus/replace; syncLayout here would replace the focused pane
      // before openRunInFocusedPane can focus an already-open session.
      openRunTabInWorkspace(path, runId, { syncLayout: false })
      const layout =
        paneLayoutRef.current ??
        singlePaneLayout(path, runId, createPaneId())
      commitPaneLayout(openRunInFocusedPane(layout, { workspacePath: path, runId }))
    },
    [activeWorkspace, commitPaneLayout, openRunTabInWorkspace, switchWorkspace]
  )

  /** New chat (runId null) in a specific workspace; switches there first when needed. */
  const newChatInWorkspace = useCallback(
    async (path: string): Promise<void> => {
      if (!activeWorkspace || !workspacePathsEqual(activeWorkspace, path)) {
        await switchWorkspace(path)
      }
      // Same session-replacement semantics as the top-bar + button (openRunTab(null)):
      // single pane syncs to (path, null); multi-pane replaces the focused pane.
      openRunTabInWorkspace(path, null)
    },
    [activeWorkspace, openRunTabInWorkspace, switchWorkspace]
  )

  const openSessionInFocusedPane = useCallback(
    (workspacePath: string, runId: string): void => {
      openRunTabInWorkspace(workspacePath, runId, { syncLayout: false })
      const layout =
        paneLayoutRef.current ??
        singlePaneLayout(workspacePath, runId, createPaneId())
      commitPaneLayout(openRunInFocusedPane(layout, { workspacePath, runId }))
    },
    [commitPaneLayout, openRunTabInWorkspace]
  )

  /**
   * True when runId is an inline agent instance: listed under the workspace,
   * or live in any parent controller's agentInstances snapshot.
   */
  const isInstanceRun = useCallback(
    (workspacePath: string | null, runId: string): boolean => {
      if (workspacePath) {
        const ctx =
          contextsRef.current[workspacePath] ??
          findByWorkspacePath(contextsRef.current, workspacePath)
        if (ctx?.instanceRuns?.some((r) => r.runId === runId)) return true
      }
      for (const ctrl of controllersRef.current.values()) {
        if (ctrl.agentInstances?.[runId]) return true
      }
      return false
    },
    []
  )

  /**
   * Parent runId for an inline instance: from the workspace listing, else the
   * controller whose agentInstances snapshot tracks it (that controller is the
   * parent). Null when unknown.
   */
  const getInstanceParentRunId = useCallback(
    (workspacePath: string | null, runId: string): string | null => {
      if (workspacePath) {
        const ctx =
          contextsRef.current[workspacePath] ??
          findByWorkspacePath(contextsRef.current, workspacePath)
        const listed = ctx?.instanceRuns?.find((r) => r.runId === runId)
        if (listed?.parentRunId) return listed.parentRunId
      }
      for (const ctrl of controllersRef.current.values()) {
        if (ctrl.agentInstances?.[runId]) return ctrl.runId
      }
      return null
    },
    []
  )

  const dropSessionOnPane = useCallback(
    (anchorPaneId: string, zone: PaneDropZone, payload: SessionDragPayload): boolean => {
      const layout = paneLayoutRef.current
      if (!layout) return false
      const next = applyPaneDrop(layout, anchorPaneId, zone, payload, getMaxPaneCount())
      if (!next) return false
      // Instance panes must not enter openRunIds/activeRunId — those are never
      // pruned for instance ids and would resurrect dead tabs after restart.
      if (!isInstanceRun(payload.workspacePath, payload.runId)) {
        openRunTabInWorkspace(payload.workspacePath, payload.runId, { syncLayout: false })
      }
      commitPaneLayout(next)
      return true
    },
    [commitPaneLayout, getMaxPaneCount, isInstanceRun, openRunTabInWorkspace]
  )

  const closePaneById = useCallback(
    (paneId: string): void => {
      const layout = paneLayoutRef.current
      if (!layout) return
      const next = closePaneInLayout(layout, paneId)
      commitPaneLayout(next)
      const remaining =
        next.panes.find((p) => p.paneId === next.focusedPaneId) ?? next.panes[0] ?? null
      if (remaining?.runId) {
        openRunTabInWorkspace(remaining.workspacePath, remaining.runId, {
          syncLayout: next.panes.length === 1
        })
      }
    },
    [commitPaneLayout, openRunTabInWorkspace]
  )

  const closeRunTab = useCallback(
    (runId: string): void => {
      const workspacePath = getFocusedPane()?.workspacePath ?? activeWorkspace
      if (!workspacePath) return
      const ctx =
        contextsRef.current[workspacePath] ??
        findByWorkspacePath(contextsRef.current, workspacePath)
      if (!ctx) return
      const entryKey =
        contextsRef.current[workspacePath] !== undefined
          ? workspacePath
          : (Object.keys(contextsRef.current).find((k) =>
              workspacePathsEqual(k, workspacePath)
            ) ?? workspacePath)
      const ctrl = controllersRef.current.get(runId)
      if (ctrl?.running || ctrl?.pendingRun) {
        backgroundRunIdsRef.current.add(runId)
        ctrl.setUiSuspended(true)
      } else {
        forgetRunRouting(runId)
      }
      const openRunIds = ctx.openRunIds.filter((id) => id !== runId)
      const activeRunId =
        ctx.activeRunId === runId ? openRunIds[openRunIds.length - 1] ?? null : ctx.activeRunId
      const nextCtx = { ...ctx, openRunIds, activeRunId }
      contextsRef.current = { ...contextsRef.current, [entryKey]: nextCtx }
      setContexts((prev) => ({
        ...prev,
        [entryKey]: nextCtx
      }))
      schedulePersistUiState(entryKey, nextCtx)
      const layout = paneLayoutRef.current
      if (layout) {
        commitPaneLayout(
          removeSessionFromLayout(layout, { workspacePath: entryKey, runId })
        )
      }
      if (activeRunId) {
        const nextCtrl = controllersRef.current.get(activeRunId)
        if (nextCtrl) void nextCtrl.resumeUiIfNeeded()
      }
      if (ctx.activeRunId === runId) {
        setChatSurfaceEpoch((t) => t + 1)
        setScrollRestoreToken((t) => t + 1)
      }
      bump()
    },
    [
      activeWorkspace,
      bump,
      commitPaneLayout,
      forgetRunRouting,
      getFocusedPane,
      schedulePersistUiState
    ]
  )

  const purgeDeletedRunUi = useCallback(
    (workspacePath: string, runId: string): void => {
      const ctx = contextsRef.current[workspacePath]
      const layout = paneLayoutRef.current
      if (layout) {
        // Deleting a parent cascades to its inline instances — close their
        // panes too, in one composed commit. Children are found via the
        // workspace listing; instances whose parent fell off the listing cap
        // keep their pane (their content still loads by id).
        const entryKey =
          contextsRef.current[workspacePath] !== undefined
            ? workspacePath
            : (Object.keys(contextsRef.current).find((k) =>
                workspacePathsEqual(k, workspacePath)
              ) ?? workspacePath)
        const childIds = new Set(
          (ctx?.instanceRuns ?? [])
            .filter((r) => r.parentRunId === runId)
            .map((r) => r.runId)
        )
        let next = removeSessionFromLayout(layout, { workspacePath: entryKey, runId })
        for (const pane of next.panes) {
          if (pane.runId && childIds.has(pane.runId)) {
            next = removeSessionFromLayout(next, { workspacePath: entryKey, runId: pane.runId })
          }
        }
        commitPaneLayout(next)
      }
      if (!ctx) {
        clearWorkspaceHotComposerDraft(workspacePath, runId)
        const attKey = composerAttachmentKey(workspacePath, runId)
        if (attKey) clearComposerAttachments(attKey)
        return
      }
      const scrollTopByRunId = omitRunScrollTop(ctx.ui.scrollTopByRunId, runId)
      const composerDraftByRunId = omitRunComposerDraft(ctx.ui.composerDraftByRunId, runId)
      const scrollChanged = scrollTopByRunId !== ctx.ui.scrollTopByRunId
      const draftChanged = composerDraftByRunId !== ctx.ui.composerDraftByRunId
      clearWorkspaceHotComposerDraft(workspacePath, runId)
      const attKey = composerAttachmentKey(workspacePath, runId)
      if (attKey) clearComposerAttachments(attKey)
      if (!scrollChanged && !draftChanged) return
      const nextCtx: WorkspaceContext = {
        ...ctx,
        ui: { ...ctx.ui, scrollTopByRunId, composerDraftByRunId }
      }
      contextsRef.current = { ...contextsRef.current, [workspacePath]: nextCtx }
      setContexts((prev) => ({ ...prev, [workspacePath]: nextCtx }))
      schedulePersistUiState(workspacePath, nextCtx)
    },
    [commitPaneLayout, schedulePersistUiState]
  )

  const setComposerDraftForPane = useCallback(
    (workspacePath: string, runId: string | null, draft: string): void => {
      const ctx = contextsRef.current[workspacePath]
      if (!ctx) return
      const key = draftKeyForRun(runId)
      const prev = resolveComposerDraft(ctx.ui, runId)
      if (prev === draft) return
      const composerDraftByRunId = { ...ctx.ui.composerDraftByRunId, [key]: draft }
      const composerDraft = runId ? ctx.ui.composerDraft : draft
      const nextCtx: WorkspaceContext = {
        ...ctx,
        ui: { ...ctx.ui, composerDraft, composerDraftByRunId }
      }
      contextsRef.current = {
        ...contextsRef.current,
        [workspacePath]: nextCtx
      }
      setContexts((prev) => ({ ...prev, [workspacePath]: nextCtx }))
      // Always write the typed draft for this run key — never leave hot UI on the legacy
      // workspace draft while composerDraftByRunId already has the keystroke.
      setWorkspaceHotComposerDraft(workspacePath, runId, draft)
      schedulePersistUiState(workspacePath, nextCtx)
    },
    [schedulePersistUiState]
  )

  const setComposerDraft = useCallback(
    (draft: string) => {
      const focused = getFocusedPane()
      const path = focused?.workspacePath ?? activeWorkspace
      if (!path) return
      setComposerDraftForPane(path, focused?.runId ?? null, draft)
    },
    [activeWorkspace, getFocusedPane, setComposerDraftForPane]
  )

  const setAgentMode = useCallback(
    (
      mode: AgentInteractionMode,
      options?: { syncOnly?: boolean; workspacePath?: string; runId?: string | null }
    ) => {
      const focused = getFocusedPane()
      const path = options?.workspacePath ?? focused?.workspacePath ?? activeWorkspace
      if (!path) return
      const ctx =
        contextsRef.current[path] ?? findByWorkspacePath(contextsRef.current, path)
      if (!ctx) return
      const storedPath =
        contextsRef.current[path] != null
          ? path
          : (Object.keys(contextsRef.current).find((key) =>
              workspacePathsEqual(key, path)
            ) ?? path)
      if (ctx.ui.agentMode === mode) return
      const runId =
        options?.runId !== undefined
          ? options.runId
          : options?.workspacePath
            ? ctx.activeRunId
            : (focused?.runId ?? ctx.activeRunId)
      const controller = runId ? controllersRef.current.get(runId) : undefined
      if (
        !options?.syncOnly &&
        runId &&
        controller?.running &&
        window.vyotiq?.chatQueueMode
      ) {
        void window.vyotiq.chatQueueMode({ runId, mode }).then((res) => {
          if (!res.ok) {
            logger.warn('Failed to queue run mode on main', {
              scope: 'chat',
              correlationId: runId,
              err: res.error
            })
          }
        })
      }
      const nextCtx: WorkspaceContext = {
        ...ctx,
        ui: { ...ctx.ui, agentMode: mode }
      }
      contextsRef.current = {
        ...contextsRef.current,
        [storedPath]: nextCtx
      }
      setContexts((prev) => ({ ...prev, [storedPath]: nextCtx }))
      schedulePersistUiState(storedPath, nextCtx)
    },
    [activeWorkspace, getFocusedPane, schedulePersistUiState]
  )

  const setAgentProfileIdForRun = useCallback(
    (workspacePath: string | null, runId: string | null, profileId: string | null) => {
      if (!workspacePath) return
      const ctx =
        contextsRef.current[workspacePath] ??
        findByWorkspacePath(contextsRef.current, workspacePath)
      if (!ctx) return
      const storedPath =
        contextsRef.current[workspacePath] != null
          ? workspacePath
          : (Object.keys(contextsRef.current).find((key) =>
              workspacePathsEqual(key, workspacePath)
            ) ?? workspacePath)
      const bucket = runId ?? DRAFT_SCROLL_KEY
      if (runId) {
        const durable = [...ctx.runs, ...ctx.olderRuns, ...ctx.instanceRuns].find(
          (run) => run.runId === runId
        )?.agentProfileId
        if (durable && durable !== profileId) return
      }
      const nextMap = { ...(ctx.ui.agentProfileIdByRunId ?? {}) }
      if ((nextMap[bucket] ?? null) === profileId) return
      if (profileId) nextMap[bucket] = profileId
      else delete nextMap[bucket]
      const nextCtx: WorkspaceContext = {
        ...ctx,
        ui: { ...ctx.ui, agentProfileIdByRunId: nextMap }
      }
      contextsRef.current = { ...contextsRef.current, [storedPath]: nextCtx }
      setContexts((prev) => ({ ...prev, [storedPath]: nextCtx }))
      schedulePersistUiState(storedPath, nextCtx)
      // Bind-time adoption: a teammate with a model pin seeds the session's
      // provider/model immediately (creation-time seeding already covers chats
      // that mount pre-bound). Session-scoped only — never the global default.
      if (profileId) {
        const pin = getAgentProfileModelPinRef.current?.(profileId)
        if (pin) ensureController(storedPath, runId).setProviderModel(pin.provider, pin.model)
      }
    },
    [ensureController, schedulePersistUiState]
  )

  const getAgentProfileIdForRun = useCallback(
    (workspacePath: string | null, runId: string | null): string | null => {
      if (!workspacePath) return null
      // Match the setter (and the rest of the codebase): a context stored
      // under a different spelling of the same path must still be found, or
      // the send silently drops the teammate binding.
      const ctx =
        contextsRef.current[workspacePath] ??
        findByWorkspacePath(contextsRef.current, workspacePath)
      return ctx?.ui.agentProfileIdByRunId?.[runId ?? DRAFT_SCROLL_KEY] ?? null
    },
    []
  )

  /**
   * Drop every chat binding whose profile id is no longer in the roster — a
   * deleted teammate must never ride a stale id into chatStart (main rejects
   * the whole send with 'Unknown agent profile'). Call when the roster loads
   * or changes. Unknown-bucket bindings for not-yet-loaded rosters are safe:
   * only pass the roster's own ids.
   */
  const pruneAgentProfileBindings = useCallback(
    (validIds: ReadonlySet<string>): void => {
      let changedAny = false
      const nextContexts: Record<string, WorkspaceContext> = { ...contextsRef.current }
      for (const [path, ctx] of Object.entries(nextContexts)) {
        const map = ctx.ui.agentProfileIdByRunId
        if (!map) continue
        const stale = Object.keys(map).filter((bucket) => !validIds.has(map[bucket]!))
        if (stale.length === 0) continue
        const nextMap = { ...map }
        for (const bucket of stale) delete nextMap[bucket]
        const nextCtx: WorkspaceContext = {
          ...ctx,
          ui: { ...ctx.ui, agentProfileIdByRunId: nextMap }
        }
        nextContexts[path] = nextCtx
        schedulePersistUiState(path, nextCtx)
        changedAny = true
      }
      if (changedAny) {
        contextsRef.current = nextContexts
        setContexts(nextContexts)
      }
    },
    [schedulePersistUiState]
  )

  const onMessageListScrollForPane = useCallback(
    (workspacePath: string, runId: string | null, scrollTop: number): void => {
      const ctx = contextsRef.current[workspacePath]
      if (!ctx) return
      const key = scrollKeyForRun(runId)
      if (ctx.ui.scrollTopByRunId[key] === scrollTop && ctx.ui.scrollTop === scrollTop) return
      const nextCtx: WorkspaceContext = {
        ...ctx,
        ui: {
          ...ctx.ui,
          scrollTop,
          scrollTopByRunId: { ...ctx.ui.scrollTopByRunId, [key]: scrollTop }
        }
      }
      contextsRef.current = { ...contextsRef.current, [workspacePath]: nextCtx }
      schedulePersistUiState(workspacePath, nextCtx)
    },
    [schedulePersistUiState]
  )

  const onMessageListScroll = useCallback(
    (scrollTop: number) => {
      const focused = getFocusedPane()
      const path = focused?.workspacePath ?? activeWorkspace
      if (!path) return
      onMessageListScrollForPane(path, focused?.runId ?? null, scrollTop)
    },
    [activeWorkspace, getFocusedPane, onMessageListScrollForPane]
  )

  const setSessionQuery = useCallback(
    (query: string): void => {
      if (!activeWorkspace) return
      const ctx = contextsRef.current[activeWorkspace]
      if (!ctx) return
      if (ctx.sessionQuery === query) return
      const nextCtx: WorkspaceContext = { ...ctx, sessionQuery: query }
      contextsRef.current = {
        ...contextsRef.current,
        [activeWorkspace]: nextCtx
      }
      setWorkspaceHotUi(activeWorkspace, { sessionQuery: query })
    },
    [activeWorkspace]
  )

  const setSettingsOverride = useCallback(
    async (
      path: string,
      override: WorkspaceSettingsOverride | null
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!window.vyotiq?.setWorkspaceSettingsOverride) {
        return { ok: false, error: 'Workspace settings API unavailable.' }
      }
      const res = await window.vyotiq.setWorkspaceSettingsOverride(path, override)
      if (!res.ok) return { ok: false, error: res.error }
      applyRegistry(res.data)
      bump()
      return { ok: true }
    },
    [applyRegistry, bump]
  )

  const focusedPane = getFocusedPane()
  const focusedWorkspacePath = focusedPane?.workspacePath ?? activeWorkspace
  const focusedRunId =
    focusedPane?.runId !== undefined
      ? focusedPane.runId
      : (activeContext?.activeRunId ?? null)

  const activeController = focusedWorkspacePath
    ? ensureController(focusedWorkspacePath, focusedRunId)
    : null

  const activeControllerRef = useRef(activeController)
  activeControllerRef.current = activeController

  const onLoadToolContent = useCallback(
    (toolCallId: string) =>
      activeControllerRef.current?.loadToolContent(toolCallId) ?? Promise.resolve(null),
    []
  )

  const onThinkingToggle = useCallback((messageId: string, expanded: boolean) => {
    activeControllerRef.current?.setThinkingExpanded(messageId, expanded)
  }, [])

  const onToolToggle = useCallback((toolCallId: string, expanded: boolean) => {
    activeControllerRef.current?.setToolExpanded(toolCallId, expanded)
  }, [])

  const onGroupToggle = useCallback((anchorToolCallId: string, expanded: boolean) => {
    activeControllerRef.current?.setGroupExpanded(anchorToolCallId, expanded)
  }, [])

  const onTurnToggle = useCallback((turnIndex: number) => {
    activeControllerRef.current?.toggleTurnCollapsed(turnIndex)
  }, [])

  const onApprovalDecision = useCallback(
    (requestId: string, decision: ToolApprovalDecision) =>
      activeControllerRef.current?.respondToApproval(requestId, decision) ?? Promise.resolve(),
    []
  )

  const onQuestionSubmit = useCallback(
    (requestId: string, answers: UiAgentQuestionAnswer[]) =>
      activeControllerRef.current?.respondToQuestion(requestId, answers) ?? Promise.resolve(),
    []
  )

  const subscribeActiveController = useCallback(
    (onStoreChange: () => void) => activeController?.subscribeMeta(onStoreChange) ?? (() => {}),
    [activeController]
  )

  const getActiveControllerRevision = useCallback(
    () => activeController?.getMetaRevision() ?? 0,
    [activeController]
  )

  useSyncExternalStore(
    subscribeActiveController,
    getActiveControllerRevision,
    getActiveControllerRevision
  )

  const chatSnapshot = activeController
    ? {
        items: activeController.items,
        messages: activeController.messages,
        running: activeController.running,
        invokeId: activeController.getInvokeId(),
        runId: activeController.runId,
        error: activeController.error,
        errorCode: activeController.errorCode,
        runNotice: activeController.runNotice,
        compacting: activeController.compacting,
        incomplete: activeController.incomplete,
        networkWait: activeController.networkWait,
        contextUsage: activeController.contextUsage,
        turnUsage: activeController.turnUsage,
        turnStatus: activeController.turnStatus,
        runStartedAt: activeController.runStartedAt,
        runTerminalTick: activeController.runTerminalTick,
        pendingRun: activeController.pendingRun,
        transcriptLoading: activeController.transcriptLoading,
        transcriptHasEarlier: activeController.transcriptHasEarlier,
        transcriptLoadingEarlier: activeController.transcriptLoadingEarlier,
        collapsedTurnIndices: activeController.collapsedTurnIndices,
        writeCheckpoint: activeController.writeCheckpoint,
        pendingFollowUps: activeController.pendingFollowUps,
        agentInstances: activeController.agentInstances,
        providerModel: activeController.providerModel,
        subscribeItems: chatStoresFor(activeController).subscribeItems,
        getItemsRevision: chatStoresFor(activeController).getItemsRevision,
        getItems: chatStoresFor(activeController).getItems,
        subscribeMeta: chatStoresFor(activeController).subscribeMeta,
        getMetaRevision: chatStoresFor(activeController).getMetaRevision,
        getContextUsage: chatStoresFor(activeController).getContextUsage,
        getTurnUsage: chatStoresFor(activeController).getTurnUsage,
        getCostHint: chatStoresFor(activeController).getCostHint,
        itemsStore: chatStoresFor(activeController).itemsStore,
        metaStore: chatStoresFor(activeController).metaStore
      }
    : {
        items: [] as ChatStreamController['items'],
        messages: [] as ChatStreamController['messages'],
        running: false,
        invokeId: null as number | null,
        runId: null as string | null,
        error: null as string | null,
        errorCode: null as string | null,
        runNotice: null as string | null,
        compacting: false,
        incomplete: null as ChatStreamController['incomplete'],
        networkWait: null as ChatStreamController['networkWait'],
        contextUsage: null,
        turnUsage: [] as ChatStreamController['turnUsage'],
        turnStatus: null as ChatStreamController['turnStatus'],
        runStartedAt: null as number | null,
        runTerminalTick: 0,
        pendingRun: false,
        transcriptLoading: false,
        transcriptHasEarlier: false,
        transcriptLoadingEarlier: false,
        collapsedTurnIndices: [] as number[],
        writeCheckpoint: null as ChatStreamController['writeCheckpoint'],
        pendingFollowUps: [] as ChatStreamController['pendingFollowUps'],
        agentInstances: {} as ChatStreamController['agentInstances'],
        providerModel: null as ChatStreamController['providerModel'],
        subscribeItems: EMPTY_CHAT_STORE.subscribeItems,
        getItemsRevision: EMPTY_CHAT_STORE.getItemsRevision,
        getItems: EMPTY_CHAT_STORE.getItems,
        subscribeMeta: EMPTY_CHAT_STORE.subscribeMeta,
        getMetaRevision: EMPTY_CHAT_STORE.getMetaRevision,
        getContextUsage: EMPTY_CHAT_STORE.getContextUsage,
        getTurnUsage: EMPTY_CHAT_STORE.getTurnUsage,
        getCostHint: EMPTY_CHAT_STORE.getCostHint,
        itemsStore: EMPTY_CHAT_STORE.itemsStore,
        metaStore: EMPTY_CHAT_STORE.metaStore
      }

  const collapsedTurns = useMemo(
    () =>
      chatSnapshot.collapsedTurnIndices.length > 0
        ? new Set(chatSnapshot.collapsedTurnIndices)
        : undefined,
    [chatSnapshot.collapsedTurnIndices]
  )

  void revision

  const refreshActiveRuns = useCallback(() => {
    if (activeWorkspace) void refreshRuns(activeWorkspace)
  }, [activeWorkspace, refreshRuns])

  const refreshWorkspaceRuns = useCallback(
    (workspacePath: string): void => {
      void refreshRuns(workspacePath)
    },
    [refreshRuns]
  )

  /**
   * Load one older page of runs beyond the sidebar cap. Pages accumulate in
   * `olderRuns` (deduped by runId against `runs` and each other) and survive
   * refreshRuns, which only rewrites the fresh top cap.
   */
  const loadOlderRuns = useCallback(async (workspacePath: string): Promise<void> => {
    if (!workspacePath.trim()) return
    if (!window.vyotiq?.listOlderRuns) return
    const ctx = contextsRef.current[workspacePath]
    if (!ctx) return
    const allKnown = [...ctx.runs, ...ctx.olderRuns].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    )
    const cursor = allKnown.at(-1)?.updatedAt
    if (!cursor) return
    const res = await window.vyotiq.listOlderRuns(workspacePath, cursor)
    if (!res.ok) {
      logger.warn('listOlderRuns failed', { scope: 'runs', err: toLogErr(res.error) })
      return
    }
    setContexts((prev) => {
      const current = prev[workspacePath]
      if (!current) return prev
      const seen = new Set(current.runs.map((r) => r.runId))
      for (const r of current.olderRuns) seen.add(r.runId)
      const deduped = res.data.runs.filter((r) => !seen.has(r.runId))
      const validProfileIds = getValidAgentProfileIdsRef.current?.() ?? null
      const hydratedBindings = { ...current.ui.agentProfileIdByRunId }
      let bindingsChanged = false
      if (validProfileIds) {
        for (const run of deduped) {
          if (
            run.agentProfileId &&
            validProfileIds.has(run.agentProfileId) &&
            hydratedBindings[run.runId] == null
          ) {
            hydratedBindings[run.runId] = run.agentProfileId
            bindingsChanged = true
          }
        }
      }
      const nextCtx: WorkspaceContext = {
        ...current,
        olderRuns: [...current.olderRuns, ...deduped],
        runsCapped: res.data.hasMore,
        ...(bindingsChanged
          ? { ui: { ...current.ui, agentProfileIdByRunId: hydratedBindings } }
          : {})
      }
      contextsRef.current = { ...contextsRef.current, [workspacePath]: nextCtx }
      if (bindingsChanged) schedulePersistUiState(workspacePath, nextCtx)
      return { ...prev, [workspacePath]: nextCtx }
    })
  }, [schedulePersistUiState])

  useEffect(() => {
    if (!activeWorkspace) return
    const timer = window.setTimeout(() => {
      void refreshRuns(activeWorkspace)
    }, LIST_RUNS_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [activeWorkspace, chatSnapshot.runTerminalTick, refreshRuns])

  const isRunActiveInBackground = useCallback(
    (runId: string): boolean => backgroundRunIdsRef.current.has(runId),
    []
  )

  const workspaceHasBackgroundRun = useCallback(
    (workspacePath: string): boolean => {
      return activeRuns.some(
        (r) =>
          workspacePathsEqual(r.workspacePath, workspacePath) &&
          (backgroundRunIdsRef.current.has(r.runId) ||
            !contexts[workspacePath]?.openRunIds.includes(r.runId))
      )
    },
    [activeRuns, contexts]
  )

  const clearRunsError = useCallback((workspacePath?: string) => {
    const path = workspacePath ?? activeWorkspace
    if (!path) return
    setContexts((prev) => {
      const ctx = prev[path]
      if (!ctx || !ctx.runsError) return prev
      return {
        ...prev,
        [path]: { ...ctx, runsError: null }
      }
    })
  }, [activeWorkspace])

  const clearWorkspaceError = useCallback(() => setWorkspaceError(null), [])

  const activeScrollTop = focusedWorkspacePath
    ? (() => {
        const ctx = findByWorkspacePath(contexts, focusedWorkspacePath)
        if (!ctx) return undefined
        const key = scrollKeyForRun(focusedRunId)
        if (key in ctx.ui.scrollTopByRunId) return ctx.ui.scrollTopByRunId[key]
        if (Object.keys(ctx.ui.scrollTopByRunId).length === 0 && ctx.ui.scrollTop > 0) {
          return ctx.ui.scrollTop
        }
        return undefined
      })()
    : undefined

  const getPaneChatSnapshot = useCallback(
    (workspacePath: string, runId: string | null) => {
      const ctrl = ensureController(workspacePath, runId)
      return {
        items: ctrl.items,
        messages: ctrl.messages,
        running: ctrl.running,
        invokeId: ctrl.getInvokeId(),
        runId: ctrl.runId,
        error: ctrl.error,
        errorCode: ctrl.errorCode,
        runNotice: ctrl.runNotice,
        compacting: ctrl.compacting,
        incomplete: ctrl.incomplete,
        networkWait: ctrl.networkWait,
        contextUsage: ctrl.contextUsage,
        turnUsage: ctrl.turnUsage,
        turnStatus: ctrl.turnStatus,
        runStartedAt: ctrl.runStartedAt,
        runTerminalTick: ctrl.runTerminalTick,
        pendingRun: ctrl.pendingRun,
        transcriptLoading: ctrl.transcriptLoading,
        transcriptHasEarlier: ctrl.transcriptHasEarlier,
        transcriptLoadingEarlier: ctrl.transcriptLoadingEarlier,
        collapsedTurnIndices: ctrl.collapsedTurnIndices,
        writeCheckpoint: ctrl.writeCheckpoint,
        pendingFollowUps: ctrl.pendingFollowUps,
        agentInstances: ctrl.agentInstances,
        providerModel: ctrl.providerModel,
        subscribeItems: chatStoresFor(ctrl).subscribeItems,
        getItemsRevision: chatStoresFor(ctrl).getItemsRevision,
        getItems: chatStoresFor(ctrl).getItems,
        subscribeMeta: chatStoresFor(ctrl).subscribeMeta,
        getMetaRevision: chatStoresFor(ctrl).getMetaRevision,
        getContextUsage: chatStoresFor(ctrl).getContextUsage,
        getTurnUsage: chatStoresFor(ctrl).getTurnUsage,
        getCostHint: chatStoresFor(ctrl).getCostHint,
        itemsStore: chatStoresFor(ctrl).itemsStore,
        metaStore: chatStoresFor(ctrl).metaStore
      }
    },
    [ensureController]
  )

  const chatActions = useMemo(
    () =>
      activeController
        ? {
            send: activeController.send.bind(activeController),
            editAndResend: activeController.editAndResend.bind(activeController),
            revertToUserMessage: activeController.revertToUserMessage.bind(activeController),
            previewRewindToUserMessage: activeController.previewRewindToUserMessage.bind(
              activeController
            ),
            removeFollowUp: activeController.removeFollowUp.bind(activeController),
            editFollowUp: activeController.editFollowUp.bind(activeController),
            sendFollowUpNow: activeController.sendFollowUpNow.bind(activeController),
            stop: activeController.stop.bind(activeController),
            resumeInterrupted: activeController.resumeInterrupted.bind(activeController),
            reset: activeController.reset.bind(activeController),
            loadTranscript: activeController.loadTranscript.bind(activeController),
            loadToolContent: activeController.loadToolContent.bind(activeController),
            clearError: activeController.clearError.bind(activeController),
            applyManualCompaction: activeController.applyManualCompaction.bind(activeController),
            setCompacting: activeController.setCompacting.bind(activeController),
            applyWriteCheckpointResolution:
              activeController.applyWriteCheckpointResolution.bind(activeController),
            loadEarlierMessages: activeController.loadEarlierMessages.bind(activeController)
          }
        : null,
    [activeController]
  )

  return {
    registry,
    activeWorkspace,
    openWorkspaces,
    activeContext,
    contexts,
    activeController,
    activeRuns,
    chat: chatSnapshot,
    switchWorkspace,
    addWorkspace,
    removeWorkspace,
    setAgentProfileIdForRun,
    getAgentProfileIdForRun,
    pruneAgentProfileBindings,
    workspaceExpandedByPath,
    setWorkspaceExpanded,
    getRunController,
    loadRunIntoTab,
    openRunTab,
    openRunInWorkspace,
    newChatInWorkspace,
    closeRunTab,
    setSessionQuery,
    refreshActiveRuns,
    refreshWorkspaceRuns,
    loadOlderRuns,
    isRunActiveInBackground,
    workspaceHasBackgroundRun,
    scrollRestoreToken,
    chatSurfaceEpoch,
    activeScrollTop,
    workspaceError,
    clearWorkspaceError,
    clearRunsError,
    setComposerDraft,
    setComposerDraftForPane,
    setAgentMode,
    onMessageListScroll,
    onMessageListScrollForPane,
    setSettingsOverride,
    onLoadToolContent,
    onThinkingToggle,
    onToolToggle,
    onGroupToggle,
    onTurnToggle,
    onApprovalDecision,
    onQuestionSubmit,
    collapsedTurns,
    chatActions,
    purgeDeletedRunUi,
    paneLayout,
    isMultiPane,
    focusPaneById,
    closePaneById,
    setPaneSizesByIndex,
    dropSessionOnPane,
    splitFocusedPane,
    isInstanceRun,
    getInstanceParentRunId,
    openSessionInFocusedPane,
    isSessionOpenInPane,
    isSessionFocusedInPane,
    getFocusedPane,
    getPaneById,
    openNewChatInPane,
    getPaneChatSnapshot,
    getMaxPaneCount,
    setPaneCapacityContext,
    focusedWorkspacePath,
    focusedRunId
  }
}
