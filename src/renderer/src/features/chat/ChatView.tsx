import type { Ref } from 'react'
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MessageList } from './components/MessageList'
import { AgentBrowserPanel } from './components/AgentBrowserPanel'
import type { WorkspaceFileOpenRequest } from './components/FilesPanel'
import { ChangesPanel } from './components/ChangesPanel'
import { ConfirmFileList } from './components/ConfirmFileList'
import { PlanPanel } from './components/PlanPanel'
import {
  ChatSideRail,
  RAIL_DETAIL_MAX,
  type RailPanelState
} from './components/ChatSideRail'
import { DockTabBar, AGENT_DOCK_TAB, defaultDockTab } from './components/DockTabBar'
import { isPlanDraftReady } from './utils/planDraft'
import { Composer } from './components/composer'
import { RunSessionProvider } from './RunSessionContext'
import { AgentInstancePane } from './components/AgentInstancePane'
import { ChatTranscriptStage } from './components/ChatTranscriptStage'
import { useInlineInstanceUi } from './hooks/useInlineInstanceUi'
import { useRunGoal } from './hooks/useRunGoal'
import { useRunFeedback } from './hooks/useRunFeedback'
import {
  type AgentInstanceUiState
} from '@shared/utils/agentInstance'
import {
  useControllerWriteCheckpoint,
  useAgentFileFocus,
  useAgentLiveActivity,
  useGitRevision,
  useHasChatItems,
  useHasCreatePlanCall
} from './components/ChatStreamLeaves'
import { useGitChrome } from './components/GitChrome'
import type { UiAgentQuestionAnswer, UiItem } from '@shared/transcript'
import type {
  AgentBrowserState,
  AgentInteractionMode,
  ChatMessage,
  ProviderId,
  PtySessionInfo,
  ToolApprovalDecision,
  WorkspaceEditorRecoveryLoadResult
} from '@shared/ipc'
import type { ChatSettingsPatch, EffectiveChatSettings } from '@shared/effectiveSettings'
import { useChatErrorSurfaces } from './hooks/composerShared'
import { Alert, PanelResizeHandle, pushToast } from '@renderer/lib/ui'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import { usePersistedBoolean } from '@renderer/lib/hooks/usePersistedBoolean'
import { usePersistedNumber } from '@renderer/lib/hooks/usePersistedNumber'
import { setDockImmersive } from '@renderer/lib/hooks/dockImmersiveStore'
import {
  TitleBarBandSpent,
  useTitleBarAccessory,
  useTitleBarBand
} from '@renderer/lib/context/TitleBarAccessory'
import {
  BROWSER_PANEL_OPEN_KEY,
  CHAT_RIGHT_PANEL,
  CHAT_RIGHT_PANEL_IDS,
  DOCK_EXPANDED_KEY,
  DOCK_WIDTH_DEFAULT_PX,
  DOCK_WIDTH_KEY,
  DOCK_WIDTH_MAX_PX,
  DOCK_WIDTH_MIN_PX,
  IMMERSIVE_TAB_KEY,
  RIGHT_PANEL_KEY,
  TITLE_BAR_HEIGHT,
  WINDOW_CONTROLS_WIDTH_PX,
  clampDockWidthPx,
  readSidebarWidthPxForCapacity,
  isChatRightPanelId,
  showsWindowControls,
  windowControlsReservePx,
  type ChatRightPanelId,
  type DockImmersiveTabId
} from '@renderer/lib/utils/layout'
import { PANEL_SHORTCUT } from '@renderer/lib/utils/dockPanels'
import { formatPathLabel, truncateMiddle } from '@shared/utils/displayPath'
import { toWorkspaceRelPath } from '@shared/utils/workspacePath'
import { cn } from '@renderer/lib/ui/cn'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { matchShortcut, shouldBlockPanelShortcut } from '@renderer/lib/shortcuts'
import type { ChatItemsStore, ChatMetaStore } from './chatStores'
import type { StepUsageTotals } from '@shared/utils/runTelemetry'
import { ChatPaneHost, type PaneRenderOptions } from './ChatPaneHost'
import {
  buildComposerSendProps,
  lastUserMessageIndex,
  useComposerEditState
} from './hooks/composerShared'
import type { PaneCapacityContext } from '@renderer/lib/hooks/useWorkspaceManager'
import type { ChatPane, PaneDropZone } from '@renderer/lib/chat/chatPaneLayout'



/** Heavy dock panels are code-split: xterm/CodeMirror/PR tooling parse on first open. */
const FilesPanel = lazy(() =>
  import('./components/FilesPanel').then((m) => ({ default: m.FilesPanel }))
)
const TerminalPanel = lazy(() =>
  import('./components/TerminalPanel').then((m) => ({ default: m.TerminalPanel }))
)
const PrPanel = lazy(() => import('./components/PrPanel').then((m) => ({ default: m.PrPanel })))

function DockPanelSuspenseFallback() {
  return <div className="min-h-0 min-w-0 flex-1 animate-pulse bg-surface/40" aria-busy="true" />
}

const MemoComposer = memo(Composer)

