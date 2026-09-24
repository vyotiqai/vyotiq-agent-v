import type { Ref } from 'react'
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MessageList } from './components/MessageList'
import { AgentBrowserPanel } from './components/AgentBrowserPanel'
import type { WorkspaceFileOpenRequest } from './components/FilesPanel'
import { ChangesPanel } from './components/ChangesPanel'
import { ConfirmFileList } from './components/ConfirmFileList'
import { PlanPanel } from './components/PlanPanel'
import {
  INSPECTOR_DETAIL_MAX,
  INSPECTOR_TABS,
  Inspector,
  type InspectorTabState
} from '@renderer/features/inspector/Inspector'
import { useAgentFileMarks } from '@renderer/features/inspector/agentFileMarks'
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
  useHasChatItems
} from './components/ChatStreamLeaves'
import { useGitChrome } from './components/GitChrome'
import type { UiAgentQuestionAnswer, UiItem } from '@shared/transcript'
import type {
  AgentBrowserState,
  AgentInteractionMode,
  ChatMessage,
  ProviderId,
  ToolApprovalDecision,
  WorkspaceEditorRecoveryLoadResult
} from '@shared/ipc'
import type { ChatSettingsPatch, EffectiveChatSettings } from '@shared/effectiveSettings'
import { useChatErrorSurfaces } from './hooks/composerShared'
import { Alert, Button, PanelResizeHandle, pushToast } from '@renderer/lib/ui'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import { usePersistedBoolean } from '@renderer/lib/hooks/usePersistedBoolean'
import { usePersistedNumber } from '@renderer/lib/hooks/usePersistedNumber'
import {
  CHAT_RIGHT_PANEL_IDS,
  DOCK_WIDTH_DEFAULT_PX,
  DOCK_WIDTH_KEY,
  DOCK_WIDTH_MAX_PX,
  DOCK_WIDTH_MIN_PX,
  INSPECTOR_EXPANDED_KEY,
  INSPECTOR_OPEN_KEY,
  RIGHT_PANEL_KEY,
  clampDockWidthPx,
  readSidebarWidthPxForCapacity,
  isChatRightPanelId,
  type ChatRightPanelId
} from '@renderer/lib/utils/layout'
import { PANEL_SHORTCUT } from '@renderer/lib/utils/dockPanels'
import { formatPathLabel, truncateMiddle } from '@shared/utils/displayPath'
import { toWorkspaceRelPath } from '@shared/utils/workspacePath'
import { cn } from '@renderer/lib/ui/cn'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { focusComposerMessage, matchShortcut, shouldBlockPanelShortcut } from '@renderer/lib/shortcuts'
import { INSPECTOR_TAB_SHORTCUTS } from '@renderer/lib/shortcuts/bindings'
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
import { consumeWorkspaceFileRequest, useWorkspaceFileRequest } from '@renderer/lib/chat/workspaceFileRequests'
import { workspacePathsEqual } from '@shared/workspacePathMatch'



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
  taskTitle = null,
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
  agentProfileId = null,
  onAgentProfileChange = () => {},
  onContinueInAgent,
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
  openChangesScope = 'uncommitted',
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
  /** The task on screen, named as the navigator names it — the review's heading. */
  taskTitle?: string | null
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
  agentProfileId?: string | null
  onAgentProfileChange?: (profileId: string | null) => void
  onContinueInAgent?: () => void
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
  /** Which changes that request opens: the workspace's (default) or this task's. */
  openChangesScope?: 'agent' | 'uncommitted'
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
  /**
   * The inspector's tab. It outlives a hide, so Ctrl I brings back the tab you
   * left; whether the inspector is on screen is its own switch.
   */
  const [inspectorTab, setInspectorTab] = useState<ChatRightPanelId>(() => {
    try {
      const raw = localStorage.getItem(RIGHT_PANEL_KEY)
      // Restore the last tab, but never land on Files (explorer + editor) at
      // startup — it opens only when asked for.
      if (isChatRightPanelId(raw) && raw !== 'files') return raw
    } catch {
      /* ignore */
    }
    return 'changes'
  })
  const [inspectorOpen, setInspectorOpen] = usePersistedBoolean(INSPECTOR_OPEN_KEY, true)
  const [inspectorExpandedPref, setInspectorExpanded] = usePersistedBoolean(
    INSPECTOR_EXPANDED_KEY,
    false
  )
  // A new task has no artifacts yet, so its brief has the work area to itself;
  // asking for the inspector (a tab, Ctrl I, Show inspector) brings it anyway,
  // and the saved open/closed choice is left as it was.
  const newTaskOnScreen = !activeRunId && items.length === 0 && !pendingRun && !running
  const [newTaskInspectorAsked, setNewTaskInspectorAsked] = useState(false)
  // Each new task starts unasked — tabs opened on the task before do not count.
  useEffect(() => {
    setNewTaskInspectorAsked(false)
  }, [newTaskOnScreen, workspacePath])
  const inspectorVisible = inspectorOpen && (!newTaskOnScreen || newTaskInspectorAsked)
  /** Expanded, the inspector is the whole work area and the record steps aside. */
  const inspectorExpanded = inspectorVisible && inspectorExpandedPref
  /** The panel on screen, if any. */
  const activeRightPanel: ChatRightPanelId | null = inspectorVisible ? inspectorTab : null
  /** Changes taken to the whole work area is the review, with a header of its own. */
  const reviewing = inspectorExpanded && inspectorTab === 'changes'
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
        sidebarWidthPx: readSidebarWidthPxForCapacity()
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
  /** Visited panels stay mounted (hidden) when switching so PTY/browser state survives. */
  const [mountedPanels, setMountedPanels] = useState<ChatRightPanelId[]>(() =>
    activeRightPanel ? [activeRightPanel] : []
  )
  const [dockWidthPx, setDockWidthPx] = usePersistedNumber(
    DOCK_WIDTH_KEY,
    DOCK_WIDTH_DEFAULT_PX,
    clampDock
  )
  const dockMaxPx = clampDock(DOCK_WIDTH_MAX_PX)
  const inspectorRef = useRef<HTMLElement | null>(null)
  const [gitRevision, bumpGitRevision] = useGitRevision(
    workspacePath,
    running,
    items,
    itemsStore
  )
  /** Drives the Files panel's follow mode: the file the run is writing now. */
  const agentFileFocus = useAgentFileFocus(running, items, itemsStore)
  /** Drives the inspector tabs' live dots: what the run has in flight. */
  const liveActivity = useAgentLiveActivity(running, items, itemsStore)
  /** What this task edited and read — the Files tab marks them. */
  const agentFileMarks = useAgentFileMarks(
    instancePaneController ? [] : items,
    instanceItemsStore ?? itemsStore,
    workspacePath
  )
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
  // Fetch git chrome only while the Changes tab is on screen — never on mount.
  const changesDockVisible = activeRightPanel === 'changes'
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
  // The Changes tab opens on what this task changed; git's views are a select away.
  const [changesPreferredScope, setChangesPreferredScope] = useState<'agent' | 'uncommitted'>('agent')
  const [changesScopeToken, setChangesScopeToken] = useState(0)
  const [changesPreferredPath, setChangesPreferredPath] = useState<string | null>(null)

  /** Set when a hide takes focus with it; the instruction line gets it back. */
  const refocusAfterHideRef = useRef(false)
  const hideInspector = useCallback(() => {
    refocusAfterHideRef.current = inspectorRef.current?.contains(document.activeElement) ?? false
    setInspectorOpen(false)
    setInspectorExpanded(false)
  }, [setInspectorExpanded, setInspectorOpen])
  useEffect(() => {
    if (inspectorOpen || !refocusAfterHideRef.current) return
    refocusAfterHideRef.current = false
    focusComposerMessage()
  }, [inspectorOpen])

  const setRightPanel = useCallback(
    (next: ChatRightPanelId | null) => {
      if (next === null) {
        hideInspector()
        return
      }
      setInspectorTab(next)
      setInspectorOpen(true)
      setNewTaskInspectorAsked(true)
      setMountedPanels((prev) => (prev.includes(next) ? prev : [...prev, next]))
      try {
        localStorage.setItem(RIGHT_PANEL_KEY, next)
      } catch {
        /* ignore */
      }
    },
    [hideInspector, setInspectorOpen]
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
  // A file asked for from outside this view (the palette) opens here once
  // this view is showing that workspace.
  const fileRequest = useWorkspaceFileRequest()
  useEffect(() => {
    if (!fileRequest || !workspacePath) return
    if (!workspacePathsEqual(fileRequest.workspacePath, workspacePath)) return
    consumeWorkspaceFileRequest(fileRequest.seq)
    openWorkspaceFile(fileRequest.path)
  }, [fileRequest, workspacePath, openWorkspaceFile])
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
    openChangesPanel(openChangesScope)
    // Reset the owner's counter: the ref resets on unmount, so without this a
    // later ChatView remount re-consumes the same request and force-opens Changes.
    onOpenChangesRequestHandled?.()
  }, [onOpenChangesRequestHandled, openChangesPanel, openChangesRequest, openChangesScope])

  const toggleRightPanel = useCallback(
    (panel: ChatRightPanelId) => {
      // The chord for the tab on screen hides the inspector; any other shows
      // the inspector on that tab.
      if (activeRightPanel === panel) {
        hideInspector()
        return
      }
      setRightPanel(panel)
    },
    [activeRightPanel, hideInspector, setRightPanel]
  )

  const toggleInspector = useCallback(() => {
    if (inspectorVisible) hideInspector()
    else setRightPanel(inspectorTab)
  }, [hideInspector, inspectorVisible, inspectorTab, setRightPanel])

  const toggleInspectorExpanded = useCallback(() => {
    if (inspectorExpanded) {
      setInspectorExpanded(false)
      return
    }
    setRightPanel(inspectorTab)
    setInspectorExpanded(true)
  }, [inspectorExpanded, inspectorTab, setInspectorExpanded, setRightPanel])

  // Expanding hides the record; focus that was in it moves to the tab strip
  // rather than falling to <body>.
  const wasExpandedRef = useRef(inspectorExpanded)
  useEffect(() => {
    const was = wasExpandedRef.current
    wasExpandedRef.current = inspectorExpanded
    if (!inspectorExpanded || was) return
    const root = inspectorRef.current
    if (!root || root.contains(document.activeElement)) return
    root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"], [data-review-back]')?.focus()
  }, [inspectorExpanded])

  // Every entry point reads the same tables as the tab strip's titles, the
  // Shortcuts settings page and the command palette, so nothing advertises a
  // chord that nothing answers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Ctrl Shift I reaches the page re-dispatched on window by the main
      // process; judge it by what has focus, like any other chord.
      if (shouldBlockPanelShortcut(e.target === window ? document.activeElement : e.target)) return
      if (matchShortcut(e, 'inspector')) {
        e.preventDefault()
        toggleInspector()
        return
      }
      if (matchShortcut(e, 'inspectorExpand')) {
        e.preventDefault()
        toggleInspectorExpanded()
        return
      }
      const tab = INSPECTOR_TAB_SHORTCUTS.findIndex((id) => matchShortcut(e, id))
      const tabId = tab >= 0 ? INSPECTOR_TABS[tab] : undefined
      if (tabId) {
        e.preventDefault()
        setRightPanel(tabId)
        return
      }
      for (const panel of CHAT_RIGHT_PANEL_IDS) {
        if (!matchShortcut(e, PANEL_SHORTCUT[panel])) continue
        e.preventDefault()
        toggleRightPanel(panel)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setRightPanel, toggleInspector, toggleInspectorExpanded, toggleRightPanel])

  useEffect(() => {
    const onCommand = (event: Event): void => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id
      if (id === 'inspector') {
        toggleInspector()
        return
      }
      if (id === 'inspectorExpand') {
        toggleInspectorExpanded()
        return
      }
      const panel = CHAT_RIGHT_PANEL_IDS.find((p) => PANEL_SHORTCUT[p] === id)
      if (panel) toggleRightPanel(panel)
    }
    window.addEventListener('vyotiq:command', onCommand)
    return () => window.removeEventListener('vyotiq:command', onCommand)
  }, [toggleInspector, toggleInspectorExpanded, toggleRightPanel])

  // Ctrl Shift F / the palette: open Files with its find-in-files box.
  const [findInFilesNonce, setFindInFilesNonce] = useState(0)
  useEffect(() => {
    const onFindInFiles = (): void => {
      if (!workspacePath) return
      setRightPanel('files')
      setFindInFilesNonce((n) => n + 1)
    }
    window.addEventListener('vyotiq:find-in-files', onFindInFiles)
    return () => window.removeEventListener('vyotiq:find-in-files', onFindInFiles)
  }, [setRightPanel, workspacePath])

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

  useEffect(() => {
    setPrNumber(null)
  }, [workspacePath])

  const handlePrMeta = useCallback((meta: { number: number; title: string } | null) => {
    setPrNumber(meta?.number ?? null)
  }, [])

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
  }, [mountedPanels, workspacePath])

  // Live browser state for the watch affordances (banner + tab dot). The push
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

  const visiblePanelId = activeRightPanel

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
   * What each inspector tab says without being opened. A live dot means the
   * run is working there right now; a count means something there waits for
   * the reader. Every value is state this surface already holds, so an
   * unopened tab costs nothing — no panel mounts and no IPC is issued for it.
   */
  const inspectorState = useMemo<Partial<Record<ChatRightPanelId, InspectorTabState>>>(() => {
    const state: Partial<Record<ChatRightPanelId, InspectorTabState>> = {}
    if (pendingChangeCount > 0) {
      state.changes = {
        count: pendingChangeCount,
        detail: `${pendingChangeCount} ${pendingChangeCount === 1 ? 'file' : 'files'} to review`
      }
    }
    const writing = liveActivity.writingPath
    if (writing !== null) {
      // A call whose arguments are still streaming is doing work it cannot
      // name yet; the dot leads, the label catches up.
      const target = writing
        ? formatPathLabel(toWorkspaceRelPath(workspacePath, writing) ?? writing, INSPECTOR_DETAIL_MAX)
        : 'a file'
      state.files = { live: true, detail: `Editing ${target}` }
    }
    const command = liveActivity.command
    if (command !== null) {
      state.terminal = {
        live: true,
        detail: `Running ${command ? truncateMiddle(command, INSPECTOR_DETAIL_MAX) : 'a command'}`
      }
    }
    if (browserBusy) {
      state.browser = {
        live: true,
        detail: browserWatchUrl ? `Browsing ${browserWatchUrl}` : 'Agent is browsing'
      }
    }
    if (prNumber !== null) state.pr = { detail: `Pull request #${prNumber}` }
    if (liveActivity.planning) state.plan = { live: true, detail: 'Writing the plan' }
    return state
  }, [browserBusy, browserWatchUrl, liveActivity, pendingChangeCount, prNumber, workspacePath])

  // The Browser tab's dot says it while the inspector is up; with it hidden,
  // this row is the only sign the agent is driving a page.
  const browserWatchBanner =
    browserBusy && !inspectorVisible ? (
      <div
        className="flex h-8 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2 text-xs"
        data-browser-watch-banner
        role="status"
      >
        <span aria-hidden="true" className="size-1.5 shrink-0 animate-live rounded-full bg-accent" />
        <span className="min-w-0 flex-1 truncate text-muted">
          <span className="text-fg">Agent is browsing</span>
          {browserWatchUrl ? ` · ${browserWatchUrl}` : null}
        </span>
        <Button size="xs" variant="ghost" onClick={() => setRightPanel('browser')}>
          Watch live
        </Button>
      </div>
    ) : null

  /** With the inspector hidden, the rightmost pane's header offers it back. */
  const showInspector = useCallback(() => setRightPanel(inspectorTab), [inspectorTab, setRightPanel])
  const onShowInspector = inspectorVisible ? undefined : showInspector

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
        agentProfileId={agentProfileId}
        onAgentProfileChange={onAgentProfileChange}
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
    agentProfileId,
    onAgentProfileChange,
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
          Tasks
        </h1>
        <ChatPaneHost
          panes={multiPane.panes}
          focusedPaneId={multiPane.focusedPaneId}
          sizes={multiPane.sizes}
          onShowInspector={onShowInspector}
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
        Tasks
      </h1>

      {viewingInstanceRunId && workspacePath ? (
        <AgentInstancePane
          key={viewingInstanceRunId}
          workspacePath={workspacePath}
          instanceRunId={viewingInstanceRunId}
          instanceMeta={agentInstances?.[viewingInstanceRunId]}
          getController={getInstanceController}
          onControllerChange={setInstancePaneController}
          onShowInspector={onShowInspector}
          pendingGates={pendingGates}
          onOpenInstance={openInstancePane}
          onClose={closeInstancePane}
          showThinking={showThinking}
          onOpenWorkspaceFile={openWorkspaceFile}
        />
      ) : (
        <ChatTranscriptStage
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
                onApprovalDecision={onApprovalDecision}
                onQuestionSubmit={onQuestionSubmit}
                onRetryNetwork={onContinue}
                collapsedTurns={collapsedTurns}
                showThinking={showThinking}
                mcpServerNames={mcpServerNames}
                onOpenChanges={onOpenAgentChanges}
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

  // A failing PR check becomes an instruction to the task, sent like any other.
  const handToAgent = useCallback(
    (instruction: string) => {
      void sendFromDock(instruction)
    },
    [sendFromDock]
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
              findInFilesNonce={findInFilesNonce}
              agentMarks={agentFileMarks}
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
            agentAction={liveActivity.browsing}
            onPopOut={hideInspector}
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
              agentCommand={liveActivity.command}
              agentCommandAt={liveActivity.commandAt}
            />
          </Suspense>
        </div>
      ) : null}
      {mountedPanels.includes('changes') ? (
        <div
          id="dock-panel-changes"
          // Reviewing, the panel is its own region; there is no tab to label it.
          role={reviewing ? undefined : 'tabpanel'}
          aria-label={reviewing ? undefined : 'Changes'}
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
            running={instancePaneController ? false : running}
            onStopRun={instancePaneController ? undefined : onStop}
            preferredScope={changesPreferredScope}
            preferredScopeToken={changesScopeToken}
            preferredSelectedPath={changesPreferredPath}
            preferredSelectedPathToken={changesScopeToken}
            runId={instancePaneController ? null : activeRunId}
            variant={reviewing ? 'review' : 'panel'}
            reviewTitle={taskTitle ?? 'Review'}
            onReviewBack={toggleInspectorExpanded}
            onAskAboutLine={instancePaneController ? undefined : handToAgent}
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
              onUnlink={hideInspector}
              onHandToAgent={handToAgent}
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
            agentMode={agentMode}
            onContinueInAgent={onContinueInAgent}
            onOpenFile={openWorkspaceFile}
          />
        </div>
      ) : null}
    </>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative flex min-h-0 min-w-0 flex-1" data-chat-surface>
        <div
          className={inspectorExpanded ? 'hidden' : 'flex min-h-0 min-w-0 flex-1 flex-col'}
          aria-hidden={inspectorExpanded || undefined}
          inert={inspectorExpanded ? true : undefined}
          data-agent-column
        >
          {browserWatchBanner}
          {agentColumn}
        </div>
        {inspectorVisible ? (
          <>
            {inspectorExpanded ? null : (
              <PanelResizeHandle
                label="Resize inspector"
                value={dockWidthPx}
                min={DOCK_WIDTH_MIN_PX}
                max={dockMaxPx}
                edge="start"
                onChange={(next) => {
                  setDockWidthPx(next)
                }}
                // The inspector's border is the line; the handle lights it up.
                hairline
              />
            )}
            <Inspector
              sectionRef={inspectorRef}
              tab={inspectorTab}
              onSelect={setRightPanel}
              state={inspectorState}
              expanded={inspectorExpanded}
              onToggleExpanded={toggleInspectorExpanded}
              onHide={hideInspector}
              width={dockWidthPx}
              bare={reviewing}
            >
              {panelBodies}
            </Inspector>
          </>
        ) : null}
      </div>
      {confirmDialog}
    </div>
  )
}