export function ChatView({
  items,
  itemsStore,
  metaStore,
  running,
  invokeId = null,
  pendingRun = false,
  error,
  errorCode = null,
  networkWait = null,
  compacting = false,
  incomplete,
  turnStatus = null,
  onContinue,
  contextUsage,
  turnUsage,
  onCompactContext,
  operationalError,
  hasWorkspace,
  workspacePath,
  writeConflictedPaths,
  provider,
  model,
  ollamaBaseUrl,
  customOpenAiBaseUrl,
  modelsRefreshKey,
  secrets,
  activeRunId,
  transcriptLoading,
  transcriptHasEarlier,
  transcriptLoadingEarlier,
  onLoadEarlierMessages,
  headingRef,
  onProviderModel,
  favoriteModels = [],
  recentModels = [],
  serviceTier = 'default',
  onToggleFavorite = () => {},
  onServiceTierChange = () => {},
  chatSettings,
  onChatSettingsChange,
  agentMode = 'agent',
  onAgentModeChange = () => {},
  onSend,
  onStop,
  onEditAndResend,
  onRevertToUserMessage,
  messages = [],
  pendingFollowUps = [],
  onRemoveFollowUp,
  onEditFollowUp,
  onSendFollowUpNow,
  onDismissError,
  composerDraft,
  onComposerDraftChange,
  restoreScrollTop,
  scrollRestoreToken,
  onScrollTopChange,
  onLoadToolContent,
  onThinkingToggle,
  onToolToggle,
  onGroupToggle,
  onTurnToggle,
  onDismissRunError,
  onApprovalDecision,
  onQuestionSubmit,
  collapsedTurns,
  showThinking = true,
  chatSurfaceEpoch = 0,
  mcpServerNames,
  slashHandlers,
  canUndoWrites = false,
  undoBusy = false,
  onUndoWrites,
  writeFileResolutions,
  writeResolvablePaths,
  writeCheckpointFiles,
  onKeepWriteFile,
  onDiscardWriteFile,
  onKeepAllWrites,
  resolveBlockedReason = null,
  multiPane = null,
  paneCount: paneCountProp = 1,
  onPaneCapacityChange,
  agentInstances,
  openInstanceRunId: openInstanceRunIdProp = null,
  onOpenInstanceRunIdChange,
  getInstanceController,
  openChangesRequest = 0,
  onOpenChangesRequestHandled
}: {
  items: UiItem[]
  /** When set, transcript leaves subscribe so ChatView/Composer skip token patches. */
  itemsStore?: ChatItemsStore
  /** When set, ContextMeter reads usage via meta store (skips prop fanout). */
  metaStore?: ChatMetaStore
  running: boolean
  /** Live chatStart invoke id — PlanPanel uses it to detect stale receipts. */
  invokeId?: number | null
  pendingRun?: boolean
  error: string | null
  errorCode?: string | null
  networkWait?: {
    attempt: number
    maxAttempts: number
    retryInMs: number
    code?: string
  } | null
  compacting?: boolean
  incomplete?: import('@renderer/lib/hooks/createChatStreamController').IncompleteTurnState | null
  turnStatus?: import('@shared/transcript').TurnOutcome | null
  onContinue?: () => void
  contextUsage?: import('./components/composer/ContextMeter').ContextUsageState | null
  turnUsage?: readonly StepUsageTotals[]
  onCompactContext?: (
    focus?: string
  ) => Promise<{ ok: true; message: string } | { ok: false; message: string }>
  operationalError?: string | null
  hasWorkspace: boolean
  workspacePath: string | null
  provider: ProviderId
  model: string
  ollamaBaseUrl?: string
  customOpenAiBaseUrl?: string
  modelsRefreshKey?: string | number
  secrets: Record<import('@shared/ipc').SecretProvider, boolean>
  activeRunId: string | null
  transcriptLoading?: boolean
  transcriptHasEarlier?: boolean
  transcriptLoadingEarlier?: boolean
  onLoadEarlierMessages?: () => void | Promise<void>
  headingRef?: Ref<HTMLHeadingElement>
  onProviderModel: (provider: ProviderId, model: string) => void
  favoriteModels?: string[]
  recentModels?: string[]
  serviceTier?: import('@shared/ipc').ServiceTier
  onToggleFavorite?: (provider: ProviderId, model: string) => void
  onServiceTierChange?: (tier: import('@shared/ipc').ServiceTier) => void
  chatSettings: EffectiveChatSettings
  onChatSettingsChange: (patch: ChatSettingsPatch) => void
  agentMode?: AgentInteractionMode
  onAgentModeChange?: (mode: AgentInteractionMode) => void
  onSend: (
    text: string,
    images?: string[],
    files?: import('@shared/ipc').AttachedFile[],
    extras?: import('@shared/ipc').ComposerSendExtras
  ) => boolean | void | Promise<boolean | void>
  onEditAndResend?: (
    editMessageIndex: number,
    text: string,
    images?: string[],
    files?: import('@shared/ipc').AttachedFile[],
    extras?: import('@shared/ipc').ComposerSendExtras
  ) => boolean | void | Promise<boolean | void>
  onRevertToUserMessage?: (userMessageIndex: number) => boolean | Promise<boolean>
  /** Full chat messages for seeding inline edit attachments. */
  messages?: ChatMessage[]
  onStop: () => void
  pendingFollowUps?: import('@renderer/lib/hooks/createChatStreamController').PendingFollowUpState[]
  onRemoveFollowUp?: (id: string) => void
  onEditFollowUp?: (id: string, text: string) => boolean | Promise<boolean>
  onSendFollowUpNow?: (id: string) => void
  onDismissError?: () => void
  composerDraft?: string
  onComposerDraftChange?: (draft: string) => void
  restoreScrollTop?: number
  scrollRestoreToken?: number
  onScrollTopChange?: (scrollTop: number) => void
  onLoadToolContent?: (toolCallId: string) => Promise<string | null>
  onThinkingToggle?: (messageId: string, expanded: boolean) => void
  onToolToggle?: (toolCallId: string, expanded: boolean) => void
  onGroupToggle?: (anchorToolCallId: string, expanded: boolean) => void
  onTurnToggle?: (turnIndex: number) => void
  /** Dismiss (and remember) one run_error row in the transcript. */
  onDismissRunError?: (itemId: string) => void
  onApprovalDecision?: (requestId: string, decision: ToolApprovalDecision) => void | Promise<void>
  onQuestionSubmit?: (requestId: string, answers: UiAgentQuestionAnswer[]) => void | Promise<void>
  collapsedTurns?: ReadonlySet<number>
  showThinking?: boolean
  mcpServerNames?: ReadonlyMap<string, string>
  /**
   * Bumps on workspace / run-tab switches (not draft→run id assignment) so the
   * transcript and composer remount without clearing mid-send attachments.
   */
  chatSurfaceEpoch?: number
  slashHandlers?: import('./components/composer/slashCommandExecute').SlashClientHandlers
  canUndoWrites?: boolean
  undoBusy?: boolean
  onUndoWrites?: () => void | Promise<unknown>
  writeFileResolutions?: ReadonlyMap<string, 'kept' | 'discarded' | undefined>
  writeResolvablePaths?: ReadonlySet<string>
  writeConflictedPaths?: ReadonlySet<string> | undefined
  writeCheckpointFiles?: ReadonlyArray<{
    path: string
    action: 'created' | 'modified' | 'deleted'
  }>
  onKeepWriteFile?: (path: string) => void | Promise<unknown>
  onDiscardWriteFile?: (path: string) => void | Promise<unknown>
  onKeepAllWrites?: () => void | Promise<unknown>
  resolveBlockedReason?: string | null
  multiPane?: {
    panes: ChatPane[]
    focusedPaneId: string
    sizes: number[]
    onFocusPane: (paneId: string) => void
    onClosePane: (paneId: string) => void
    onSizesChange: (sizes: number[]) => void
    onSessionDrop: (
      anchorPaneId: string,
      zone: PaneDropZone,
      payload: { workspacePath: string; runId: string }
    ) => boolean
    onSplitPane?: () => void
    getPaneTitle: (pane: ChatPane) => string
    renderPane: (pane: ChatPane, options: PaneRenderOptions) => React.ReactNode
  } | null
  paneCount?: number
  onPaneCapacityChange?: (ctx: PaneCapacityContext) => void
  agentInstances?: Record<string, AgentInstanceUiState>
  /** Controlled open instance sub-session (sidebar / parent shared). */
  openInstanceRunId?: string | null
  onOpenInstanceRunIdChange?: (runId: string | null) => void
  getInstanceController?: (
    runId: string,
    workspacePath: string
  ) => import('@renderer/lib/hooks/createChatStreamController').ChatStreamController | null
  openChangesRequest?: number
  /** One-shot consumption ack — the owner resets the request so a remount cannot replay it. */
  onOpenChangesRequestHandled?: () => void
}) {
  const paneCount = paneCountProp ?? multiPane?.panes.length ?? 1
  const instanceOpenControlled =
    onOpenInstanceRunIdChange != null
      ? {
          openInstanceRunId: openInstanceRunIdProp,
          setOpenInstanceRunId: onOpenInstanceRunIdChange
        }
      : undefined
  const {
    openInstanceRunId: viewingInstanceRunId,
    openInstancePane,
    closeInstancePane,
    pendingGates
  } = useInlineInstanceUi(agentInstances, activeRunId, instanceOpenControlled)

  // The dock Changes panel must reflect the instance run being viewed — the
  // parent run's items never contain the child's tool rows or write checkpoint.
  const [instancePaneController, setInstancePaneController] = useState<
    import('@renderer/lib/hooks/createChatStreamController').ChatStreamController | null
  >(null)
  const instanceItemsStore = useMemo<ChatItemsStore | undefined>(() => {
    if (!instancePaneController) return undefined
    return {
      subscribeItems: instancePaneController.subscribeItems.bind(instancePaneController),
      getItemsRevision: instancePaneController.getItemsRevision.bind(instancePaneController),
      getItems: () => instancePaneController.items
    }
  }, [instancePaneController])
  const instanceWriteCheckpoint = useControllerWriteCheckpoint(instancePaneController)
  const instanceWriteCheckpointFiles = useMemo(() => {
    const files = instanceWriteCheckpoint?.files
    if (!files?.length || instanceWriteCheckpoint?.undone) return undefined
    return files.map((f) => ({ path: f.path, action: f.action }))
  }, [instanceWriteCheckpoint])

const runGoal = useRunGoal({
  workspacePath,
  runId: activeRunId,
  running,
  active: true
})
  const runFeedback = useRunFeedback(workspacePath, activeRunId, !running)
  const onOpenAgentInstance = useMemo(
    () =>
      workspacePath != null
        ? (instanceRunId: string) => openInstancePane(instanceRunId)
        : undefined,
    [openInstancePane, workspacePath]
  )
  const [activeRightPanel, setActiveRightPanel] = useState<ChatRightPanelId | null>(() => {
    try {
      const raw = localStorage.getItem(RIGHT_PANEL_KEY)
      // Restore the last panel, but never auto-open the Files panel (file
      // explorer + editor) on startup — it only opens when the user opens it.
      if (isChatRightPanelId(raw) && raw !== 'files') return raw
      // Migrate legacy browser-open preference.
      const legacy = localStorage.getItem(BROWSER_PANEL_OPEN_KEY)
      if (legacy === '1' || legacy === 'true') return 'browser'
    } catch {
      /* ignore */
    }
    return null
  })
  const [requestedFilePath, setRequestedFilePath] =
    useState<WorkspaceFileOpenRequest | null>(null)
  const [pendingFilesRecovery, setPendingFilesRecovery] = useState<{
    workspacePath: string
    data: WorkspaceEditorRecoveryLoadResult
  } | null>(null)
  const handleFilesRecoveryConsumed = useCallback((consumedWorkspacePath: string): void => {
    setPendingFilesRecovery((pending) =>
      pending?.workspacePath === consumedWorkspacePath ? null : pending
    )
  }, [])
  useEffect(() => {
    setPendingFilesRecovery((pending) =>
      pending && pending.workspacePath !== workspacePath ? null : pending
    )
  }, [workspacePath])
  const clampDock = useCallback(
    (width: number) =>
      clampDockWidthPx(width, undefined, {
        paneCount,
        sidebarWidthPx: readSidebarWidthPxForCapacity(),
        // Dock width is only shown while open; rail is hidden then.
        dockOpen: true
      }),
    [paneCount]
  )
  // Boolean presence only — stays Object.is-stable across pure text_delta frames.
  // Item subscription stays on the leaves (MessageList/ChangesPanel); ChatView
  // reads only Object.is-stable booleans so token patches skip these levels.
  const hasItems = useHasChatItems(itemsStore, items)
  const { chatBannerError, turnFailed, turnFailureLabel } = useChatErrorSurfaces({
    itemsStore,
    items,
    error,
    errorCode,
    incomplete,
    turnStatus
  })
  const operationalBannerError = operationalError ?? null
  const surfaceKey = `${workspacePath ?? 'none'}:${chatSurfaceEpoch}`
  const [prNumber, setPrNumber] = useState<number | null>(null)
  /** Accumulated dock title tabs (multi-panel strip). */
  const [dockTabs, setDockTabs] = useState<ChatRightPanelId[]>(() =>
    activeRightPanel ? [activeRightPanel] : []
  )
  /** Keep panels mounted (hidden) when switching so PTY/browser state survives. */
  const [mountedPanels, setMountedPanels] = useState<ChatRightPanelId[]>(() =>
    activeRightPanel ? [activeRightPanel] : []
  )
  const [dockWidthPx, setDockWidthPx] = usePersistedNumber(
    DOCK_WIDTH_KEY,
    DOCK_WIDTH_DEFAULT_PX,
    clampDock
  )
  /** Immersive unified tabs (Expand panel) — not a wider side dock. */
  const [dockExpanded, setDockExpanded] = usePersistedBoolean(DOCK_EXPANDED_KEY, false)
  const [immersiveTab, setImmersiveTabState] = useState<DockImmersiveTabId>(() => {
    try {
      const raw = localStorage.getItem(IMMERSIVE_TAB_KEY)
      if (raw === 'agent' || isChatRightPanelId(raw)) return raw
    } catch {
      /* ignore */
    }
    return activeRightPanel ?? 'agent'
  })
  const setImmersiveTab = useCallback((next: DockImmersiveTabId | ((prev: DockImmersiveTabId) => DockImmersiveTabId)) => {
    setImmersiveTabState((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next
      try {
        localStorage.setItem(IMMERSIVE_TAB_KEY, resolved)
      } catch {
        /* ignore */
      }
      return resolved
    })
  }, [])
  const dockMaxPx = clampDock(DOCK_WIDTH_MAX_PX)
  const dockImmersive = dockExpanded && dockTabs.length > 0
  const { host: titleBarHost, setOccupied: setTitleBarOccupied } = useTitleBarAccessory()
  const dockSideTitleBar = activeRightPanel != null && !dockImmersive && titleBarHost != null

  useEffect(() => {
    setDockImmersive(dockImmersive)
    return () => setDockImmersive(false)
  }, [dockImmersive])

  const sideDockTitleBarWidthPx = Math.max(
    DOCK_WIDTH_MIN_PX - WINDOW_CONTROLS_WIDTH_PX,
    dockWidthPx - (showsWindowControls() ? WINDOW_CONTROLS_WIDTH_PX : 0)
  )

  /**
   * Dock tabs live in the title-bar band, so the chat surface starts below it.
   * With no tabs the band stays empty and the surface runs to the window's top
   * edge — which is what any chrome pinned there has to reckon with
   * (`useTitleBarBand`).
   */
  const titleBarBandTaken = dockImmersive || dockSideTitleBar

  useLayoutEffect(() => {
    setTitleBarOccupied(titleBarBandTaken)
  }, [titleBarBandTaken, setTitleBarOccupied])
  useEffect(() => {
    return () => setTitleBarOccupied(false)
  }, [setTitleBarOccupied])

  /** Session-scoped: skip auto-open after the user closes a panel until they open it again. */
  const dismissedPanelsRef = useRef<Set<ChatRightPanelId>>(new Set())
  const [gitRevision, bumpGitRevision] = useGitRevision(
    workspacePath,
    running,
    items,
    itemsStore
  )
  /** Drives the Files panel's follow mode: the file the run is writing now. */
  const agentFileFocus = useAgentFileFocus(running, items, itemsStore)
  /** Drives the side rail's live markers: what the run has in flight. */
  const liveActivity = useAgentLiveActivity(running, items, itemsStore)
  /** Gates the plan panel's auto-open — replaced the old `agentMode === 'plan'` check. */
  const hasCreatePlanCall = useHasCreatePlanCall(itemsStore, items)
  const filesFlushRef = useRef<(() => Promise<boolean>) | null>(null)
  const registerFilesFlush = useCallback(
    (flush: (() => Promise<boolean>) | null): void => {
      filesFlushRef.current = flush
    },
    []
  )
  const flushDirtyFiles = useCallback(async (): Promise<boolean> => {
    return filesFlushRef.current ? filesFlushRef.current() : true
  }, [])
  useEffect(() => {
    const onFlushRequest = window.vyotiq?.onWorkspaceEditorFlushRequest
    const respond = window.vyotiq?.respondWorkspaceEditorFlush
    if (!onFlushRequest || !respond) return undefined
    return onFlushRequest((requestId) => {
      void flushDirtyFiles()
        .then((ok) => respond(requestId, ok))
        .catch(() => respond(requestId, false))
    })
  }, [flushDirtyFiles])
  // Fetch git chrome only while a Changes surface is actually visible
  // (side-dock panel or the immersive Changes tab) — never on mount.
  const changesDockVisible = dockImmersive
    ? immersiveTab === 'changes'
    : activeRightPanel === 'changes'
  const gitChrome = useGitChrome(
    workspacePath,
    gitRevision,
    Boolean(workspacePath) && changesDockVisible,
    changesDockVisible ? 0 : undefined,
    flushDirtyFiles
  )
  const notifyGitMutated = useCallback(() => {
    gitChrome.refresh()
    bumpGitRevision()
  }, [gitChrome, bumpGitRevision])

  const keepWriteFile = useCallback(
    async (path: string) => {
      const ok = await onKeepWriteFile?.(path)
      if (ok !== false) notifyGitMutated()
    },
    [onKeepWriteFile, notifyGitMutated]
  )
  const discardWriteFile = useCallback(
    async (path: string) => {
      const ok = await onDiscardWriteFile?.(path)
      if (ok !== false) notifyGitMutated()
    },
    [onDiscardWriteFile, notifyGitMutated]
  )
  const keepAllWrites = useCallback(async () => {
    const ok = await onKeepAllWrites?.()
    if (ok !== false) notifyGitMutated()
  }, [onKeepAllWrites, notifyGitMutated])
  const { confirm, dialog: confirmDialog } = useConfirm()

  const discardAllWrites = useCallback(async () => {
    const files = writeCheckpointFiles ?? []
    const ok = await confirm(
      'Undo all agent edits? Every listed file is restored to its state before the agent ran. Files you edited yourself are untouched.',
      {
        title: 'Undo all agent edits',
        confirmLabel: 'Undo all',
        danger: true,
        ...(files.length > 0 ? { details: <ConfirmFileList files={files} /> } : {})
      }
    )
    if (!ok) return
    const okDone = await onUndoWrites?.()
    if (okDone !== false) {
      notifyGitMutated()
      pushToast('All agent edits were undone.', 'success')
    }
  }, [onUndoWrites, notifyGitMutated, confirm, writeCheckpointFiles])

  // Prefer the shared mutating-tool revision (same clock as composer chrome), not
  // a per-done-tool + fileCount formula that over-fetches and races the status cache.
  const [changesPreferredScope, setChangesPreferredScope] = useState<'agent' | 'uncommitted'>(
    'uncommitted'
  )
  const [changesScopeToken, setChangesScopeToken] = useState(0)
  const [changesPreferredPath, setChangesPreferredPath] = useState<string | null>(null)

  const persistRightPanel = useCallback((next: ChatRightPanelId | null) => {
    try {
      if (next) localStorage.setItem(RIGHT_PANEL_KEY, next)
      else localStorage.removeItem(RIGHT_PANEL_KEY)
      localStorage.setItem(BROWSER_PANEL_OPEN_KEY, next === 'browser' ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [])

  const closeDock = useCallback(() => {
    setActiveRightPanel((current) => {
      if (current) dismissedPanelsRef.current.add(current)
      return null
    })
    setDockExpanded(false)
    setImmersiveTab('agent')
    // Keep mountedPanels/dockTabs so PTY/browser/plan state survives hide; clear
    // only when the last tab is closed via closeDockTab.
    persistRightPanel(null)
  }, [persistRightPanel, setDockExpanded, setImmersiveTab])

  const setRightPanel = useCallback(
    (next: ChatRightPanelId | null) => {
      if (next === null) {
        closeDock()
        return
      }
      dismissedPanelsRef.current.delete(next)
      setActiveRightPanel(next)
      setDockTabs((prev) => (prev.includes(next) ? prev : [...prev, next]))
      setMountedPanels((prev) => (prev.includes(next) ? prev : [...prev, next]))
      setImmersiveTab(next)
      persistRightPanel(next)
    },
    [closeDock, persistRightPanel, setImmersiveTab]
  )

  const openWorkspaceFile = useCallback(
    (
      path: string,
      options?: Pick<WorkspaceFileOpenRequest, 'line' | 'column' | 'mode'>
    ): void => {
      if (!workspacePath) return
      setRequestedFilePath({ workspacePath, path, ...options })
      setRightPanel('files')
    },
    [setRightPanel, workspacePath]
  )
  const transcriptRunSession = useMemo(
    () => ({
      workspacePath: workspacePath ?? null,
      runId: activeRunId ?? null,
      agentMode,
      agentInstances,
      onOpenAgentInstance,
      onOpenWorkspaceFile: openWorkspaceFile,
      onOpenPanel: setRightPanel
    }),
    [
      workspacePath,
      activeRunId,
      agentMode,
      agentInstances,
      onOpenAgentInstance,
      openWorkspaceFile,
      setRightPanel
    ]
  )
  const transcriptEmptyLabel =
    activeRunId == null && workspacePath
      ? `New chat in ${formatWorkspaceName(workspacePath)}`
      : undefined
  const composerRunSession = useMemo(
    () => ({
      workspacePath: workspacePath ?? null,
      runId: activeRunId ?? null,
      agentMode,
      agentInstances,
      onOpenAgentInstance,
      onOpenWorkspaceFile: openWorkspaceFile,
      onOpenPanel: setRightPanel
    }),
    [
      workspacePath,
      activeRunId,
      agentMode,
      agentInstances,
      onOpenAgentInstance,
      openWorkspaceFile,
      setRightPanel
    ]
  )
  const handleWorkspaceFileOpened = useCallback((request: WorkspaceFileOpenRequest): void => {
    setRequestedFilePath((current) =>
      current &&
      current.workspacePath === request.workspacePath &&
      current.path === request.path
        ? null
        : current
    )
  }, [])

  const mergedSlashHandlers = useMemo(
    () => ({
      ...slashHandlers,
      onOpenFile: (path: string) => {
        openWorkspaceFile(path)
      }
    }),
    [openWorkspaceFile, slashHandlers]
  )

  const openChangesPanel = useCallback(
    (scope: 'agent' | 'uncommitted' = 'uncommitted', path?: string) => {
      setChangesPreferredScope(scope)
      setChangesScopeToken((n) => n + 1)
      setChangesPreferredPath(path ?? null)
      setRightPanel('changes')
    },
    [setRightPanel]
  )

  const onOpenAgentChanges = useCallback(
    (path?: string) => openChangesPanel('agent', path),
    [openChangesPanel]
  )

  const handledOpenChangesRequestRef = useRef(0)
  useEffect(() => {
    // The owner resets the counter to 0 after consuming; clear the handled mark
    // so a later request can reuse the same value (0 -> 1 -> 0 -> 1).
    if (openChangesRequest <= 0) {
      handledOpenChangesRequestRef.current = 0
      return
    }
    if (openChangesRequest === handledOpenChangesRequestRef.current) return
    handledOpenChangesRequestRef.current = openChangesRequest
    openChangesPanel('uncommitted')
    // Reset the owner's counter: the ref resets on unmount, so without this a
    // later ChatView remount re-consumes the same request and force-opens Changes.
    onOpenChangesRequestHandled?.()
  }, [onOpenChangesRequestHandled, openChangesPanel, openChangesRequest])

  const activeRightPanelRef = useRef(activeRightPanel)
  activeRightPanelRef.current = activeRightPanel

  const tryAutoOpenPanel = useCallback(
    (panel: ChatRightPanelId) => {
      if (dismissedPanelsRef.current.has(panel)) return
      setDockTabs((prev) => (prev.includes(panel) ? prev : [...prev, panel]))
      setMountedPanels((prev) => (prev.includes(panel) ? prev : [...prev, panel]))
      const current = activeRightPanelRef.current
      if (current === panel || isChatRightPanelId(current)) {
        // Already open or another panel focused — add the tab but do not steal focus.
        return
      }
      setActiveRightPanel(panel)
      setImmersiveTab(panel)
      persistRightPanel(panel)
    },
    [persistRightPanel, setImmersiveTab]
  )

  const closeDockTab = useCallback(
    (id: ChatRightPanelId) => {
      if (id === 'browser') {
        void window.vyotiq.browserClose?.()
      }
      dismissedPanelsRef.current.add(id)
      setDockTabs((prev) => {
        const next = prev.filter((t) => t !== id)
        setMountedPanels((mounted) => mounted.filter((t) => t !== id))
        if (next.length === 0) {
          setActiveRightPanel(null)
          setDockExpanded(false)
          setImmersiveTab('agent')
          persistRightPanel(null)
          return []
        }
        setActiveRightPanel((active) => {
          if (active !== id) return active
          const fallback = next[next.length - 1] ?? null
          persistRightPanel(fallback)
          return fallback
        })
        setImmersiveTab((tab) => {
          if (tab !== id) return tab
          return next[next.length - 1] ?? 'agent'
        })
        return next
      })
    },
    [persistRightPanel, setDockExpanded, setImmersiveTab]
  )

  const toggleRightPanel = useCallback(
    (panel: ChatRightPanelId) => {
      if (activeRightPanel === panel) {
        closeDockTab(panel)
        return
      }
      setRightPanel(panel)
    },
    [activeRightPanel, closeDockTab, setRightPanel]
  )

  // Both panel entry points read the same table as the rail's tooltips, the
  // Shortcuts settings page and the command palette, so a panel can never
  // advertise a chord nothing answers (Files / Plan / Pull request did).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (shouldBlockPanelShortcut(e.target)) return
      for (const panel of CHAT_RIGHT_PANEL_IDS) {
        if (!matchShortcut(e, PANEL_SHORTCUT[panel])) continue
        e.preventDefault()
        toggleRightPanel(panel)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleRightPanel])

  useEffect(() => {
    const onCommand = (event: Event): void => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id
      const panel = CHAT_RIGHT_PANEL_IDS.find((p) => PANEL_SHORTCUT[p] === id)
      if (panel) toggleRightPanel(panel)
    }
    window.addEventListener('vyotiq:command', onCommand)
    return () => window.removeEventListener('vyotiq:command', onCommand)
  }, [toggleRightPanel])

  const toggleDockExpanded = useCallback(() => {
    if (dockExpanded) {
      // Collapse: if Agent is focused, return to full chat (no side dock); else side dock.
      if (immersiveTab === 'agent') {
        setActiveRightPanel(null)
        persistRightPanel(null)
      }
      setDockExpanded(false)
      return
    }
    if (activeRightPanel) {
      setImmersiveTab(activeRightPanel)
      setDockExpanded(true)
      return
    }
    // Re-expand after collapsing from Agent while dock tabs remain mounted in state.
    if (dockTabs.length > 0) {
      setImmersiveTab((tab) => (tab === 'agent' ? 'agent' : tab))
      setDockExpanded(true)
    }
  }, [
    activeRightPanel,
    dockExpanded,
    dockTabs.length,
    immersiveTab,
    persistRightPanel,
    setDockExpanded,
    setImmersiveTab
  ])

  const selectImmersiveTab = useCallback(
    (id: DockImmersiveTabId) => {
      setImmersiveTab(id)
      if (id !== 'agent') {
        setRightPanel(id)
      }
    },
    [setImmersiveTab, setRightPanel]
  )

  useEffect(() => {
    onPaneCapacityChange?.({
      dockOpen: activeRightPanel != null,
      dockWidthPx: activeRightPanel != null ? dockWidthPx : 0
    })
  }, [activeRightPanel, dockWidthPx, onPaneCapacityChange])

  useEffect(() => {
    setDockWidthPx((w) => clampDock(w))
  }, [clampDock, setDockWidthPx])

  useEffect(() => {
    const onResize = (): void => {
      setDockWidthPx((w) => clampDock(w))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clampDock, setDockWidthPx])

  // Drop immersive only when the dock has no panels left (not merely Agent-focused).
  useEffect(() => {
    if (!activeRightPanel && dockTabs.length === 0) setDockExpanded(false)
  }, [activeRightPanel, dockTabs.length, setDockExpanded])

  useEffect(() => {
    setPrNumber(null)
    dismissedPanelsRef.current.clear()
  }, [workspacePath])

  const handlePrMeta = useCallback((meta: { number: number; title: string } | null) => {
    setPrNumber(meta?.number ?? null)
  }, [])

  // Auto-open the plan panel when this run has actually published a plan.
  // With Plan mode merged into Agent there is no mode left to key this off, and
  // every run now seeds a plan.md stub — so the trigger is the run calling
  // `create_plan`, which is the moment a plan exists to show. Polling still
  // confirms readiness on disk, because the tool row appears before the write
  // lands and a failed call must not open the panel.
  // Terminal / Browser / Changes open
  // only via side rail, dock tabs, ChangeSummary, or GitChrome — never on agent
  // activity (agent terminal output stays in the transcript).
  // While the plan dock is already mounted, PlanPanel owns the plan.md polling;
  // this effect then stops so the artifact is never fetched twice per tick.
  // A dismissed panel must also stop the poll — tryAutoOpenPanel would no-op,
  // so the interval would fire forever without any possible effect. A terminal
  // run can no longer produce a fresh plan.md — stop polling once it stops.
  useEffect(() => {
    if (
      !workspacePath ||
      !activeRunId ||
      !running ||
      !hasCreatePlanCall ||
      mountedPanels.includes('plan') ||
      dismissedPanelsRef.current.has('plan')
    ) {
      return
    }
    let cancelled = false
    const check = (): void => {
      void window.vyotiq.readRunArtifact?.({ workspacePath, runId: activeRunId, name: 'plan.md' }).then(
        (res) => {
          if (cancelled) return
          const ready = Boolean(res.ok && isPlanDraftReady(res.data?.content))
          if (ready) {
            tryAutoOpenPanel('plan')
          }
        }
      )
    }
    check()
    const id = window.setInterval(check, 2000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [workspacePath, activeRunId, hasCreatePlanCall, running, mountedPanels, tryAutoOpenPanel])

  // Prefetch recovery once so FilesPanel can hydrate from the same result when
  // it auto-opens, without issuing a second recovery load.
  useEffect(() => {
    if (
      !workspacePath ||
      mountedPanels.includes('files') ||
      !window.vyotiq?.workspaceEditorRecoveryLoad
    ) {
      return undefined
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void window.vyotiq?.workspaceEditorRecoveryLoad({ workspacePath }).then((result) => {
        if (cancelled || !result.ok) return
        setPendingFilesRecovery({ workspacePath, data: result.data })
      })
    }, 900)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [mountedPanels, workspacePath, tryAutoOpenPanel])

  // Live browser state for the watch affordances (banner + rail dot). The push
  // channel updates regardless of whether the browser dock is mounted.
  const [browserLive, setBrowserLive] = useState<AgentBrowserState | null>(null)
  useEffect(() => {
    let cancelled = false
    // Push events always win over a late browserGetState resolve — same guard
    // as AgentBrowserPanel: a stale closed-state resolve must not clobber a
    // push that already arrived.
    let pushSeq = 0
    let getStateSeq = 0
    void window.vyotiq.browserGetState?.().then((res) => {
      if (cancelled) return
      const seq = ++getStateSeq
      void Promise.resolve().then(() => {
        if (cancelled || seq !== getStateSeq || pushSeq > 0) return
        if (res?.ok) setBrowserLive(res.data)
      })
    })
    const unsub = window.vyotiq.onBrowserState?.((next) => {
      if (!cancelled) {
        pushSeq += 1
        getStateSeq += 1
        setBrowserLive(next)
      }
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  const filesRecoveryData =
    pendingFilesRecovery?.workspacePath === workspacePath
      ? pendingFilesRecovery.data
      : undefined

  const visiblePanelId: ChatRightPanelId | null = dockImmersive
    ? immersiveTab === 'agent'
      ? null
      : immersiveTab
    : activeRightPanel

  const browserBusy = Boolean(browserLive?.open && browserLive?.agentBusy)
  const browserWatchUrl = useMemo(() => {
    const url = browserLive?.url?.trim() ?? ''
    if (!url || url === 'about:blank') return ''
    try {
      return new URL(url).host
    } catch {
      return ''
    }
  }, [browserLive?.url])
  const pendingChangeCount =
    (instancePaneController ? instanceWriteCheckpointFiles : writeCheckpointFiles)?.length ?? 0

  /**
   * Live markers for the side rail. A pulse means the run is working in that
   * panel right now; a count means something there is waiting for the reader.
   * Every value is state this surface already holds, so a rail that is closed
   * costs nothing extra — no panel is mounted and no IPC is issued for it.
   */
  const railPanelState = useMemo<Partial<Record<ChatRightPanelId, RailPanelState>>>(() => {
    const state: Partial<Record<ChatRightPanelId, RailPanelState>> = {}
    const writing = liveActivity.writingPath
    if (writing !== null) {
      // A call whose arguments are still streaming is doing work it cannot
      // name yet; the marker leads, the label catches up.
      const target = writing
        ? formatPathLabel(toWorkspaceRelPath(workspacePath, writing) ?? writing, RAIL_DETAIL_MAX)
        : 'a file'
      state.files = { active: true, detail: `Editing ${target}` }
    }
    const command = liveActivity.command
    if (command !== null) {
      state.terminal = {
        active: true,
        detail: `Running ${command ? truncateMiddle(command, RAIL_DETAIL_MAX) : 'a command'}`
      }
    }
    if (browserBusy) {
      state.browser = {
        active: true,
        detail: browserWatchUrl ? `Browsing ${browserWatchUrl}` : 'Agent is browsing'
      }
    }
    if (pendingChangeCount > 0) {
      state.changes = {
        count: pendingChangeCount,
        detail: `${pendingChangeCount} ${pendingChangeCount === 1 ? 'file' : 'files'} to review`
      }
    }
    return state
  }, [browserBusy, browserWatchUrl, liveActivity, pendingChangeCount, workspacePath])

  // The panel itself shows the live view when visible; the banner covers every
  // other case (panel closed, another panel focused, immersive on another tab).
  const showBrowserWatchBanner = browserBusy && visiblePanelId !== 'browser'
  // With no dock tabs above it the banner is the window's top row, so it owns
  // the title-bar band: Watch live has to clear the caption buttons, and the
  // band has to stop being a drag region or the button is dead to the mouse.
  const bandFreeAboveChat = useTitleBarBand(showBrowserWatchBanner)
  const browserWatchBannerInBand = showBrowserWatchBanner && bandFreeAboveChat
  const browserWatchBanner = showBrowserWatchBanner ? (
    <div
      className={cn(
        'flex shrink-0 items-center gap-2 border-b border-border/40 bg-accent/10 px-3 text-caption',
        browserWatchBannerInBand ? TITLE_BAR_HEIGHT : 'py-1.5'
      )}
      // Inline, not a `pr-*` class: cn() has no tailwind-merge, so an appended
      // utility would lose to the `px-3` already on the row.
      style={
        browserWatchBannerInBand && windowControlsReservePx() > 0
          ? { paddingRight: windowControlsReservePx() }
          : undefined
      }
      data-browser-watch-banner
      role="status"
    >
      <span className="relative flex size-2 shrink-0" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-accent" />
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-fg/90',
          browserWatchBannerInBand && 'app-region-drag'
        )}
      >
        Agent is browsing
        {browserWatchUrl ? <span className="text-muted"> · {browserWatchUrl}</span> : null}
      </span>
      <button
        type="button"
        className="app-region-no-drag shrink-0 rounded-md border border-border bg-surface px-2 py-0.5 text-2xs font-medium text-fg hover:bg-surface-2"
        onClick={() => setRightPanel('browser')}
      >
        Watch live
      </button>
    </div>
  ) : null

  const terminalSessionBarHostRef = useRef<HTMLDivElement>(null)
  const [terminalSessions, setTerminalSessions] = useState<PtySessionInfo[]>([])
  const showTerminalSessionChrome =
    mountedPanels.includes('terminal') && visiblePanelId === 'terminal'

  const tabItems = useMemo(() => {
    const items = dockTabs.map((id) => defaultDockTab(id, id === 'pr' ? prNumber : null))
    if (visiblePanelId === 'terminal' && terminalSessions.length > 0) {
      return items.filter((tab) => tab.id !== 'terminal')
    }
    return items
  }, [dockTabs, prNumber, visiblePanelId, terminalSessions.length])
  const immersiveTabItems = useMemo(() => [AGENT_DOCK_TAB, ...tabItems], [tabItems])
  // Pad only while the floating side rail is mounted (hidden when a side dock
  // is open or in immersive unified-tabs mode).
  const agentSideRailPad = !dockImmersive && activeRightPanel == null

  const {
    editingUserMessageIndex,
    editDraft,
    setEditDraft,
    editSeeds,
    editing,
    cancelPromptEdit,
    beginPromptEdit,
    submitPromptEdit,
    beginPromptRevert,
    sendFromDock
  } = useComposerEditState({
    surfaceKey,
    messages,
    onSend,
    onEditAndResend,
    onRevertToUserMessage,
    onAfterRevert: notifyGitMutated
  })

  const onEditLastUserMessage = useCallback((): boolean => {
    if (!onEditAndResend) return false
    const index = lastUserMessageIndex(messages)
    if (index == null) return false
    beginPromptEdit(index)
    return true
  }, [onEditAndResend, messages, beginPromptEdit])

  const editComposer =
    editing && onEditAndResend ? (
      <MemoComposer
        key={`edit-composer:${surfaceKey}:${editingUserMessageIndex}`}
        provider={provider}
        model={model}
        running={running}
        disabled={!hasWorkspace}
        hasTranscript
        hasWorkspace={hasWorkspace}
        workspacePath={workspacePath}
        ollamaBaseUrl={ollamaBaseUrl}
        customOpenAiBaseUrl={customOpenAiBaseUrl}
        modelsRefreshKey={modelsRefreshKey}
        secrets={secrets}
        draft={editDraft}
        onDraftChange={setEditDraft}
        onProviderModel={onProviderModel}
        favoriteModels={favoriteModels}
        recentModels={recentModels}
        serviceTier={serviceTier}
        onToggleFavorite={onToggleFavorite}
        onServiceTierChange={onServiceTierChange}
        chatSettings={chatSettings}
        onChatSettingsChange={onChatSettingsChange}
        agentMode={agentMode}
        onAgentModeChange={onAgentModeChange}
        onSend={submitPromptEdit}
        onStop={onStop}
        activeRunId={activeRunId}
        contextUsage={metaStore ? undefined : contextUsage}
        metaStore={metaStore}
        onCompactContext={onCompactContext}
        slashHandlers={mergedSlashHandlers}
        variant="inline"
        bannerError={chatBannerError}
        secondaryBannerError={operationalBannerError}
        errorCode={errorCode}
        onRetryNetwork={onContinue}
        onDismissError={onDismissError}
        className="w-full"
        seedImages={editSeeds.images}
        seedFiles={editSeeds.files}
        seedAudio={editSeeds.audio}
        seedNativeFiles={editSeeds.nativeFiles}
        onCancelEdit={cancelPromptEdit}
        composerPlaceholder="Edit message…"
      />
    ) : null

  const composerProps = buildComposerSendProps({
    provider,
    model,
    running,
    hasWorkspace,
    hasTranscript: hasItems,
    workspacePath,
    ollamaBaseUrl,
    customOpenAiBaseUrl,
    modelsRefreshKey,
    secrets,
    draft: composerDraft,
    onDraftChange: onComposerDraftChange,
    onProviderModel,
    favoriteModels,
    recentModels,
    serviceTier,
    onToggleFavorite,
    onServiceTierChange,
    chatSettings,
    onChatSettingsChange,
    agentMode,
    onAgentModeChange,
    onSend: sendFromDock,
    onStop,
    pendingFollowUps,
    onRemoveFollowUp,
    onEditFollowUp,
    onSendFollowUpNow,
    incomplete,
    onContinue,
    errorCode,
    bannerError: chatBannerError,
    secondaryBannerError: operationalBannerError,
    activeRunId,
    onDismissError,
    contextUsage,
    metaStore,
    onCompactContext,
    slashHandlers: mergedSlashHandlers,
    sideRailPad: agentSideRailPad,
    onEditLastUserMessage
  })

  const renderMultiPane = useCallback(
    (pane: ChatPane, options: PaneRenderOptions) =>
      multiPane!.renderPane(pane, {
        ...options,
        onOpenChanges: onOpenAgentChanges,
        onOpenWorkspaceFile: openWorkspaceFile
      }),
    [multiPane, onOpenAgentChanges, openWorkspaceFile]
  )

  const agentColumn =
    multiPane && multiPane.panes.length >= 1 ? (
      <>
        <h1 ref={headingRef} tabIndex={-1} className="sr-only">
          Agent V chat
        </h1>
        <ChatPaneHost
          panes={multiPane.panes}
          focusedPaneId={multiPane.focusedPaneId}
          sizes={multiPane.sizes}
          sideRailPad={agentSideRailPad}
          onFocusPane={multiPane.onFocusPane}
          onClosePane={multiPane.onClosePane}
          onSizesChange={multiPane.onSizesChange}
          onSessionDrop={multiPane.onSessionDrop}
          onSplitPane={multiPane.onSplitPane}
          getPaneTitle={multiPane.getPaneTitle}
          renderPane={renderMultiPane}
        />
      </>
    ) : (
    <>
      <h1 ref={headingRef} tabIndex={-1} className="sr-only">
        Agent V chat
      </h1>

      {viewingInstanceRunId && workspacePath ? (
        <AgentInstancePane
          key={viewingInstanceRunId}
          workspacePath={workspacePath}
          instanceRunId={viewingInstanceRunId}
          instanceMeta={agentInstances?.[viewingInstanceRunId]}
          getController={getInstanceController}
          onControllerChange={setInstancePaneController}
          sideRailPad={agentSideRailPad}
          pendingGates={pendingGates}
          onOpenInstance={openInstancePane}
          onClose={closeInstancePane}
          showThinking={showThinking}
          onOpenWorkspaceFile={openWorkspaceFile}
        />
      ) : (
        <ChatTranscriptStage
          sideRailPad={agentSideRailPad}
          pendingGates={pendingGates}
          onOpenInstance={openInstancePane}
          goal={runGoal.goal}
          loop={runGoal.loop}
          running={running}
          onGoalPause={runGoal.pause}
          onGoalResume={runGoal.resume}
          onGoalComplete={runGoal.complete}
          onGoalActivate={runGoal.activate}
          onGoalDismiss={runGoal.dismiss}
          onStopLoop={runGoal.stopLoop}
          onStopRun={onStop}
          transcript={
            <RunSessionProvider value={transcriptRunSession}>
              <MessageList
                key={`transcript:${surfaceKey}`}
                emptyLabel={transcriptEmptyLabel}
                workspacePath={workspacePath ?? undefined}
                runFeedback={runFeedback}
                items={items}
                itemsStore={itemsStore}
                virtualizeLiveEarly
                pendingRun={pendingRun}
                running={running}
                networkWait={networkWait}
                compacting={compacting}
                turnFailed={turnFailed}
                turnFailureLabel={turnFailureLabel}
                turnStatus={turnStatus}
                transcriptLoading={transcriptLoading}
                transcriptHasEarlier={transcriptHasEarlier}
                transcriptLoadingEarlier={transcriptLoadingEarlier}
                onLoadEarlierMessages={onLoadEarlierMessages}
                restoreScrollTop={restoreScrollTop}
                scrollRestoreToken={scrollRestoreToken}
                onScrollTopChange={onScrollTopChange}
                onLoadToolContent={onLoadToolContent}
                onThinkingToggle={onThinkingToggle}
                onToolToggle={onToolToggle}
                onGroupToggle={onGroupToggle}
                onTurnToggle={onTurnToggle}
                onDismissRunError={onDismissRunError}
                onApprovalDecision={onApprovalDecision}
                onQuestionSubmit={onQuestionSubmit}
                onRetryNetwork={onContinue}
                collapsedTurns={collapsedTurns}
                showThinking={showThinking}
                mcpServerNames={mcpServerNames}
                onOpenChanges={onOpenAgentChanges}
                sideRailPad={agentSideRailPad}
                editingUserMessageIndex={editingUserMessageIndex}
                editComposer={editComposer}
                onBeginEditUserMessage={onEditAndResend ? beginPromptEdit : undefined}
                onRevertUserMessage={onRevertToUserMessage ? beginPromptRevert : undefined}
                messageCount={messages.length}
                turnUsage={turnUsage}
                metaStore={metaStore}
              />
            </RunSessionProvider>
          }
          composer={
            <RunSessionProvider value={composerRunSession}>
              <div
                className={editing ? 'hidden' : undefined}
                inert={editing ? true : undefined}
                aria-hidden={editing || undefined}
              >
                <MemoComposer
                  key={`composer:${surfaceKey}`}
                  {...composerProps}
                  variant="dock"
                  onDismissError={onDismissError}
                />
              </div>
            </RunSessionProvider>
          }
        />
      )}
    </>
    )

  /**
   * The banner, when it shows, is the row that spent the band — so the column
   * under it is an ordinary surface again and its own headers must not reserve
   * the caption strip a second time.
   */
  const agentColumnBelowBanner = browserWatchBannerInBand ? (
    <TitleBarBandSpent>{agentColumn}</TitleBarBandSpent>
  ) : (
    agentColumn
  )

  const panelBodies = (
    <>
      {mountedPanels.includes('files') ? (
        <div
          id="dock-panel-files"
          role="tabpanel"
          aria-label="Files"
          className={cn(
            'min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
            visiblePanelId === 'files' ? 'flex' : 'hidden'
          )}
          aria-hidden={visiblePanelId !== 'files'}
          inert={visiblePanelId !== 'files' ? true : undefined}
        >
          <Suspense fallback={<DockPanelSuspenseFallback />}>
            <FilesPanel
              workspacePath={workspacePath}
              active={visiblePanelId === 'files'}
              gitRevision={gitRevision}
              onGitMutated={notifyGitMutated}
              onFlushReady={registerFilesFlush}
              openPath={requestedFilePath}
              agentFocus={agentFileFocus}
              onOpenPathHandled={handleWorkspaceFileOpened}
              recoveryData={filesRecoveryData}
              onRecoveryDataConsumed={handleFilesRecoveryConsumed}
            />
          </Suspense>
        </div>
      ) : null}
      {mountedPanels.includes('browser') ? (
        <div
          id="dock-panel-browser"
          role="tabpanel"
          aria-label="Browser"
          className={cn(
            'min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
            visiblePanelId === 'browser' ? 'flex' : 'hidden'
          )}
          aria-hidden={visiblePanelId !== 'browser'}
          inert={visiblePanelId !== 'browser' ? true : undefined}
        >
          <AgentBrowserPanel
            workspacePath={workspacePath}
            activeRunId={activeRunId}
            visible={visiblePanelId === 'browser'}
            onClose={() => closeDockTab('browser')}
            onPopOut={() => setRightPanel(null)}
          />
        </div>
      ) : null}
      {mountedPanels.includes('terminal') ? (
        <div
          id="dock-panel-terminal"
          role="tabpanel"
          aria-label="Terminal"
          className={cn(
            'min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
            visiblePanelId === 'terminal' ? 'flex' : 'hidden'
          )}
          aria-hidden={visiblePanelId !== 'terminal'}
          inert={visiblePanelId !== 'terminal' ? true : undefined}
        >
          <Suspense fallback={<DockPanelSuspenseFallback />}>
            <TerminalPanel
              workspacePath={workspacePath}
              visible={visiblePanelId === 'terminal'}
              sessionBarHostRef={terminalSessionBarHostRef}
              onSessionsChange={setTerminalSessions}
            />
          </Suspense>
        </div>
      ) : null}
      {mountedPanels.includes('changes') ? (
        <div
          id="dock-panel-changes"
          role="tabpanel"
          aria-label="Changes"
          className={cn(
            'min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
            visiblePanelId === 'changes' ? 'flex' : 'hidden'
          )}
          aria-hidden={visiblePanelId !== 'changes'}
          inert={visiblePanelId !== 'changes' ? true : undefined}
        >
          <ChangesPanel
            items={instancePaneController ? [] : items}
            itemsStore={instanceItemsStore ?? itemsStore}
            workspacePath={workspacePath}
            gitRevision={gitRevision}
            chrome={gitChrome}
            onGitMutated={notifyGitMutated}
            onOpenFile={openWorkspaceFile}
            onViewPr={() => setRightPanel('pr')}
            writeFileResolutions={instancePaneController ? undefined : writeFileResolutions}
            resolvablePaths={instancePaneController ? undefined : writeResolvablePaths}
            conflictedPaths={instancePaneController ? undefined : writeConflictedPaths}
            writeCheckpointFiles={
              instancePaneController ? instanceWriteCheckpointFiles : writeCheckpointFiles
            }
            canResolve={instancePaneController ? false : canUndoWrites}
            resolveBusy={instancePaneController ? false : undoBusy}
            resolveBlockedReason={instancePaneController ? null : resolveBlockedReason}
            onKeepWriteFile={instancePaneController ? undefined : keepWriteFile}
            onDiscardWriteFile={instancePaneController ? undefined : discardWriteFile}
            onKeepAllWrites={instancePaneController ? undefined : keepAllWrites}
            onDiscardAllWrites={instancePaneController ? undefined : discardAllWrites}
            active={visiblePanelId === 'changes'}
            preferredScope={changesPreferredScope}
            preferredScopeToken={changesScopeToken}
            preferredSelectedPath={changesPreferredPath}
            preferredSelectedPathToken={changesScopeToken}
          />
        </div>
      ) : null}
      {mountedPanels.includes('pr') ? (
        <div
          id="dock-panel-pr"
          role="tabpanel"
          aria-label="Pull request"
          className={cn(
            'min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
            visiblePanelId === 'pr' ? 'flex' : 'hidden'
          )}
          aria-hidden={visiblePanelId !== 'pr'}
          inert={visiblePanelId !== 'pr' ? true : undefined}
        >
          <Suspense fallback={<DockPanelSuspenseFallback />}>
            <PrPanel
              workspacePath={workspacePath}
              gitRevision={gitRevision}
              onOpenFile={openWorkspaceFile}
              onPrMeta={handlePrMeta}
              onUnlink={() => closeDockTab('pr')}
              active={visiblePanelId === 'pr'}
            />
          </Suspense>
        </div>
      ) : null}
      {mountedPanels.includes('plan') ? (
        <div
          id="dock-panel-plan"
          role="tabpanel"
          aria-label="Plan"
          className={cn(
            'min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
            visiblePanelId === 'plan' ? 'flex' : 'hidden'
          )}
          aria-hidden={visiblePanelId !== 'plan'}
          inert={visiblePanelId !== 'plan' ? true : undefined}
        >
          <PlanPanel
            workspacePath={workspacePath}
            runId={activeRunId}
            running={running}
            invokeId={invokeId}
            active={visiblePanelId === 'plan'}
            onOpenFile={openWorkspaceFile}
          />
        </div>
      ) : null}
      {confirmDialog}
    </>
  )

  return (
    <div className={cn('flex h-full min-h-0 flex-col', titleBarBandTaken && 'pt-9')}>
      {dockImmersive && titleBarHost
        ? createPortal(
            <DockTabBar
              variant="immersive"
              active={immersiveTab}
              tabs={immersiveTabItems}
              onSelect={selectImmersiveTab}
              onCloseTab={closeDockTab}
              onOpenPanel={(id) => setRightPanel(id)}
              expanded
              onToggleExpanded={toggleDockExpanded}
              terminalSessionBarHostRef={
                showTerminalSessionChrome ? terminalSessionBarHostRef : undefined
              }
            />,
            titleBarHost
          )
        : null}
      {dockSideTitleBar && titleBarHost
        ? createPortal(
            <div
              className="flex h-full w-full min-w-0 items-stretch"
              data-dock-titlebar-portal
            >
              <div
                className="app-region-drag min-w-3 flex-1 self-stretch"
                aria-hidden
                data-titlebar-drag-spacer
                onDoubleClick={() => void window.vyotiq?.windowMaximize()}
              />
              <div
                className="flex h-full min-w-0 shrink-0"
                style={{ width: sideDockTitleBarWidthPx }}
                data-dock-titlebar-tabs
              >
                <DockTabBar
                  active={activeRightPanel!}
                  tabs={tabItems}
                  onSelect={(id) => {
                    if (id !== 'agent') setRightPanel(id)
                  }}
                  onCloseTab={closeDockTab}
                  onOpenPanel={(id) => setRightPanel(id)}
                  expanded={false}
                  onToggleExpanded={toggleDockExpanded}
                  embeddedInTitleBar
                  terminalSessionBarHostRef={
                    showTerminalSessionChrome ? terminalSessionBarHostRef : undefined
                  }
                />
              </div>
            </div>,
            titleBarHost
          )
        : null}
      <div className="relative flex min-h-0 min-w-0 flex-1" data-chat-surface>
        {dockImmersive ? (
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-transparent"
            data-dock-immersive
            data-dock-expanded="1"
          >
            {/* Fallback when TitleBar host is absent (unit tests / non-shell mounts). */}
            {!titleBarHost ? (
              <DockTabBar
                variant="immersive"
                active={immersiveTab}
                tabs={immersiveTabItems}
                onSelect={selectImmersiveTab}
                onCloseTab={closeDockTab}
                onOpenPanel={(id) => setRightPanel(id)}
                expanded
                onToggleExpanded={toggleDockExpanded}
                terminalSessionBarHostRef={
                  showTerminalSessionChrome ? terminalSessionBarHostRef : undefined
                }
              />
            ) : null}
            <div
              id="dock-panel-agent"
              role="tabpanel"
              aria-label="Agent"
              className={cn(
                'min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
                immersiveTab === 'agent' ? 'flex' : 'hidden'
              )}
              aria-hidden={immersiveTab !== 'agent'}
              inert={immersiveTab !== 'agent' ? true : undefined}
              data-immersive-agent
            >
              {browserWatchBanner}
              {agentColumnBelowBanner}
            </div>
            {panelBodies}
          </div>
        ) : (
          <>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {browserWatchBanner}
              {agentColumnBelowBanner}
            </div>
            {activeRightPanel ? (
              <>
                <PanelResizeHandle
                  label="Resize panel"
                  value={dockWidthPx}
                  min={DOCK_WIDTH_MIN_PX}
                  max={dockMaxPx}
                  edge="start"
                  onChange={(next) => {
                    setDockWidthPx(next)
                  }}
                />
                <aside
                  className={CHAT_RIGHT_PANEL}
                  style={{ width: dockWidthPx }}
                  data-right-dock
                  data-dock-expanded="0"
                >
                  {/* Fallback when TitleBar host is absent (unit tests / non-shell mounts). */}
                  {!dockSideTitleBar ? (
                    <DockTabBar
                      active={activeRightPanel}
                      tabs={tabItems}
                      onSelect={(id) => {
                        if (id !== 'agent') setRightPanel(id)
                      }}
                      onCloseTab={closeDockTab}
                      onOpenPanel={(id) => setRightPanel(id)}
                      expanded={false}
                      onToggleExpanded={toggleDockExpanded}
                      terminalSessionBarHostRef={
                        showTerminalSessionChrome ? terminalSessionBarHostRef : undefined
                      }
                    />
                  ) : null}
                  {panelBodies}
                </aside>
              </>
            ) : null}
            {activeRightPanel === null ? (
              <ChatSideRail
                activePanel={null}
                onSelectPanel={toggleRightPanel}
                onExpandPanels={
                  dockTabs.length > 0 ? () => toggleDockExpanded() : undefined
                }
                workspacePath={workspacePath}
                runId={activeRunId}
                running={running}
                panelState={railPanelState}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
