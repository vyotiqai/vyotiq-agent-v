import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AppShell } from './AppShell'
import { requestOpenWorkspaceFile } from '@renderer/lib/chat/workspaceFileRequests'
import { launchViewFor } from './launchView'
import { needsDraftChatAfterWorkspaceAdd } from './workspaceAddHandoff'
import { pinnedRunKey, prunePinnedRun, togglePinnedRun } from '../features/home/pinnedRuns'
import { ARCHIVED_RUNS_CAP, archiveRuns, toggleArchivedRun } from './navigator/archivedRuns'
import { requestNavigatorScope } from './navigator/useNavigatorScope'
import { requestUpdatePanel } from './navigator/UpdateChip'
import { exportTaskJson, importTaskInto } from '../features/task/taskBundle'
import { ChatView, type SettleActions } from '../features/chat/ChatView'
import { SessionChatColumn } from '../features/chat/SessionChatColumn'
import { AgentInstancePane } from '../features/chat/components/AgentInstancePane'
import { runTitle } from './navigator/runTitle'
import { PLACEHOLDER_GOAL } from '@shared/utils/taskTitle'
import { onOpenSettingsRequest } from './openSettings'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import type { ChatPane } from '@renderer/lib/chat/chatPaneLayout'
import type { PaneRenderOptions } from '../features/chat/ChatPaneHost'
import type { SettingsSection } from '../features/settings'
import { useAppearance } from '@renderer/lib/hooks/useAppearance'
import { useCustomSkinCss } from '@renderer/lib/hooks/useCustomSkinCss'
import { pickAppearanceSettings, stepFontScale, DEFAULT_FONT_SCALE, type AppearanceSettings } from '@shared/appearance'
import { useSettings } from '@renderer/lib/hooks/useSettings'
import { useWorkspaceManager, resolveComposerDraft } from '@renderer/lib/hooks/useWorkspaceManager'
import type { WorkspaceContext } from '@renderer/lib/hooks/useWorkspaceManager'
import { ErrorBoundary } from '@renderer/lib/ErrorBoundary'
import { ToastHost, pushToast } from '@renderer/lib/ui'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import { applyShortcutOverrides, focusComposerMessage, notifyShortcutListeners } from '@renderer/lib/shortcuts'
import { useFocusComposerSoon } from './useFocusComposerSoon'
import { useLiveAnnouncer } from '@renderer/lib/a11y'
import type {
  ProviderIdAny,
  SecretProvider,
  AttachedFile,
  ToolApprovalMode,
  AgentInteractionMode,
  ChatRewindPreviewResult,
  ToolApprovalDecision
} from '@shared/ipc'
import { defaultModelFor, isProviderConfigured, providerLabel } from '@shared/providers'
import {
  resolveEffectiveSettings,
  type ChatSettingsPatch
} from '@shared/effectiveSettings'
import {
  DEFAULT_THINKING_PREFS,
  modelSelectionKey,
  pushRecentModel,
  resolveServiceTier
} from '@shared/domain/modelSelection'
import { logger } from '@shared/logger'
import { workspacePathsEqual, findByWorkspacePath } from '@shared/workspacePathMatch'
import { buildRunDeepLink } from '@shared/deepLink'
import { copyText } from '@renderer/lib/markdown/copyText'
import { normalizeRelPath } from '../features/chat/utils/turnFileDiffs'
import { useOfflineQueue, useOfflineSendQueue } from '@renderer/lib/hooks/useOfflineSendQueue'
import {
  editOfflineMessage,
  removeOfflineMessage,
  removeOfflineQueueEntriesForRun,
  resolveOfflineFlushTarget
} from '@renderer/lib/hooks/offlineQueueStore'
import {
  clearComposerAttachments,
  composerAttachmentKey,
  getComposerAttachments,
  setComposerAttachments
} from '@renderer/lib/hooks/composerAttachmentStore'
import { getWorkspaceHotUi, resolveHotComposerDraft } from '@renderer/lib/hooks/workspaceHotUiStore'
import { mergeLiveInstanceRuns } from './mergeLiveInstanceRuns'
import type { SlashClientHandlers } from '../features/chat/components/composer/slashCommandExecute'
import { formatLoopStatusLine, loopUsageMessage, parseLoopCommand } from '@shared/goalRuntime'
import type {
  ChatStreamController,
  RevertWritesOutcome
} from '@renderer/lib/hooks/createChatStreamController'
import { rewoundToastText, useRewindDialog } from '@renderer/features/task/RewindDialog'
import { RELOAD_RUN_EVENT, announceRewound, redoRewindAndReload, type ReloadRunDetail } from '@renderer/features/task/rewindRedo'
import { DISCARD_TASK_WORKTREE_EVENT, type DiscardTaskWorktreeDetail } from '@renderer/features/task/taskWorktree'
import { useScheduledWorktreeOpener } from '@renderer/features/schedules/useScheduledWorktreeOpener'
import { isFirstRun, setupRecents, setupStartingMode, setupWorkspace } from '@renderer/features/setup/setupModel'
import {
  briefStateFor,
  deleteTaskDraftFor,
  putBriefBack,
  draftTitle,
  saveTaskDraftFor,
  setBriefState,
  setNewTaskWorktreeDefault,
  useBriefState,
  useTaskDrafts
} from '@renderer/lib/drafts/taskDraftStore'
import type { IpcResult, ReopenWritesResult, ResolveWritesResult, TaskDraft } from '@shared/ipc'
import { bumpTaskOutcome } from '@renderer/features/task/taskOutcomeStore'

/** Full-screen secondary views are code-split; they parse on first open, not at boot. */
const SettingsView = lazy(() =>
  import('../features/settings').then((m) => ({ default: m.SettingsView }))
)
const MarketplaceView = lazy(() =>
  import('../features/marketplace').then((m) => ({ default: m.MarketplaceView }))
)
const HomePage = lazy(() =>
  import('../features/home/HomePage').then((m) => ({ default: m.HomePage }))
)
const SetupPage = lazy(() =>
  import('../features/setup/SetupPage').then((m) => ({ default: m.SetupPage }))
)
const UsagePage = lazy(() =>
  import('../features/usage/UsagePage').then((m) => ({ default: m.UsagePage }))
)

/**
 * A pane-shaped stand-in while something loads: the 40px header row every
 * pane starts with, and a few rows on the body's left edge.
 */
function PaneSkeleton({ label }: { label?: string }) {
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden animate-fade-in"
      role={label ? 'status' : undefined}
      aria-busy="true"
    >
      {label ? <span className="sr-only">{label}</span> : null}
      <div className="flex h-10 shrink-0 items-center border-b border-border pl-4 pr-2">
        <div className="h-3 w-32 animate-pulse rounded-sm bg-surface" />
      </div>
      <div className="flex flex-col gap-3 px-4 py-4">
        <div className="h-4 w-2/5 animate-pulse rounded-sm bg-surface" />
        <div className="h-4 w-3/5 animate-pulse rounded-sm bg-surface" />
        <div className="h-4 w-1/3 animate-pulse rounded-sm bg-surface" />
      </div>
    </div>
  )
}

function ViewSuspenseFallback() {
  return <PaneSkeleton />
}

/** Sent as a visible user turn when resuming a run that was cut short. */
const CONTINUE_PROMPT = 'Continue from where you stopped.'
/** How long Resume waits for a just-stopped run to finish ending. */
const RESUME_WAIT_MS = 5000

/** True once the run is neither running nor starting; false if it still is after `ms`. */
function whenRunIdle(
  controller: { readonly running: boolean; readonly pendingRun: boolean; subscribe: (listener: () => void) => () => void },
  ms: number
): Promise<boolean> {
  const idle = (): boolean => !controller.running && !controller.pendingRun
  if (idle()) return Promise.resolve(true)
  return new Promise((resolve) => {
    let unsubscribe = (): void => {}
    const timer = window.setTimeout(() => {
      unsubscribe()
      resolve(idle())
    }, ms)
    const settle = (): void => {
      if (!idle()) return
      window.clearTimeout(timer)
      unsubscribe()
      resolve(true)
    }
    unsubscribe = controller.subscribe(settle)
    // It may have gone idle between the first check and subscribing.
    settle()
  })
}

/** Settings' Back names the view it returns to. */
const SETTINGS_BACK_LABELS = {
  chat: 'Back to the task',
  home: 'Back to Home',
  usage: 'Back to Usage',
  marketplace: 'Back to Extensions'
} as const

function modelsRefreshKeyFor(
  chatSettings: {
    provider: string
    ollamaBaseUrl?: string
    customOpenAiBaseUrl?: string
    customProviders?: readonly { id: string; baseUrl: string }[]
  },
  secrets: Record<SecretProvider, boolean> & { ollama?: boolean; custom?: boolean },
  nonce: number
): string {
  const providerKey =
    chatSettings.provider === 'ollama'
      ? `ollama:${chatSettings.ollamaBaseUrl}:${secrets.ollama ? '1' : '0'}`
      : chatSettings.provider === 'custom'
        ? `custom:${chatSettings.customOpenAiBaseUrl}:${secrets.custom ? '1' : '0'}`
        : `${chatSettings.provider}:${secrets[chatSettings.provider as SecretProvider] ? '1' : '0'}`
  // The picker browses every endpoint, not just the active one: an edited
  // URL or a key saved on any of them has to drop its cached catalog too.
  const endpointsKey = (chatSettings.customProviders ?? [])
    .map((e) => `${e.id}=${e.baseUrl}:${secrets[e.id as SecretProvider] ? '1' : '0'}`)
    .join(',')
  return `${providerKey}:${endpointsKey}:${nonce}`
}

/** Human-readable bytes for the remove-workspace storage confirm (audit H5). */
function formatStorageBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function App() {
  const { LiveRegion } = useLiveAnnouncer()
  const {
    settings,
    secrets,
    encryptionAvailable,
    secretsLoadError,
    loading,
    refresh,
    update,
    saveSecret,
    removeSecret,
    pickWorkspace,
    error: settingsError,
    setError: setSettingsError
  } = useSettings()
  const { setAppearance, hydrate } = useAppearance(pickAppearanceSettings(settings))
  const { customCssError } = useCustomSkinCss(settings.customCssPath)
  // Settings → Agent: where New task starts when the page has no choice of its own.
  useEffect(() => setNewTaskWorktreeDefault(settings.newTaskWorktree), [settings.newTaskWorktree])
  const [openInstanceByParent, setOpenInstanceByParent] = useState<Record<string, string | null>>(
    {}
  )
  const openInstanceRunIds = useMemo(
    () => Object.values(openInstanceByParent).filter((id): id is string => Boolean(id)),
    [openInstanceByParent]
  )

  const setOpenInstanceForParent = useCallback(
    (parentRunId: string | null | undefined, childId: string | null): void => {
      if (!parentRunId) return
      setOpenInstanceByParent((prev) => {
        if ((prev[parentRunId] ?? null) === childId) return prev
        return { ...prev, [parentRunId]: childId }
      })
    },
    []
  )

  const clearOpenInstanceMatching = useCallback((runId: string): void => {
    setOpenInstanceByParent((prev) => {
      let changed = false
      const next = { ...prev }
      for (const [parentId, childId] of Object.entries(next)) {
        if (childId === runId || parentId === runId) {
          next[parentId] = null
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])
  const contextsForModelRef = useRef<Record<string, WorkspaceContext>>({})
  const getDefaultProviderModelForWorkspace = useCallback(
    (workspacePath: string): { provider: ProviderIdAny; model: string } | null => {
      if (!workspacePath) return null
      const ctx = findByWorkspacePath(contextsForModelRef.current, workspacePath)
      const effective = resolveEffectiveSettings(settings, ctx?.settingsOverride)
      return { provider: effective.provider, model: effective.model }
    },
    [settings]
  )
  const workspace = useWorkspaceManager({
    openInstanceRunIds,
    getDefaultProviderModelForWorkspace,
    maxChatPanes: settings.maxChatPanes ?? 0
  })
  const {
    registry,
    activeWorkspace,
    openWorkspaces,
    activeContext,
    contexts,
    activeRuns,
    activeRunsLoaded,
    chat,
    chatActions,
    openRunTab,
    openRunInWorkspace,
    newChatInWorkspace,
    closeRunTab,
    purgeDeletedRunUi,
    addWorkspace,
    switchWorkspace,
    removeWorkspace,
    getRunController,
    loadRunIntoTab: loadRunTranscriptIntoTab,
    refreshActiveRuns,
    refreshWorkspaceRuns,
    loadOlderRuns: loadOlderWorkspaceRuns,
    scrollRestoreToken,
    setComposerDraftForPane,
    setAgentMode,
    onMessageListScrollForPane,
    setPaneCapacityContext,
    setSettingsOverride,
    workspaceError,
    clearWorkspaceError,
    clearRunsError,
    chatSurfaceEpoch,
    paneLayout,
    focusPaneById,
    closePaneById,
    setPaneSizesByIndex,
    dropSessionOnPane,
    isSessionOpenInPane,
    getPaneChatSnapshot,
    focusedWorkspacePath,
    getFocusedPane,
    getPaneById,
    openNewChatInPane,
    splitFocusedPane,
    isInstanceRun,
    getInstanceParentRunId,
    focusedRunId
  } = workspace

  const focusedParentRunId = chat.runId ?? activeContext?.activeRunId ?? null
  contextsForModelRef.current = contexts
  /**
   * A task as the navigator names it, for a toast about it. `instance` is true
   * for a sub-agent's run, which has no Resume or Archive of its own.
   */
  const taskNameOf = useCallback((path: string, runId: string): { title: string | null; instance: boolean } => {
    const ctx = findByWorkspacePath(contextsForModelRef.current, path)
    const run = ctx?.runs.find((r) => r.runId === runId)
    if (run) return { title: runTitle(run) || null, instance: false }
    const child = ctx?.instanceRuns?.find((r) => r.runId === runId)
    return { title: child ? runTitle(child) || null : null, instance: Boolean(child) }
  }, [])
  const focusedOpenInstance =
    focusedParentRunId != null ? (openInstanceByParent[focusedParentRunId] ?? null) : null

  const [view, setView] = useState<'chat' | 'settings' | 'marketplace' | 'home' | 'usage'>('chat')
  const previousViewRef = useRef(view)
  // Where Settings' Back goes: the view it was opened from, recorded as the
  // view changes (during render, so the first frame already names it).
  const [settingsReturn, setSettingsReturn] = useState<Exclude<typeof view, 'settings'>>('chat')
  const [viewSeen, setViewSeen] = useState(view)
  if (view !== viewSeen) {
    setViewSeen(view)
    if (view === 'settings' && viewSeen !== 'settings') setSettingsReturn(viewSeen)
  }
  const [marketplaceFocusServerId, setMarketplaceFocusServerId] = useState<string | null>(null)
  const [marketplaceFocusSkillPath, setMarketplaceFocusSkillPath] = useState<string | null>(null)
  const [marketplaceFocusRulePath, setMarketplaceFocusRulePath] = useState<string | null>(null)
  const [marketplaceFocusTab, setMarketplaceFocusTab] = useState<'mcps' | 'rules' | null>(null)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  // Lifted so the command palette can open the feedback dialog from any view.
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [modelsRefreshNonce, setModelsRefreshNonce] = useState(0)
  const [homeRefreshVersion, setHomeRefreshVersion] = useState(0)
  const [openChangesRequest, setOpenChangesRequest] = useState(0)
  /** Which changes the request opens: the workspace's, or the task's own. */
  const [openChangesScope, setOpenChangesScope] = useState<'agent' | 'uncommitted'>('uncommitted')
  const consumeOpenChangesRequest = useCallback(() => setOpenChangesRequest(0), [])
  const chatHeadingRef = useRef<HTMLHeadingElement>(null)
  const settingsBackRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previous = previousViewRef.current
    previousViewRef.current = view
    const focusWhenRendered = (el: HTMLElement | null): void => {
      if (!el) return
      requestAnimationFrame(() => requestAnimationFrame(() => el.focus()))
    }
    if (view === 'settings') {
      focusWhenRendered(settingsBackRef.current)
    } else if (view === 'marketplace') {
      // MarketplaceView focuses Search marketplace on mount.
    } else if (view === 'chat') {
      // Returning from settings/marketplace must not steal the first Tab stop
      // (skip link). New chat focuses the composer explicitly in onNewChat.
      if (previous === 'settings' || previous === 'marketplace') return
      requestAnimationFrame(() => requestAnimationFrame(() => {
        focusComposerMessage()
      }))
    }
  }, [view])

  // Set up shows until an approval choice is on record. Whether it is a first
  // run (no task in any open workspace) decides what it looks like, and until
  // the open workspaces' task lists have loaded that can't be told, so nobody
  // sees the first-run form flash by on the way to their tasks. Once told it
  // stays told — a folder opened from Set up loads its tasks too.
  const taskCount = Object.values(contexts).reduce((sum, ctx) => sum + ctx.runs.length, 0)
  // Main opens its own scratch folder whenever no project is; Set up must know
  // it to tell a folder someone chose from one nobody did.
  const [scratchPath, setScratchPath] = useState<{ path: string | null } | null>(null)
  useEffect(() => {
    const get = window.vyotiq?.getHomeWorkspacePath
    if (!get) {
      setScratchPath({ path: null })
      return
    }
    let cancelled = false
    void get().then(
      (res) => {
        if (!cancelled) setScratchPath({ path: res.ok ? res.data : null })
      },
      () => {
        if (!cancelled) setScratchPath({ path: null })
      }
    )
    return () => {
      cancelled = true
    }
  }, [])
  const setupDecidedRef = useRef(false)
  if (
    scratchPath != null &&
    (registry != null || workspaceError != null) &&
    Object.values(contexts).every((ctx) => ctx.runsLoaded)
  ) {
    setupDecidedRef.current = true
  }
  const setupUndecided = !settings.toolApprovalOnboardingDone && !setupDecidedRef.current
  const showSetup = !setupUndecided && !settings.toolApprovalOnboardingDone
  const setupFirstRun = showSetup && isFirstRun(settings.toolApprovalOnboardingDone, taskCount)
  // A send held back until the approval choice is made: Set up asks it, then
  // sends. The instruction itself waits in pendingSendRef (and in its composer).
  const [setupSend, setSetupSend] = useState<{ workspacePath: string } | null>(null)
  // The folder a held send was written in; else the one in front. Only a first
  // run discounts main's scratch folder — anyone else's tasks may live there.
  const setupChosenWorkspace =
    setupSend?.workspacePath ??
    setupWorkspace(activeWorkspace, openWorkspaces, setupFirstRun ? (scratchPath?.path ?? null) : null)

  // Navigation-mode preference applies once settings have loaded. During load the
  // shell keeps the established chat skeleton; the launch view lands before the
  // first post-load paint (useLayoutEffect) so no wrong surface flashes. With no
  // approval choice on record it lands on Home, where Set up lives.
  const launchViewAppliedRef = useRef(false)
  useLayoutEffect(() => {
    if (loading || setupUndecided || launchViewAppliedRef.current) return
    launchViewAppliedRef.current = true
    setView(showSetup ? 'home' : launchViewFor(settings.navigationMode))
  }, [loading, setupUndecided, showSetup, settings.navigationMode])

  // Rebound shortcuts: taken during render so this render's children already
  // match and label the new keys; memoized ones hear about it after.
  applyShortcutOverrides(settings.shortcutOverrides)
  useLayoutEffect(() => {
    notifyShortcutListeners()
  }, [settings.shortcutOverrides])

  useLayoutEffect(() => {
    hydrate(
      pickAppearanceSettings({
        theme: settings.theme,
        fontScale: settings.fontScale,
        skinId: settings.skinId,
        customCssPath: settings.customCssPath
      })
    )
  }, [
    settings.theme,
    settings.fontScale,
    settings.skinId,
    settings.customCssPath,
    hydrate
  ])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      let next = settings.fontScale
      if (e.key === '-' || e.key === '_') {
        next = stepFontScale(settings.fontScale, -1)
      } else if (e.key === '=' || e.key === '+') {
        next = stepFontScale(settings.fontScale, 1)
      } else if (e.key === '0') {
        next = DEFAULT_FONT_SCALE
      } else {
        return
      }
      e.preventDefault()
      if (next === settings.fontScale) return
      const prev = pickAppearanceSettings(settings)
      setAppearance({ fontScale: next })
      void update({ fontScale: next }).then((res) => {
        if (!res.ok) setAppearance(prev)
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settings, setAppearance, update])

  /** Apply appearance at once, then save it; a failed save puts it back. Settings and the palette. */
  const onAppearanceChange = useCallback(
    (partial: Partial<AppearanceSettings>): void => {
      const prev = pickAppearanceSettings(settings)
      setAppearance(partial)
      void update(partial).then((res) => {
        if (!res.ok) setAppearance(prev)
      })
    },
    [settings, setAppearance, update]
  )

  const onProviderModelForWorkspace = useCallback((
    workspacePath: string | null | undefined,
    provider: ProviderIdAny,
    model: string
  ): void => {
    const resolvedModel = model || defaultModelFor(provider)
    const key = modelSelectionKey(provider, resolvedModel)
    const recentModels = pushRecentModel(settings.recentModels, key)
    const prefs = settings.thinkingPrefsByProvider[provider] ?? DEFAULT_THINKING_PREFS
    const serviceTier = settings.serviceTierByModel[key] ?? 'default'

    const globalPatch = {
      recentModels,
      thinkingEnabled: prefs.thinkingEnabled,
      thinkingEffort: prefs.thinkingEffort,
      serviceTier
    }

    const ctx = workspacePath ? findByWorkspacePath(contexts, workspacePath) : null
    const override = ctx?.settingsOverride
    if (override?.useOverride && workspacePath) {
      void setSettingsOverride(workspacePath, {
        ...override,
        useOverride: true,
        provider,
        model: resolvedModel,
        thinkingEnabled: prefs.thinkingEnabled,
        thinkingEffort: prefs.thinkingEffort
      }).then((res) => {
        if (!res.ok) setSettingsError(res.error)
      })
      void update(globalPatch)
      return
    }
    void update({
      provider,
      model: resolvedModel,
      ...globalPatch
    })
  }, [contexts, setSettingsError, setSettingsOverride, settings, update])

  const onChatSettingsChangeForWorkspace = useCallback((
    workspacePath: string | null | undefined,
    patch: ChatSettingsPatch,
    chatSettings: ReturnType<typeof resolveEffectiveSettings>
  ): void => {
    const provider = chatSettings.provider
    const thinkingPrefsByProvider = { ...settings.thinkingPrefsByProvider }
    if (patch.thinkingEnabled !== undefined || patch.thinkingEffort !== undefined) {
      const current = thinkingPrefsByProvider[provider] ?? DEFAULT_THINKING_PREFS
      thinkingPrefsByProvider[provider] = {
        thinkingEnabled: patch.thinkingEnabled ?? current.thinkingEnabled,
        thinkingEffort: patch.thinkingEffort ?? current.thinkingEffort
      }
    }

    const ctx = workspacePath ? findByWorkspacePath(contexts, workspacePath) : null
    const override = ctx?.settingsOverride
    if (override?.useOverride && workspacePath) {
      void setSettingsOverride(workspacePath, {
        ...override,
        useOverride: true,
        ...patch
      }).then((res) => {
        if (!res.ok) setSettingsError(res.error)
      })
      if (Object.keys(thinkingPrefsByProvider).length) {
        void update({ thinkingPrefsByProvider })
      }
      return
    }
    void update({ ...patch, thinkingPrefsByProvider })
  }, [contexts, setSettingsError, setSettingsOverride, settings.thinkingPrefsByProvider, update])

  const onToggleFavorite = useCallback((provider: ProviderIdAny, model: string): void => {
    const key = modelSelectionKey(provider, model)
    const set = new Set(settings.favoriteModels)
    if (set.has(key)) set.delete(key)
    else set.add(key)
    void update({ favoriteModels: [...set] })
  }, [settings.favoriteModels, update])

  // Pin/unpin a task: a pinned task that would be done keeps a navigator group
  // of its own instead of folding away. Same data-array settings pattern as
  // favoriteModels; the cap keeps the newest pins (pinnedRuns.ts).
  const onTogglePinnedRun = useCallback(
    (path: string, runId: string): void => {
      void update({ pinnedRuns: togglePinnedRun(settings.pinnedRuns, pinnedRunKey(path, runId)) })
    },
    [settings.pinnedRuns, update]
  )

  // Archive/unarchive a settled task: it leaves the navigator (and Ctrl K) until
  // the View menu shows archived tasks. Archiving drops a pin — a pinned task is
  // one you asked to keep in sight. The toast's Undo puts both back.
  const archiveSettingsRef = useRef({ archivedRuns: settings.archivedRuns, pinnedRuns: settings.pinnedRuns })
  archiveSettingsRef.current = { archivedRuns: settings.archivedRuns, pinnedRuns: settings.pinnedRuns }
  const onToggleArchivedRun = useCallback(
    (path: string, runId: string): void => {
      const key = pinnedRunKey(path, runId)
      const before = archiveSettingsRef.current
      if (before.archivedRuns.includes(key)) {
        void update({ archivedRuns: toggleArchivedRun(before.archivedRuns, key) })
        return
      }
      const wasPinned = before.pinnedRuns.includes(key)
      void update({
        archivedRuns: toggleArchivedRun(before.archivedRuns, key),
        ...(wasPinned ? { pinnedRuns: before.pinnedRuns.filter((k) => k !== key) } : {})
      })
      const title = taskNameOf(path, runId).title
      pushToast('Task archived', {
        ...(title ? { detail: title } : {}),
        icon: 'archive',
        action: {
          label: 'Undo',
          onClick: () => {
            const now = archiveSettingsRef.current
            void update({
              archivedRuns: now.archivedRuns.filter((k) => k !== key),
              ...(wasPinned && !now.pinnedRuns.includes(key) ? { pinnedRuns: togglePinnedRun(now.pinnedRuns, key) } : {})
            })
          }
        }
      })
    },
    [taskNameOf, update]
  )

  // Several at once (a selection, or "Archive all done"): one settings write,
  // so no archive is lost to another's stale copy of the list; one Undo.
  const onArchiveRuns = useCallback(
    (keys: readonly string[]): void => {
      const before = archiveSettingsRef.current
      const { next, added, dropped } = archiveRuns(before.archivedRuns, keys)
      if (added.length === 0) return
      const addedSet = new Set(added)
      const unpinned = before.pinnedRuns.filter((k) => addedSet.has(k))
      void update({
        archivedRuns: next,
        ...(unpinned.length ? { pinnedRuns: before.pinnedRuns.filter((k) => !addedSet.has(k)) } : {})
      })
      pushToast(added.length === 1 ? 'Task archived' : `${added.length} tasks archived`, {
        ...(dropped > 0
          ? { detail: `The archive keeps ${ARCHIVED_RUNS_CAP}; the ${dropped} oldest came back.` }
          : {}),
        action: {
          label: 'Undo',
          onClick: () => {
            const now = archiveSettingsRef.current
            const pins = unpinned.filter((k) => !now.pinnedRuns.includes(k))
            void update({
              archivedRuns: now.archivedRuns.filter((k) => !addedSet.has(k)),
              ...(pins.length ? { pinnedRuns: [...now.pinnedRuns, ...pins] } : {})
            })
          }
        }
      })
    },
    [update]
  )

  const effectiveChatSettings = resolveEffectiveSettings(
    settings,
    (focusedWorkspacePath
      ? (findByWorkspacePath(contexts, focusedWorkspacePath) ?? activeContext)
      : activeContext
    )?.settingsOverride
  )

  // Home's Environment section reports the same missing-key condition the
  // composer blocks sends on (`deriveModelReadiness` → `missing_key`), using
  // the shared provider rules so local/LAN hosts are never flagged.
  const homeProviderIssue = useMemo(
    () =>
      isProviderConfigured(effectiveChatSettings.provider, secrets, {
        ollamaBaseUrl: effectiveChatSettings.ollamaBaseUrl,
        customOpenAiBaseUrl: effectiveChatSettings.customOpenAiBaseUrl,
        customProviders: settings.customProviders
      })
        ? null
        : { label: providerLabel(effectiveChatSettings.provider, settings.customProviders) },
    [
      effectiveChatSettings.provider,
      effectiveChatSettings.ollamaBaseUrl,
      effectiveChatSettings.customOpenAiBaseUrl,
      secrets,
      settings.customProviders
    ]
  )

  // Clear nested instance view when it no longer belongs to the focused parent session.
  useEffect(() => {
    if (focusedOpenInstance == null || focusedParentRunId == null) return
    const live = chat.agentInstances?.[focusedOpenInstance]
    if (live) return
    const listed = (activeContext?.instanceRuns ?? []).some(
      (inst) => inst.runId === focusedOpenInstance && inst.parentRunId === focusedParentRunId
    )
    if (!listed) setOpenInstanceForParent(focusedParentRunId, null)
  }, [
    focusedOpenInstance,
    focusedParentRunId,
    chat.agentInstances,
    activeContext?.instanceRuns,
    setOpenInstanceForParent
  ])

  const onSelectRunInWorkspace = useCallback(async (path: string, runId: string): Promise<void> => {
    if (!chatActions) {
      setSettingsError('Session loading is unavailable.')
      setView('chat')
      return
    }
    const ctx = findByWorkspacePath(contexts, path)
    const listedInstance = ctx?.instanceRuns?.find((run) => run.runId === runId)
    const liveParentId = chat.runId ?? activeContext?.activeRunId ?? null
    const isLiveChild = Boolean(chat.agentInstances?.[runId])
    const parentRunId = listedInstance?.parentRunId ?? (isLiveChild ? liveParentId : null)

    if (parentRunId) {
      await openRunInWorkspace(path, parentRunId)
      const ctrl = getRunController(parentRunId, path)
      if (!ctrl || ctrl.items.length === 0) {
        await loadRunTranscriptIntoTab(path, parentRunId)
      }
      setOpenInstanceForParent(parentRunId, runId)
      setView('chat')
      return
    }

    setOpenInstanceForParent(runId, null)
    await openRunInWorkspace(path, runId)
    const ctrl = getRunController(runId, path)
    if (!ctrl || ctrl.items.length === 0) {
      await loadRunTranscriptIntoTab(path, runId)
    }
    setView('chat')
  }, [
    activeContext?.activeRunId,
    chat.agentInstances,
    chat.runId,
    chatActions,
    contexts,
    getRunController,
    loadRunTranscriptIntoTab,
    openRunInWorkspace,
    setOpenInstanceForParent,
    setSettingsError
  ])

  // "Settings › Agent" from a toast or a card in the record.
  useEffect(
    () =>
      onOpenSettingsRequest((section) => {
        setSettingsSection(section)
        setView('settings')
      }),
    [setView]
  )

  useEffect(() => {
    const unsub = window.vyotiq?.onNotificationActivate?.((action) => {
      switch (action.type) {
        case 'open_run':
          void onSelectRunInWorkspace(action.workspacePath, action.runId)
          return
        case 'open_settings':
          setSettingsSection(action.section)
          setView('settings')
          return
        case 'open_update':
          requestUpdatePanel()
          return
        default: {
          const _exhaustive: never = action
          return _exhaustive
        }
      }
    })
    return () => {
      unsub?.()
    }
  }, [onSelectRunInWorkspace])

  // A link can name any folder on disk, and opening one runs git in it. A
  // folder the person never opened themselves asks first.
  const { confirm: confirmLinkFolder, dialog: linkFolderDialog } = useConfirm()

  /** Route a vyotiq:// payload to the right chat, adding the workspace if needed. */
  const handleDeepLinkPayload = useCallback(
    async (payload: import('@shared/ipc').DeepLinkPayload): Promise<void> => {
      const { target } = payload
      if (!target) {
        pushToast('Unrecognised Vyotiq link.', 'error')
        return
      }
      if (target.type !== 'open_run') return
      let path = target.workspacePath
      if (!path) {
        // No ws hint: resolve the run against workspaces we already know about.
        const match = Object.entries(contexts).find(([, ctx]) => {
          const lists = [ctx.runs, ctx.olderRuns, ctx.instanceRuns ?? []]
          return lists.some((runs) => runs.some((run) => run.runId === target.runId))
        })
        if (!match) {
          pushToast('That task is not in any open workspace.', 'error')
          return
        }
        path = match[0]
      }
      const isOpen = openWorkspaces.some((open) => workspacePathsEqual(open, path))
      if (!isOpen) {
        const opened = (registry?.recentPaths ?? []).some((recent) => workspacePathsEqual(recent, path))
        if (!opened) {
          const allowed = await confirmLinkFolder(
            "A Vyotiq link wants to open a folder that isn't one of your workspaces. Open it only if you expected this link.",
            {
              title: 'Open a folder from a link',
              confirmLabel: 'Open folder',
              details: (
                <code className="block font-mono text-xs text-fg [overflow-wrap:anywhere]" data-link-folder>
                  {path}
                </code>
              )
            }
          )
          if (!allowed) return
        }
        const added = await addWorkspace(path)
        if (!added) {
          pushToast('Could not open the workspace for that link.', 'error')
          return
        }
      }
      await onSelectRunInWorkspace(path, target.runId)
    },
    [addWorkspace, confirmLinkFolder, contexts, onSelectRunInWorkspace, openWorkspaces, registry?.recentPaths]
  )

  // Consume a link that arrived before mount (cold start / recreate-window),
  // then listen for warm deliveries.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.vyotiq?.consumeDeepLink?.()
      if (cancelled || !res?.ok || !res.data) return
      void handleDeepLinkPayload(res.data)
    })()
    const unsub = window.vyotiq?.onDeepLinkOpened?.((payload) => {
      void handleDeepLinkPayload(payload)
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [handleDeepLinkPayload])

  const onCopyRunLinkInWorkspace = useCallback((path: string, runId: string): void => {
    void copyText(buildRunDeepLink(path, runId)).then((copied) => {
      if (copied) pushToast('Link copied', { icon: 'link' })
      else pushToast('Could not copy link.', 'error')
    })
  }, [])

  const handleSessionDrop = useCallback(
    (
      anchorPaneId: string,
      zone: import('@renderer/lib/chat/chatPaneLayout').PaneDropZone,
      payload: { workspacePath: string; runId: string }
    ): boolean => {
      // Reject drops whose session belongs to a workspace that is no longer
      // open — the pane layout only holds open workspaces (sanitizePaneLayout).
      const isOpen = openWorkspaces.some((path) =>
        workspacePathsEqual(path, payload.workspacePath)
      )
      if (!isOpen) {
        pushToast('The workspace for that task is not open.')
        return false
      }
      const ok = dropSessionOnPane(anchorPaneId, zone, payload)
      if (!ok) {
        pushToast('Not enough room for another task pane.')
        return false
      }
      void (async () => {
        try {
          const ctrl = getRunController(payload.runId, payload.workspacePath)
          if (!ctrl || ctrl.items.length === 0) {
            await loadRunTranscriptIntoTab(payload.workspacePath, payload.runId)
          }
        } catch (err) {
          // The layout already committed — never let a transcript-load failure
          // surface as an unhandled rejection.
          logger.warn('session drop transcript load failed', {
            scope: 'chat',
            workspacePath: payload.workspacePath,
            runId: payload.runId,
            err
          })
        } finally {
          setView('chat')
        }
      })()
      return true
    },
    [dropSessionOnPane, getRunController, loadRunTranscriptIntoTab, openWorkspaces]
  )

  const getPaneTitle = useCallback(
    (pane: ChatPane): string => {
      if (!pane.runId) return 'New task'
      const ctx = findByWorkspacePath(contexts, pane.workspacePath)
      const run =
        ctx?.runs.find((r) => r.runId === pane.runId) ??
        ctx?.instanceRuns?.find((r) => r.runId === pane.runId)
      if (!run) return 'New task'
      return runTitle(run) || 'New task'
    },
    [contexts]
  )

  // Ctrl/Cmd+\ and the pane-header "+" button. Pointerdown already focuses the
  // clicked pane, so the header button splits beside the pane it sits on.
  const onSplitPane = useCallback((): void => {
    const focused = getFocusedPane()
    // No hydrated layout yet — nothing to split; stay quiet instead of
    // claiming the row is full.
    if (!focused) return
    if (focused.runId == null) {
      pushToast('Give this task an instruction first.')
      return
    }
    if (!splitFocusedPane()) {
      pushToast('Not enough room for another task pane.')
      return
    }
    setView('chat')
  }, [getFocusedPane, splitFocusedPane])

  const onNewChat = useCallback((): void => {
    setOpenInstanceForParent(focusedParentRunId, null)
    openRunTab(null)
    setView('chat')
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        focusComposerMessage()
      })
    )
  }, [focusedParentRunId, openRunTab, setOpenInstanceForParent])

  const focusComposerSoon = useFocusComposerSoon()

  // Async when the target workspace differs (switch IPC runs first), so focus
  // retries until the composer mounts.
  const onNewChatInWorkspace = useCallback(
    (path: string): void => {
      setOpenInstanceByParent({})
      void newChatInWorkspace(path)
      setView('chat')
      focusComposerSoon()
    },
    [focusComposerSoon, newChatInWorkspace]
  )

  // Home start bar / workspace cards route here: same switch + focus flow as
  // onNewChatInWorkspace, then the typed goal lands in the new session's
  // composer draft in that workspace. The new session is a draft (runId null),
  // so setComposerDraftForPane(path, null, goal) targets it; empty goals skip
  // the write so an existing draft is never clobbered with ''.
  const onNewSessionInWorkspace = useCallback(
    (path: string, goal: string): void => {
      setOpenInstanceByParent({})
      void newChatInWorkspace(path).then(() => {
        if (goal) setComposerDraftForPane(path, null, goal)
      })
      setView('chat')
      focusComposerSoon()
    },
    [focusComposerSoon, newChatInWorkspace, setComposerDraftForPane]
  )

  // Where a new task's brief can move: the open workspaces, named as the navigator names them.
  const newTaskTargets = useMemo(
    () => ({
      workspaces: openWorkspaces.map((path) => ({ path, name: formatWorkspaceName(path) })),
      onMove: onNewSessionInWorkspace
    }),
    [openWorkspaces, onNewSessionInWorkspace]
  )

  /** After a successful add: show Chat, draft if fresh, focus composer. */
  const handoffToChatAfterWorkspaceAdd = useCallback(
    (activePath: string, activeRunId: string | null): void => {
      setOpenInstanceByParent({})
      setView('chat')
      if (needsDraftChatAfterWorkspaceAdd(activeRunId)) {
        void newChatInWorkspace(activePath)
      }
      focusComposerSoon()
    },
    [focusComposerSoon, newChatInWorkspace]
  )

  const onPickWorkspace = (): void => {
    void pickWorkspace().then(async (res) => {
      if (!res.ok || !res.data) return
      const added = await addWorkspace(res.data)
      if (added) handoffToChatAfterWorkspaceAdd(added.activePath, added.activeRunId)
    })
  }

  const chatActionsRef = useRef(chatActions)
  chatActionsRef.current = chatActions
  const getRunControllerRef = useRef(getRunController)
  getRunControllerRef.current = getRunController
  const getFocusedPaneRef = useRef(getFocusedPane)
  getFocusedPaneRef.current = getFocusedPane
  const getPaneByIdRef = useRef(getPaneById)
  getPaneByIdRef.current = getPaneById
  /** The send Set up is holding back until the approval choice is made. */
  const pendingSendRef = useRef<{
    text: string
    images?: string[]
    files?: AttachedFile[]
    extras?: import('@shared/ipc').ComposerSendExtras
    workspacePath: string
    runId: string | null
    deliver: (
      text: string,
      images?: string[],
      files?: AttachedFile[],
      extras?: import('@shared/ipc').ComposerSendExtras
    ) => boolean | void | Promise<boolean | void>
  } | null>(null)

  const offlineWorkspacePath = focusedWorkspacePath ?? activeWorkspace ?? ''

  const flushOfflineEntry = useCallback(
    (entry: import('@renderer/lib/hooks/offlineQueueStore').OfflineQueuedSend) => {
      const pane = entry.paneId ? getPaneByIdRef.current(entry.paneId) : null
      const target = resolveOfflineFlushTarget(
        entry,
        pane ? [pane] : [],
        offlineWorkspacePath || undefined
      )
      if (!target) return false
      return (
        getRunControllerRef.current(target.runId, target.workspacePath)?.send(
          entry.text,
          entry.images,
          entry.files,
          entry.extras
        ) ?? false
      )
    },
    [offlineWorkspacePath]
  )

  const { sendWithOfflineQueue } = useOfflineSendQueue(offlineWorkspacePath, flushOfflineEntry)
  const offlineQueue = useOfflineQueue()

  /**
   * The new, still-empty pane a Home or worktree start just opened in `path`.
   * An offline send with neither a pane nor a run can never be delivered, so it
   * is bound to that pane and starts there once the connection is back.
   */
  const draftPaneIdIn = useCallback((path: string): string | undefined => {
    const pane = getFocusedPaneRef.current()
    return pane && pane.runId == null && workspacePathsEqual(pane.workspacePath, path) ? pane.paneId : undefined
  }, [])
  const startInNewWorktreeRef = useRef<
    (
      parentPath: string,
      text: string,
      images: string[] | undefined,
      files: AttachedFile[] | undefined,
      extras: import('@shared/ipc').ComposerSendExtras
    ) => Promise<boolean>
  >(async () => false)

  const flushPendingSend = useCallback(async () => {
    const pending = pendingSendRef.current
    pendingSendRef.current = null
    if (!pending) return false
    const { deliver, text, images, files, extras, workspacePath, runId } = pending
    const ok = Boolean(await deliver(text, images, files, extras))
    if (ok) {
      setComposerDraftForPane(workspacePath, runId, '')
      const attKey = composerAttachmentKey(workspacePath, runId)
      if (attKey) clearComposerAttachments(attKey)
      // A new task started from the brief: its checks and draft are spent.
      if (!runId) setBriefState(workspacePath, null)
    }
    return ok
  }, [setComposerDraftForPane])

  // Going back to a composer without choosing lets the held send go: its text
  // is still in that composer (a held send returns false, which puts it back),
  // and a later choice must not send words that may have been edited since.
  // Only once Set up has shown it — a send held on the way into Home is new.
  const setupSendShownRef = useRef(false)
  useEffect(() => {
    if (view !== 'chat' || !setupSendShownRef.current) return
    setupSendShownRef.current = false
    pendingSendRef.current = null
    setSetupSend(null)
  }, [view])
  useEffect(() => {
    if (view === 'home' && showSetup && setupSend) setupSendShownRef.current = true
  }, [view, showSetup, setupSend])

  const gateSendWithOnboarding = useCallback(
    async (
      deliver: (
        text: string,
        images?: string[],
        files?: AttachedFile[],
        extras?: import('@shared/ipc').ComposerSendExtras
      ) => boolean | void | Promise<boolean | void>,
      text: string,
      images: string[] | undefined,
      files: AttachedFile[] | undefined,
      extras: import('@shared/ipc').ComposerSendExtras | undefined,
      binding: { workspacePath: string; runId: string | null }
    ): Promise<boolean> => {
      if (extras?.worktree && !binding.runId) {
        return startInNewWorktreeRef.current(binding.workspacePath, text, images, files, extras)
      }
      // No approval choice on record: hold the send and ask it on Set up, which
      // sends it once the choice is saved.
      if (!settings.toolApprovalOnboardingDone) {
        pendingSendRef.current = {
          text,
          images,
          files,
          extras,
          workspacePath: binding.workspacePath,
          runId: binding.runId,
          deliver
        }
        setupSendShownRef.current = false
        setSetupSend({ workspacePath: binding.workspacePath })
        setView('home')
        return false
      }
      return Boolean(await deliver(text, images, files, extras))
    },
    [settings.toolApprovalOnboardingDone]
  )

  /** Onboarding gate runs before offline enqueue (deliver is sendWithOfflineQueue). */
  const onChatSend = useCallback(
    async (
      text: string,
      images?: string[],
      files?: AttachedFile[],
      extras?: import('@shared/ipc').ComposerSendExtras
    ) => {
      const focused = getFocusedPaneRef.current()
      const path = focused?.workspacePath ?? activeWorkspace
      if (!path) return false
      const runId = focused?.runId ?? null
      return gateSendWithOnboarding(
        (sendText, sendImages, sendFiles, sendExtras) =>
          sendWithOfflineQueue(
            sendText,
            sendImages,
            sendFiles,
            sendExtras,
            (t, i, f, e) =>
              getRunControllerRef.current(runId, path)?.send(t, i, f, e) ?? false,
            { runId, paneId: focused?.paneId, workspacePath: path }
          ),
        text,
        images,
        files,
        extras,
        { workspacePath: path, runId }
      )
    },
    [activeWorkspace, gateSendWithOnboarding, sendWithOfflineQueue]
  )

  /**
   * Start task in a new worktree: make the worktree (a new branch of this
   * workspace's current branch), open it as a workspace, and start the task
   * there through the same gate, queue and controller as any new task. The
   * draft it continued is spent in the workspace it was saved in.
   */
  startInNewWorktreeRef.current = async (parentPath, text, images, files, extras) => {
    const { worktree: _worktree, draftId, ...rest } = extras
    const made = await window.vyotiq.createTaskWorktree(parentPath, text)
    if (!made.ok) {
      pushToast(made.error, 'error')
      return false
    }
    const path = made.data.workspacePath
    let openError: string | null = null
    const added = await addWorkspace(path, { onError: (message) => (openError = message) })
    if (!added) {
      pushToast(`Made the worktree ${made.data.branch}, but couldn’t open it: ${openError ?? 'unknown error'}`, 'error')
      return false
    }
    setOpenInstanceByParent({})
    setView('chat')
    await newChatInWorkspace(path)
    const sendExtras = Object.keys(rest).length > 0 ? rest : undefined
    const sent = await gateSendWithOnboarding(
      (t, i, f, e) =>
        sendWithOfflineQueue(
          t,
          i,
          f,
          e,
          (t2, i2, f2, e2) => getRunControllerRef.current(null, path)?.send(t2, i2, f2, e2) ?? false,
          { runId: null, paneId: draftPaneIdIn(path), workspacePath: path }
        ),
      text,
      images,
      files,
      sendExtras,
      { workspacePath: path, runId: null }
    )
    // Not sent yet (the approval choice comes first, or the send failed): the
    // whole brief — text, checks and attachments — waits on the worktree's New
    // task page, and the draft it came from is kept until a task spends it.
    if (!sent) {
      setComposerDraftForPane(path, null, text)
      // Its checks and its added folders too: the brief was all of them.
      putBriefBack(path, { checks: rest.doneWhen, extraRoots: rest.extraRoots })
      const key = composerAttachmentKey(path, null)
      if (key) {
        setComposerAttachments(key, {
          images: images ?? [],
          files: files ?? [],
          nativeFiles: rest.nativeFiles ?? [],
          audio: rest.audio ?? []
        })
      }
    } else if (draftId) {
      void deleteTaskDraftFor(parentPath, draftId)
    }
    // Either way the brief now lives in the worktree, so the page it came from empties.
    return true
  }

  // Discard / Remove on a task worktree: close its workspace (so nothing of the
  // app holds its files), then delete the folder and the branch.
  const activeRunsRef = useRef(activeRuns)
  activeRunsRef.current = activeRuns
  const openWorkspacesRef = useRef(openWorkspaces)
  openWorkspacesRef.current = openWorkspaces
  useEffect(() => {
    const onDiscard = (event: Event): void => {
      const detail = (event as CustomEvent<DiscardTaskWorktreeDetail>).detail
      if (!detail?.workspacePath) return
      void (async () => {
        if (activeRunsRef.current.some((run) => workspacePathsEqual(run.workspacePath, detail.workspacePath))) {
          pushToast('A task is still running in this worktree — stop it first', 'error')
          return
        }
        await removeWorkspace(detail.workspacePath, false)
        // removeWorkspace reports a failure only through the window's banner:
        // ask main whether it is really closed before deleting its folder.
        const after = await window.vyotiq.getWorkspaces()
        if (!after.ok || after.data.openPaths.some((open) => workspacePathsEqual(open, detail.workspacePath))) {
          pushToast('Couldn’t close the worktree’s workspace, so nothing was deleted', 'error')
          return
        }
        const res = await window.vyotiq.discardTaskWorktree(detail.workspacePath)
        if (!res.ok) {
          // Open it again: its strip is the only place to retry from.
          await addWorkspace(detail.workspacePath, { onError: () => {} })
          pushToast(`Couldn’t delete the worktree: ${res.error}`, 'error')
          return
        }
        if (openWorkspacesRef.current.some((open) => workspacePathsEqual(open, detail.parentPath))) {
          void switchWorkspace(detail.parentPath)
        }
        pushToast(detail.merged ? `Removed the worktree ${detail.branch}` : `Discarded the worktree ${detail.branch}`, {
          kind: 'success',
          icon: 'trash'
        })
      })()
    }
    window.addEventListener(DISCARD_TASK_WORKTREE_EVENT, onDiscard)
    return () => window.removeEventListener(DISCARD_TASK_WORKTREE_EVENT, onDiscard)
  }, [addWorkspace, removeWorkspace, switchWorkspace])

  // A scheduled run set to a new worktree: open the worktree main made, as above.
  useScheduledWorktreeOpener(addWorkspace)

  const { confirm, dialog: confirmDialog } = useConfirm()
  const { askRewind, dialog: rewindDialog } = useRewindDialog()

  useEffect(() => {
    const onReload = (event: Event): void => {
      const detail = (event as CustomEvent<ReloadRunDetail>).detail
      if (!detail?.workspacePath || !detail.runId) return
      void loadRunTranscriptIntoTab(detail.workspacePath, detail.runId)
      refreshWorkspaceRuns(detail.workspacePath)
    }
    window.addEventListener(RELOAD_RUN_EVENT, onReload)
    return () => window.removeEventListener(RELOAD_RUN_EVENT, onReload)
  }, [loadRunTranscriptIntoTab, refreshWorkspaceRuns])

  /**
   * Rewind to before an instruction: the Rewind dialog lists what the task
   * changed from main's preview, then main restores and truncates. Null files
   * means the preview could not be read — the dialog says so rather than
   * claiming nothing changes.
   */
  const confirmRevertToUserMessage = useCallback(
    async (
      userMessageIndex: number,
      runN: number | undefined,
      io: {
        workspacePath: string | null
        /** The task rewound — its Redo is offered from the toast. */
        runId: string | null
        preview: (index: number) => Promise<ChatRewindPreviewResult | null>
        revert: (index: number) => Promise<RevertWritesOutcome | false>
      }
    ): Promise<boolean> => {
      const preview = await io.preview(userMessageIndex)
      const ok = await askRewind({ runN: runN ?? null, files: preview?.files ?? null })
      if (!ok) return false
      const done = await io.revert(userMessageIndex)
      if (done) {
        const { workspacePath, runId } = io
        if (workspacePath && runId) announceRewound(workspacePath, runId)
        // Offer Redo only when main kept it — keeping it is best-effort.
        const redo = workspacePath && runId ? await window.vyotiq.rewindRedoStatus?.(workspacePath, runId) : undefined
        const canRedo = Boolean(redo?.ok && redo.data.available)
        pushToast(rewoundToastText(runN ?? null, done), {
          kind: 'success',
          icon: 'undo',
          ...(canRedo && workspacePath && runId
            ? { action: { label: 'Redo', onClick: () => void redoRewindAndReload(workspacePath, runId) } }
            : {})
        })
        // The rewound edits no longer wait on Keep or Undo.
        if (io.workspacePath) refreshWorkspaceRuns(io.workspacePath)
      }
      return done !== false
    },
    [askRewind, refreshWorkspaceRuns]
  )

  // Resume from the Stopped toast: the record's Resume, from outside the task.
  const resumeRunRef = useRef<(path: string, runId: string) => Promise<void>>(async () => {})
  /**
   * A task you stopped says so, with the way to carry on: Resume sends what the
   * record's Resume sends. An instance's stop is its parent's business, so it
   * says nothing.
   */
  const sayStopped = useCallback(
    (path: string, runId: string): void => {
      const { title, instance } = taskNameOf(path, runId)
      if (instance) return
      pushToast('Stopped', {
        ...(title ? { detail: title } : {}),
        state: 'stopped',
        action: { label: 'Resume', onClick: () => void resumeRunRef.current(path, runId) }
      })
    },
    [taskNameOf]
  )

  const chatStopTargetRef = useRef<{ path: string | null; runId: string | null; live: boolean }>({
    path: null,
    runId: null,
    live: false
  })
  chatStopTargetRef.current = {
    path: focusedWorkspacePath ?? activeWorkspace,
    runId: chat.runId,
    live: chat.running || chat.pendingRun
  }
  const onChatStop = useCallback(() => {
    const { path, runId, live } = chatStopTargetRef.current
    const stopping = chatActionsRef.current?.stop()
    if (!stopping || !live || !path || !runId) return
    void stopping.then((stopped) => {
      if (stopped) sayStopped(path, runId)
    })
  }, [sayStopped])

  const activeRunId = chat.runId
  const [undoBusy, setUndoBusy] = useState(false)
  const resolveAgentWrites = useCallback(
    async (
      action: 'keep' | 'discard',
      paths?: string[],
      target?: {
        workspacePath: string
        runId: string | null
        running: boolean
        writeCheckpoint: ChatStreamController['writeCheckpoint']
        applyWriteCheckpointResolution?: ChatStreamController['applyWriteCheckpointResolution']
      }
    ): Promise<ResolveWritesResult | false> => {
      const workspacePath = target?.workspacePath ?? focusedWorkspacePath ?? activeWorkspace
      const runId = target?.runId ?? activeRunId
      const running = target?.running ?? chat.running
      const writeCheckpoint = target?.writeCheckpoint ?? chat.writeCheckpoint
      if (!workspacePath || !runId) {
        setSettingsError('Keep/Discard is unavailable.')
        return false
      }
      if (running) {
        setSettingsError('Stop the run to Keep/Discard agent writes.')
        return false
      }
      // A file goes to the newest turn still waiting on it, which main finds;
      // the live checkpoint may be a later turn that never wrote it.
      const checkpointId = writeCheckpoint?.undone || paths?.length
        ? undefined
        : writeCheckpoint?.checkpointId
      setUndoBusy(true)
      try {
        const res = await window.vyotiq.resolveWrites({
          workspacePath,
          runId,
          ...(checkpointId ? { checkpointId } : {}),
          action,
          ...(paths?.length ? { paths } : {})
        })
        if (!res.ok) {
          setSettingsError(res.error)
          return false
        }
        const apply =
          target?.applyWriteCheckpointResolution ??
          chatActionsRef.current?.applyWriteCheckpointResolution
        apply?.(res.data)
        setSettingsError(null)
        bumpTaskOutcome()
        // Resolved edits can take the task out of Ready for review; main has
        // already dropped its cached list, so ask for it again.
        refreshWorkspaceRuns(workspacePath)
        return res.data
      } finally {
        setUndoBusy(false)
      }
    },
    [
      activeWorkspace,
      activeRunId,
      chat.running,
      chat.writeCheckpoint,
      focusedWorkspacePath,
      refreshWorkspaceRuns,
      setSettingsError
    ]
  )

  const onUndoWrites = useCallback(async (): Promise<boolean> => {
    return (await resolveAgentWrites('discard')) !== false
  }, [resolveAgentWrites])
  const onUndoAllWrites = useCallback(() => resolveAgentWrites('discard'), [resolveAgentWrites])

  // Taking back a Keep, an Undo or a commit from the task's Changes. A toast's
  // Undo keeps the task it was made for; the live task is only told when it
  // is still the one on screen (another one reads the change from disk).
  const liveRunIdRef = useRef(activeRunId)
  liveRunIdRef.current = activeRunId
  const reopenAgentWrites = useCallback(
    async (
      call: (workspacePath: string, runId: string) => Promise<IpcResult<ReopenWritesResult>>
    ): Promise<ReopenWritesResult | null> => {
      const workspacePath = focusedWorkspacePath ?? activeWorkspace
      const runId = activeRunId
      if (!workspacePath || !runId || chat.running) return null
      setUndoBusy(true)
      try {
        const res = await call(workspacePath, runId)
        if (!res.ok) {
          setSettingsError(res.error)
          return null
        }
        if (liveRunIdRef.current === runId) chatActionsRef.current?.applyWriteCheckpointReopen?.(res.data)
        setSettingsError(null)
        bumpTaskOutcome()
        refreshWorkspaceRuns(workspacePath)
        return res.data
      } finally {
        setUndoBusy(false)
      }
    },
    [activeWorkspace, activeRunId, chat.running, focusedWorkspacePath, refreshWorkspaceRuns, setSettingsError]
  )
  const settleActions = useMemo<SettleActions>(
    () => ({
      reopen: (req) =>
        reopenAgentWrites((workspacePath, runId) => window.vyotiq.reopenWrites({ workspacePath, runId, ...req })),
      undoCommit: (sha) =>
        reopenAgentWrites((workspacePath, runId) => window.vyotiq.undoTaskCommit({ workspacePath, runId, sha })),
      committed: (settled) => {
        if (settled.kept.length > 0 && liveRunIdRef.current === activeRunId) {
          chatActionsRef.current?.applyWriteCheckpointResolution({
            checkpointId: '',
            kept: settled.kept,
            discarded: [],
            fullyResolved: false
          })
        }
        bumpTaskOutcome()
        const workspacePath = focusedWorkspacePath ?? activeWorkspace
        if (workspacePath) refreshWorkspaceRuns(workspacePath)
      },
      undoAll: onUndoAllWrites
    }),
    [activeWorkspace, activeRunId, focusedWorkspacePath, onUndoAllWrites, refreshWorkspaceRuns, reopenAgentWrites]
  )

  const onKeepWriteFile = useCallback(
    (path: string) => resolveAgentWrites('keep', [path]),
    [resolveAgentWrites]
  )
  const onDiscardWriteFile = useCallback(
    (path: string) => resolveAgentWrites('discard', [path]),
    [resolveAgentWrites]
  )
  const onKeepAllWrites = useCallback(
    () => resolveAgentWrites('keep'),
    [resolveAgentWrites]
  )

  const writeFileResolutions = useMemo(() => {
    const files = chat.writeCheckpoint?.files
    if (!files?.length) return undefined
    const map = new Map<string, 'kept' | 'discarded' | undefined>()
    for (const f of files) {
      map.set(normalizeRelPath(f.path), f.resolved)
    }
    return map
  }, [chat.writeCheckpoint])

  const writeResolvablePaths = useMemo(() => {
    const files = chat.writeCheckpoint?.files
    if (!files?.length) return undefined
    return new Set(
      files.filter((f) => f.undoable !== false).map((f) => normalizeRelPath(f.path))
    )
  }, [chat.writeCheckpoint])

  const writeConflictedPaths = useMemo(() => {
    const files = chat.writeCheckpoint?.files
    if (!files?.length) return undefined
    const set = new Set(
      files.filter((f) => f.conflicted).map((f) => normalizeRelPath(f.path))
    )
    return set.size > 0 ? set : undefined
  }, [chat.writeCheckpoint])

  const writeCheckpointFiles = useMemo(() => {
    const files = chat.writeCheckpoint?.files
    if (!files?.length || chat.writeCheckpoint?.undone) return undefined
    return files.map((f) => ({ path: f.path, action: f.action }))
  }, [chat.writeCheckpoint])

  // The task in the chat column, named as the navigator names it.
  const chatWorkspacePath = focusedWorkspacePath ?? activeWorkspace
  const chatTaskTitle = useMemo(() => {
    if (!chatWorkspacePath || !focusedParentRunId) return null
    const ctx = findByWorkspacePath(contexts, chatWorkspacePath)
    const run =
      ctx?.runs.find((r) => r.runId === focusedParentRunId) ??
      ctx?.instanceRuns?.find((r) => r.runId === focusedParentRunId)
    // A task with no words of its own is called "Untitled task" or by its id
    // in the navigator; a review or pull request is better named by its summary.
    const goal = run?.goal?.trim()
    return run && goal && goal.toLowerCase() !== PLACEHOLDER_GOAL ? runTitle(run) || null : null
  }, [contexts, chatWorkspacePath, focusedParentRunId])

  const createSlashHandlers = useCallback(
    (scope: {
      workspacePath: string | null
      runId: string | null
      running: boolean
      pendingRun: boolean
      onClear: () => void
      onCompact: (
        focus?: string
      ) => Promise<{ ok: true; message: string } | { ok: false; message: string }>
      onUndoWrites: () => Promise<boolean>
      onSetAgentMode: (mode: AgentInteractionMode) => void
      onStop?: () => void
    }): SlashClientHandlers => {
      const requireRun = (): { workspacePath: string; runId: string } | null => {
        if (!scope.workspacePath || !scope.runId) {
          pushToast('Open a task first.')
          return null
        }
        return { workspacePath: scope.workspacePath, runId: scope.runId }
      }
      return {
      onClear: () => {
        scope.onClear()
        setSettingsError(null)
        return true
      },
      onCompact: async (focus?: string) => {
        const result = await scope.onCompact(focus)
        if (!result.ok) {
          setSettingsError(result.message)
          return false
        }
        setSettingsError(null)
        return true
      },
      onUndoWrites: () => scope.onUndoWrites(),
      onSetAgentMode: (mode: AgentInteractionMode) => {
        if (scope.running || scope.pendingRun) {
          setSettingsError('Mode is locked while a run is active.')
          return false
        }
        scope.onSetAgentMode(mode)
        return true
      },
      onOpenMarketplace: (mcpServerId?: string) => {
        setMarketplaceFocusServerId(mcpServerId ?? null)
        setView('marketplace')
      },
      onOpenSettings: (section?: 'voice' | 'providers' | 'agent' | 'tools' | 'indexing') => {
        if (section) setSettingsSection(section)
        setView('settings')
      },
      onOpenRules: () => {
        setMarketplaceFocusTab('rules')
        setView('marketplace')
      },
      onCreateRule: async (title?: string) => {
        if (!scope.workspacePath) {
          setSettingsError('Open a workspace to create a rule.')
          return false
        }
        const res = await window.vyotiq.slashCommandsCreateRule({
          workspacePath: scope.workspacePath,
          title
        })
        if (!res.ok) {
          setSettingsError(res.error)
          return false
        }
        setSettingsError(null)
        logger.info('Created workspace rule', {
          scope: 'slash',
          path: res.data.relativePath
        })
        setMarketplaceFocusRulePath(res.data.relativePath)
        setView('marketplace')
        return true
      },
      onCreateSkill: async (title?: string) => {
        const raw = (title ?? '').trim()
        const personal = /^personal(?:\s|$)/i.test(raw)
        const skillTitle = personal ? raw.replace(/^personal\s*/i, '').trim() : raw
        if (!personal && !scope.workspacePath) {
          setSettingsError('Open a workspace to create a project skill.')
          return false
        }
        const res = await window.vyotiq.slashCommandsCreateSkill({
          workspacePath: scope.workspacePath ?? null,
          title: skillTitle || undefined,
          scope: personal ? 'personal' : 'project'
        })
        if (!res.ok) {
          setSettingsError(res.error)
          return false
        }
        setSettingsError(null)
        logger.info('Created skill', {
          scope: 'slash',
          path: res.data.relativePath
        })
        setMarketplaceFocusSkillPath(res.data.path)
        setView('marketplace')
        return true
      },
      onGoalPause: async () => {
        const run = requireRun()
        if (!run) return false
        if (scope.running) {
          scope.onStop?.()
          return true
        }
        const res = await window.vyotiq.setGoalStatus({
          workspacePath: run.workspacePath,
          runId: run.runId,
          action: 'pause'
        })
        if (!res.ok) {
          pushToast(res.error, 'error')
          return false
        }
        return true
      },
      onGoalResume: async () => {
        const run = requireRun()
        if (!run) return false
        const res = await window.vyotiq.setGoalStatus({
          workspacePath: run.workspacePath,
          runId: run.runId,
          action: 'resume'
        })
        if (!res.ok) {
          pushToast(res.error, 'error')
          return false
        }
        return true
      },
      onGoalComplete: async () => {
        const run = requireRun()
        if (!run) return false
        const res = await window.vyotiq.setGoalStatus({
          workspacePath: run.workspacePath,
          runId: run.runId,
          action: 'complete'
        })
        if (!res.ok) {
          pushToast(res.error, 'error')
          return false
        }
        return true
      },
      onGoalUsage: () => {
        pushToast(
          'Usage: /goal <objective> — /goal pause, /goal resume, /goal complete. Prefer a new task.'
        )
        return true
      },
      onLoopSet: async (trailing?: string) => {
        const run = requireRun()
        if (!run) return false
        const parsed = parseLoopCommand(trailing ?? '')
        if (parsed.kind !== 'arm') {
          pushToast(parsed.kind === 'error' ? parsed.message : loopUsageMessage())
          return false
        }
        const res = await window.vyotiq.setLoop({
          workspacePath: run.workspacePath,
          runId: run.runId,
          action: 'arm',
          intervalMs: parsed.intervalMs,
          prompt: parsed.prompt
        })
        if (!res.ok) {
          pushToast(res.error, 'error')
          return false
        }
        return true
      },
      onLoopStop: async () => {
        const run = requireRun()
        if (!run) return false
        const res = await window.vyotiq.setLoop({
          workspacePath: run.workspacePath,
          runId: run.runId,
          action: 'stop'
        })
        if (!res.ok) {
          pushToast(res.error, 'error')
          return false
        }
        return true
      },
      onLoopStatus: async () => {
        const run = requireRun()
        if (!run) return false
        const res = await window.vyotiq.readRunArtifact({
          workspacePath: run.workspacePath,
          runId: run.runId,
          name: 'loop.json'
        })
        if (!res.ok) {
          pushToast(res.error, 'error')
          return false
        }
        if (!res.data.exists || !res.data.content) {
          pushToast(formatLoopStatusLine(null))
          return true
        }
        try {
          pushToast(formatLoopStatusLine(JSON.parse(res.data.content)))
        } catch {
          pushToast(formatLoopStatusLine(null))
        }
        return true
      },
      onMarketplaceAction: async (packageId: string, intent: 'install' | 'enable') => {
        if (intent === 'enable') {
          const res = await window.vyotiq.marketplaceSetEnabled(packageId, true)
          if (!res.ok) setSettingsError(res.error)
          return
        }
        const browse = await window.vyotiq.marketplaceBrowse({})
        if (!browse.ok) {
          setSettingsError(browse.error)
          return
        }
        const entry = browse.data.packages.find((p) => p.id === packageId)
        if (!entry) {
          setSettingsError(`Package not found in catalog: ${packageId}`)
          return
        }
        if (entry.installable === false) {
          setSettingsError(`Package is not installable: ${packageId}`)
          return
        }
        const payload =
          entry.bundledPath != null && entry.bundledPath !== ''
            ? {
                source: 'bundled' as const,
                target: entry.bundledPath,
                kind: entry.kind,
                version: entry.version
              }
            : {
                source: 'registry' as const,
                target: entry.id,
                kind: entry.kind,
                version: entry.version
              }
        if (payload.source === 'registry' && !settings.marketplace?.remoteInstallAcked) {
          const ack = await window.vyotiq.marketplaceAckRemoteInstall(true)
          if (!ack.ok) {
            setSettingsError(ack.error)
            return
          }
          if (!ack.data.marketplace?.remoteInstallAcked) return
          await refresh()
        }
        const res = await window.vyotiq.marketplaceInstall(payload)
        if (!res.ok) setSettingsError(res.error)
      },
      onOpenFile: async (path: string) => {
        if (!scope.workspacePath) {
          setSettingsError('Open a workspace to open files.')
          return
        }
        const res = await window.vyotiq.slashCommandsOpenFile({
          workspacePath: scope.workspacePath,
          path
        })
        if (!res.ok) setSettingsError(res.error)
      },
      onNotice: (message: string) => {
        pushToast(message)
      }
    }
    },
    [refresh, setSettingsError, settings.marketplace]
  )

  const operationalError = settingsError ?? workspaceError

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!window.vyotiq?.consumeCrashRecovery) return
      const res = await window.vyotiq.consumeCrashRecovery()
      if (cancelled || !res.ok || !res.data) return
      const reason = res.data.reason
      const code = res.data.exitCodeHex ?? (res.data.exitCode != null ? String(res.data.exitCode) : '')
      setSettingsError(
        `UI recovered after a renderer crash (${reason}${code ? ` · ${code}` : ''}). Recent crash details are in Settings → Diagnostics.`
      )
    })()
    return () => {
      cancelled = true
    }
  }, [setSettingsError])

  const [mcpServerNames, setMcpServerNames] = useState(() => new Map<string, string>())

  useEffect(() => {
    const map = new Map<string, string>()
    for (const server of settings.mcpServers) {
      map.set(server.id, server.name.trim() || server.id)
    }
    setMcpServerNames(map)
    let cancelled = false
    void (async () => {
      const res = await window.vyotiq?.mcpStatus?.({
        workspacePath: activeWorkspace
      })
      if (cancelled || !res?.ok) return
      setMcpServerNames((prev) => {
        const next = new Map(prev)
        for (const server of res.data.servers) {
          if (!next.has(server.id)) {
            next.set(server.id, server.name.trim() || server.id)
          }
        }
        return next
      })
    })()
    return () => {
      cancelled = true
    }
  }, [settings.mcpServers, activeWorkspace])

  const onDismissChatBanner = useCallback((): void => {
    // Banner shows settingsError ?? workspaceError ?? chat.error — clear only that source.
    if (settingsError) {
      setSettingsError(null)
    } else if (workspaceError) {
      clearWorkspaceError()
    } else {
      chatActions?.clearError()
    }
  }, [chatActions, clearWorkspaceError, setSettingsError, settingsError, workspaceError])

  // The pane header's run actions are plain functions defined further down;
  // read through a ref so the pane renderer does not rebuild every render.
  const paneRunActionsRef = useRef<{
    rename: (path: string, runId: string, title: string) => Promise<void>
    exportRun: (path: string, runId: string) => Promise<void>
    deleteRun: (path: string, runId: string) => Promise<void>
    fork: (path: string, runId: string) => Promise<void>
    togglePin: (path: string, runId: string) => void
    isPinned: (path: string, runId: string) => boolean
    toggleArchive: (path: string, runId: string) => void
    isArchived: (path: string, runId: string) => boolean
  }>({
    rename: async () => {},
    exportRun: async () => {},
    deleteRun: async () => {},
    fork: async () => {},
    togglePin: () => {},
    isPinned: () => false,
    toggleArchive: () => {},
    isArchived: () => false
  })
  const renderPaneSession = useCallback(
    (pane: ChatPane, options: PaneRenderOptions) => {
      const { focused, inspectorToggle, onOpenChanges, onOpenWorkspaceFile, multi, onClose, onSplit } =
        options
      const paneContext = findByWorkspacePath(contexts, pane.workspacePath)
      // Standalone instance pane: inspect + stop only (no composer) — the same
      // contract as the inline view. The WM controller is adopted via
      // getController so IPC is not dual-subscribed.
      if (pane.runId && isInstanceRun(pane.workspacePath, pane.runId)) {
        const parentRunId = getInstanceParentRunId(pane.workspacePath, pane.runId)
        const parentCtrl = parentRunId
          ? getRunController(parentRunId, pane.workspacePath)
          : null
        const paneChatSettings = resolveEffectiveSettings(
          settings,
          paneContext?.settingsOverride
        )
        const parentRun = parentRunId ? (paneContext?.runs.find((r) => r.runId === parentRunId) ?? null) : null
        return (
          <AgentInstancePane
            workspacePath={pane.workspacePath}
            instanceRunId={pane.runId}
            instanceMeta={parentCtrl?.agentInstances?.[pane.runId]}
            getController={getRunController}
            inspectorToggle={inspectorToggle}
            showThinking={paneChatSettings.showThinking}
            onOpenWorkspaceFile={onOpenWorkspaceFile}
            approvalAutoFocus={focused}
            instanceRun={paneContext?.instanceRuns?.find((r) => r.runId === pane.runId) ?? null}
            parentTitle={parentRun ? runTitle(parentRun) : undefined}
            siblings={parentCtrl?.agentInstances}
            onOpenInstance={(siblingRunId) => {
              void openRunInWorkspace(pane.workspacePath, siblingRunId)
            }}
            onClosePane={multi ? onClose : undefined}
            onClose={() => {
              if (!parentRunId) return
              void (async () => {
                try {
                  await openRunInWorkspace(pane.workspacePath, parentRunId)
                  const ctrl = getRunController(parentRunId, pane.workspacePath)
                  if (!ctrl || ctrl.items.length === 0) {
                    await loadRunTranscriptIntoTab(pane.workspacePath, parentRunId)
                  }
                } catch (err) {
                  logger.warn('instance pane back to parent failed', {
                    scope: 'chat',
                    workspacePath: pane.workspacePath,
                    parentRunId,
                    err
                  })
                }
              })()
            }}
          />
        )
      }
      const snap = getPaneChatSnapshot(pane.workspacePath, pane.runId)
      const paneScrollKey = pane.runId ?? '__draft__'
      const paneScroll =
        paneContext && paneScrollKey in paneContext.ui.scrollTopByRunId
          ? paneContext.ui.scrollTopByRunId[paneScrollKey]
          : paneContext &&
              Object.keys(paneContext.ui.scrollTopByRunId).length === 0 &&
              paneContext.ui.scrollTop > 0
            ? paneContext.ui.scrollTop
            : undefined
      const paneCtrl = getRunController(pane.runId, pane.workspacePath)
      // Sends queued for this pane while offline: shown in the line's queue until they start.
      const offlineFollowUps: import('@renderer/lib/hooks/createChatStreamController').PendingFollowUpState[] =
        offlineQueue.list(pane.workspacePath)
          .filter((entry) =>
            entry.paneId ? entry.paneId === pane.paneId : Boolean(pane.runId) && entry.runId === pane.runId
          )
          .map((entry) => ({
            id: entry.id,
            itemId: entry.id,
            preview: entry.text.replace(/s+/g, ' ').trim(),
            text: entry.text,
            offline: true
          }))
      const offlineIds = new Set(offlineFollowUps.map((entry) => entry.id))
      const paneRun = pane.runId ? (paneContext?.runs.find((r) => r.runId === pane.runId) ?? null) : null
      const paneDraft = paneContext
        ? resolveComposerDraft(paneContext.ui, pane.runId)
        : undefined
      const paneCompact =
        pane.workspacePath && pane.runId
          ? async (focus?: string) => {
              paneCtrl?.setCompacting?.(true)
              try {
                const res = await window.vyotiq.chatCompact(
                  pane.workspacePath!,
                  pane.runId!,
                  focus
                )
                if (!res.ok) {
                  return { ok: false as const, message: res.error }
                }
                paneCtrl?.applyManualCompaction?.(res.data)
                return {
                  ok: true as const,
                  message: `Summarised ${res.data.messagesBefore - res.data.keptMessages} earlier record entries; ${res.data.keptMessages} kept verbatim.`
                }
              } finally {
                paneCtrl?.setCompacting?.(false)
              }
            }
          : undefined
      const paneChatSettings = resolveEffectiveSettings(
        settings,
        paneContext?.settingsOverride
      )
      const paneSessionModel = snap.providerModel
      const paneProvider = paneSessionModel?.provider ?? paneChatSettings.provider
      const paneModel = paneSessionModel?.model ?? paneChatSettings.model
      const paneModelsRefreshKey = modelsRefreshKeyFor(
        paneChatSettings,
        secrets,
        modelsRefreshNonce
      )
      const paneSlashHandlers = createSlashHandlers({
        workspacePath: pane.workspacePath,
        runId: pane.runId,
        running: snap.running,
        pendingRun: snap.pendingRun,
        onClear: () => {
          setOpenInstanceForParent(pane.runId, null)
          openNewChatInPane(pane.paneId)
          setView('chat')
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              focusComposerMessage()
            })
          )
        },
        onCompact:
          paneCompact ??
          (async () => ({
            ok: false as const,
            message: 'Compaction is unavailable.'
          })),
        onUndoWrites: async () =>
          (await resolveAgentWrites('discard', undefined, {
            workspacePath: pane.workspacePath,
            runId: pane.runId,
            running: snap.running,
            writeCheckpoint: snap.writeCheckpoint,
            applyWriteCheckpointResolution: paneCtrl?.applyWriteCheckpointResolution.bind(paneCtrl)
          })) !== false,
        onSetAgentMode: (mode) => {
          setAgentMode(mode, { workspacePath: pane.workspacePath, runId: pane.runId })
        },
        onStop: () => {
          void paneCtrl?.stop()
        }
      })
      return (
        <SessionChatColumn
          items={snap.items}
          itemsStore={snap.itemsStore}
          metaStore={snap.metaStore}
          running={snap.running}
          pendingRun={snap.pendingRun}
          error={snap.error}
          errorCode={snap.errorCode}
          networkWait={snap.networkWait}
           compacting={snap.compacting}
           incomplete={snap.incomplete}
           turnStatus={snap.turnStatus}
           onContinue={() => {
            void paneCtrl?.send(CONTINUE_PROMPT)
          }}
          contextUsage={snap.contextUsage}
          turnUsage={snap.turnUsage}
          onCompactContext={paneCompact}
          operationalError={focused ? operationalError : null}
          hasWorkspace={Boolean(pane.workspacePath)}
          workspacePath={pane.workspacePath}
          provider={paneProvider}
          model={paneModel}
          ollamaBaseUrl={paneChatSettings.ollamaBaseUrl}
          customOpenAiBaseUrl={paneChatSettings.customOpenAiBaseUrl}
          modelsRefreshKey={paneModelsRefreshKey}
          secrets={secrets}
          activeRunId={pane.runId}
          transcriptLoading={snap.transcriptLoading}
          transcriptHasEarlier={snap.transcriptHasEarlier}
          transcriptLoadingEarlier={snap.transcriptLoadingEarlier}
          onLoadEarlierMessages={() => {
            void paneCtrl?.loadEarlierMessages()
          }}
          onActivate={() => focusPaneById(pane.paneId)}
          onProviderModel={(provider, model) => {
            paneCtrl?.setProviderModel(provider, model)
            onProviderModelForWorkspace(pane.workspacePath, provider, model)
          }}
          favoriteModels={settings.favoriteModels}
          recentModels={settings.recentModels}
          serviceTier={resolveServiceTier(settings, paneProvider, paneModel)}
          onToggleFavorite={onToggleFavorite}
          onServiceTierChange={(tier) => {
            const key = modelSelectionKey(paneProvider, paneModel)
            void update({
              serviceTier: tier,
              serviceTierByModel: { ...settings.serviceTierByModel, [key]: tier }
            })
          }}
          chatSettings={
            paneSessionModel ? { ...paneChatSettings, ...paneSessionModel } : paneChatSettings
          }
          onChatSettingsChange={(patch) =>
            onChatSettingsChangeForWorkspace(pane.workspacePath, patch, paneChatSettings)
          }
          agentMode={paneContext?.ui.agentMode ?? 'agent'}
          onAgentModeChange={(mode) => {
            setAgentMode(mode, { workspacePath: pane.workspacePath, runId: pane.runId })
          }}
          onSend={(text, images, files, extras) =>
            gateSendWithOnboarding(
              (sendText, sendImages, sendFiles, sendExtras) => {
                const paneDeliver = (
                  t: string,
                  i?: string[],
                  f?: AttachedFile[],
                  e?: import('@shared/ipc').ComposerSendExtras
                ) => paneCtrl?.send(t, i, f, e) ?? false
                return sendWithOfflineQueue(
                  sendText,
                  sendImages,
                  sendFiles,
                  sendExtras,
                  paneDeliver,
                  {
                    runId: pane.runId,
                    paneId: pane.paneId,
                    workspacePath: pane.workspacePath
                  }
                )
              },
              text,
              images,
              files,
              extras,
              { workspacePath: pane.workspacePath, runId: pane.runId }
            )
          }
          onStop={() => {
            const live = snap.running || snap.pendingRun
            const path = pane.workspacePath
            const runId = pane.runId
            void paneCtrl?.stop().then((stopped) => {
              if (stopped && live && path && runId) sayStopped(path, runId)
            })
          }}
          onEditAndResend={(editMessageIndex, text, images, files, extras) =>
            paneCtrl?.editAndResend(editMessageIndex, text, images, files, extras) ?? false
          }
          onRevertToUserMessage={(userMessageIndex, runN) =>
            confirmRevertToUserMessage(
              userMessageIndex,
              runN,
              {
                workspacePath: pane.workspacePath,
                runId: pane.runId,
                preview: (i) => paneCtrl?.previewRewindToUserMessage(i) ?? Promise.resolve(null),
                revert: (i) => paneCtrl?.revertToUserMessage(i) ?? Promise.resolve(false)
              }
            )
          }
          messages={snap.messages}
          pendingFollowUps={
            offlineFollowUps.length > 0 ? [...snap.pendingFollowUps, ...offlineFollowUps] : snap.pendingFollowUps
          }
          agentInstances={snap.agentInstances}
          openInstanceRunId={pane.runId ? (openInstanceByParent[pane.runId] ?? null) : null}
          onOpenInstanceRunIdChange={(id) => setOpenInstanceForParent(pane.runId, id)}
          getInstanceController={getRunController}
          onRemoveFollowUp={(id) => {
            if (offlineIds.has(id)) removeOfflineMessage(pane.workspacePath, id)
            else void paneCtrl?.removeFollowUp(id)
          }}
          onEditFollowUp={(id, text) =>
            offlineIds.has(id)
              ? editOfflineMessage(pane.workspacePath, id, text)
              : (paneCtrl?.editFollowUp(id, text) ?? false)
          }
          onSendFollowUpNow={(id) => {
            if (!offlineIds.has(id)) void paneCtrl?.sendFollowUpNow(id)
          }}
          onDismissError={onDismissChatBanner}
          composerDraft={paneDraft}
          onComposerDraftChange={(draft) =>
            setComposerDraftForPane(pane.workspacePath, pane.runId, draft)
          }
          restoreScrollTop={paneScroll}
          scrollRestoreToken={scrollRestoreToken}
          onScrollTopChange={(scrollTop) =>
            onMessageListScrollForPane(pane.workspacePath, pane.runId, scrollTop)
          }
          chatSurfaceEpoch={chatSurfaceEpoch}
          showThinking={paneChatSettings.showThinking}
          onLoadToolContent={
            paneCtrl ? (toolCallId) => paneCtrl.loadToolContent(toolCallId) : undefined
          }
          onDismissRunError={paneCtrl ? (itemId) => paneCtrl.dismissRunError(itemId) : undefined}
          onApprovalDecision={
            paneCtrl
              ? (requestId, decision) => paneCtrl.respondToApproval(requestId, decision)
              : undefined
          }
          onQuestionSubmit={
            paneCtrl
              ? (requestId, answers) => paneCtrl.respondToQuestion(requestId, answers)
              : undefined
          }
          mcpServerNames={mcpServerNames}
          slashHandlers={paneSlashHandlers}
          approvalAutoFocus={focused}
          inspectorToggle={inspectorToggle}
          onOpenChanges={onOpenChanges}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
          run={paneRun}
          instanceRuns={paneContext?.instanceRuns}
          newTaskTargets={newTaskTargets}
          runActions={{
            onRename: pane.runId
              ? (title) => paneRunActionsRef.current.rename(pane.workspacePath, pane.runId!, title)
              : undefined,
            onExport: pane.runId
              ? () => void paneRunActionsRef.current.exportRun(pane.workspacePath, pane.runId!)
              : undefined,
            onExportJson: pane.runId ? () => void exportTaskJson(pane.workspacePath, pane.runId!) : undefined,
            onCopyLink: pane.runId ? () => onCopyRunLinkInWorkspace(pane.workspacePath, pane.runId!) : undefined,
            onFork: pane.runId ? () => void paneRunActionsRef.current.fork(pane.workspacePath, pane.runId!) : undefined,
            onTogglePin: pane.runId ? () => paneRunActionsRef.current.togglePin(pane.workspacePath, pane.runId!) : undefined,
            isPinned: pane.runId ? () => paneRunActionsRef.current.isPinned(pane.workspacePath, pane.runId!) : undefined,
            onToggleArchive: pane.runId
              ? () => paneRunActionsRef.current.toggleArchive(pane.workspacePath, pane.runId!)
              : undefined,
            isArchived: pane.runId
              ? () => paneRunActionsRef.current.isArchived(pane.workspacePath, pane.runId!)
              : undefined,
            onDelete: pane.runId
              ? () => {
                  const runId = pane.runId!
                  void (async () => {
                    const ok = await confirm(`Delete “${paneRun ? runTitle(paneRun) : 'this task'}”? Its record and checkpoints are removed; files it changed stay as they are.`, {
                      title: 'Delete task',
                      confirmLabel: 'Delete',
                      danger: true
                    })
                    if (ok) await paneRunActionsRef.current.deleteRun(pane.workspacePath, runId)
                  })()
                }
              : undefined,
            onSplit,
            onClosePane: multi ? onClose : undefined
          }}
        />
      )
    },
    [
      chatSurfaceEpoch,
      confirm,
      contexts,
      offlineQueue,
      confirmRevertToUserMessage,
      onCopyRunLinkInWorkspace,
      createSlashHandlers,
      getInstanceParentRunId,
      getPaneChatSnapshot,
      getRunController,
      isInstanceRun,
      loadRunTranscriptIntoTab,
      mcpServerNames,
      focusPaneById,
      gateSendWithOnboarding,
      openRunInWorkspace,
      sendWithOfflineQueue,
      modelsRefreshNonce,
      onDismissChatBanner,
      onMessageListScrollForPane,
      openNewChatInPane,
      openInstanceByParent,
      resolveAgentWrites,
      secrets,
      setComposerDraftForPane,
      setOpenInstanceForParent,
      operationalError,
      scrollRestoreToken,
      setAgentMode,
      settings,
      update,
      onChatSettingsChangeForWorkspace,
      onProviderModelForWorkspace,
      onToggleFavorite,
      newTaskTargets,
      sayStopped
    ]
  )

  const multiPaneConfig = useMemo(() => {
    if (!paneLayout) return null
    return {
      panes: paneLayout.panes,
      focusedPaneId: paneLayout.focusedPaneId,
      sizes: paneLayout.sizes,
      onFocusPane: focusPaneById,
      onClosePane: closePaneById,
      onSizesChange: setPaneSizesByIndex,
      onSessionDrop: handleSessionDrop,
      onSplitPane,
      getPaneTitle,
      renderPane: renderPaneSession
    }
  }, [
    closePaneById,
    focusPaneById,
    getPaneTitle,
    handleSessionDrop,
    onSplitPane,
    paneLayout,
    renderPaneSession,
    setPaneSizesByIndex
  ])

  const onRenameRunInWorkspace = async (
    path: string,
    runId: string,
    goal: string
  ): Promise<void> => {
    if (!window.vyotiq?.renameRun) return
    const res = await window.vyotiq.renameRun(path, runId, goal)
    if (!res.ok) {
      setSettingsError(res.error)
      return
    }
    refreshWorkspaceRuns(path)
  }

  const onDeleteRunInWorkspace = async (path: string, runId: string): Promise<void> => {
    if (!window.vyotiq?.deleteRun) return
    const res = await window.vyotiq.deleteRun(path, runId)
    if (!res.ok) {
      // The sidebar is global chrome, so a refusal ("Cancel run first") has to
      // answer where the click was. The operational banner lives inside the
      // focused chat pane — from a sidebar row that reads as nothing happening.
      pushToast(`Could not delete the task: ${res.error}`, 'error')
      setSettingsError(res.error)
      return
    }
    removeOfflineQueueEntriesForRun(path, runId)
    purgeDeletedRunUi(path, runId)
    clearOpenInstanceMatching(runId)
    if (activeWorkspace && workspacePathsEqual(path, activeWorkspace)) {
      closeRunTab(runId)
    }
    refreshWorkspaceRuns(path)
    const nextPins = prunePinnedRun(settings.pinnedRuns, pinnedRunKey(path, runId))
    const nextArchived = prunePinnedRun(settings.archivedRuns, pinnedRunKey(path, runId))
    if (nextPins !== settings.pinnedRuns || nextArchived !== settings.archivedRuns) {
      void update({ pinnedRuns: [...nextPins], archivedRuns: [...nextArchived] })
    }
  }

  /**
   * Delete several tasks after one confirm. One at a time, as main wants: each
   * delete drains that run's writers first, and a live one is refused. Pins and
   * archive entries are pruned once, from the settings as they are now.
   */
  const onDeleteRunsInWorkspace = async (items: ReadonlyArray<{ workspacePath: string; runId: string }>): Promise<void> => {
    if (items.length === 0 || !window.vyotiq?.deleteRun) return
    const ok = await confirm(
      `Delete ${items.length === 1 ? 'this task' : `these ${items.length} tasks`}? Their records and checkpoints are removed; files they changed stay as they are.`,
      { title: items.length === 1 ? 'Delete task' : 'Delete tasks', confirmLabel: 'Delete', danger: true }
    )
    if (!ok) return
    const deletedKeys = new Set<string>()
    const touched = new Set<string>()
    const errors: string[] = []
    for (const { workspacePath: path, runId } of items) {
      const res = await window.vyotiq.deleteRun(path, runId)
      if (!res.ok) {
        errors.push(res.error)
        continue
      }
      removeOfflineQueueEntriesForRun(path, runId)
      purgeDeletedRunUi(path, runId)
      clearOpenInstanceMatching(runId)
      if (activeWorkspace && workspacePathsEqual(path, activeWorkspace)) closeRunTab(runId)
      deletedKeys.add(pinnedRunKey(path, runId))
      touched.add(path)
    }
    for (const path of touched) refreshWorkspaceRuns(path)
    const now = archiveSettingsRef.current
    const pins = now.pinnedRuns.filter((k) => !deletedKeys.has(k))
    const archived = now.archivedRuns.filter((k) => !deletedKeys.has(k))
    if (pins.length !== now.pinnedRuns.length || archived.length !== now.archivedRuns.length) {
      void update({ pinnedRuns: pins, archivedRuns: archived })
    }
    if (errors.length > 0) {
      pushToast(
        `Deleted ${deletedKeys.size} of ${items.length}. ${errors.length} couldn’t be deleted: ${[...new Set(errors)].join('; ')}`,
        'error'
      )
    } else {
      pushToast(deletedKeys.size === 1 ? 'Task deleted' : `${deletedKeys.size} tasks deleted`)
    }
  }

  const onCloseWorkspace = async (path: string): Promise<void> => {
    // Storage retention (audit H5): offer storage-dir deletion with the measured
    // size, confirmed here BEFORE the remove IPC — main never prompts.
    let deleteStorage = false
    if (settings.storage?.pruneOnWorkspaceRemoval && window.vyotiq?.storageReport) {
      try {
        const report = await window.vyotiq.storageReport()
        // Match by path — StorageReportWorkspace.path is the tracked source
        // path; avoids importing node-crypto-based workspaceId in renderer.
        const entry = report.ok
          ? report.data.workspaces.find((w) => w.path != null && workspacePathsEqual(w.path, path))
          : undefined
        if (entry && entry.bytes > 0) {
          deleteStorage = await confirm(
            `Also delete this workspace's app-data storage (${formatStorageBytes(entry.bytes)})? Session history and checkpoints for this workspace will be permanently removed.`,
            {
              title: 'Delete workspace storage',
              confirmLabel: 'Close and delete storage',
              danger: true
            }
          )
        }
      } catch {
        // report/confirm failures must never block the remove itself
      }
    }
    void removeWorkspace(path, deleteStorage)
  }

  const onExportRunInWorkspace = async (path: string, runId: string): Promise<void> => {
    if (!window.vyotiq?.exportRun) return
    const res = await window.vyotiq.exportRun(path, runId)
    if (!res.ok) {
      pushToast(res.error, 'error')
      return
    }
    if (res.data.saved && res.data.path) {
      pushToast(`Task exported to ${res.data.path}`)
    }
  }

  /** Fork: the task's conversation as a new, finished task, opened where you are. */
  const onForkRunInWorkspace = async (path: string, runId: string): Promise<void> => {
    const res = await window.vyotiq.forkRun(path, runId)
    if (!res.ok) {
      pushToast(`Couldn’t fork the task: ${res.error}`, 'error')
      return
    }
    refreshWorkspaceRuns(path)
    await onSelectRunInWorkspace(path, res.data)
    pushToast('Forked — a copy of the task to take another way', { kind: 'success', icon: 'fork' })
  }

  /** Import task…: a task bundle as a new, finished, read-only task, opened where you are. */
  const onImportTaskInWorkspace = async (path: string): Promise<void> => {
    const runId = await importTaskInto(path)
    if (!runId) return
    refreshWorkspaceRuns(path)
    await onSelectRunInWorkspace(path, runId)
  }

  paneRunActionsRef.current = {
    rename: onRenameRunInWorkspace,
    exportRun: onExportRunInWorkspace,
    deleteRun: onDeleteRunInWorkspace,
    fork: onForkRunInWorkspace,
    togglePin: onTogglePinnedRun,
    isPinned: (path, runId) => settings.pinnedRuns.includes(pinnedRunKey(path, runId)),
    toggleArchive: onToggleArchivedRun,
    isArchived: (path, runId) => settings.archivedRuns.includes(pinnedRunKey(path, runId))
  }

  /** `quiet`: a stop that is part of something else (pausing a goal) says nothing of its own. */
  const onStopRunInWorkspace = useCallback(
    async (path: string, runId: string, opts?: { quiet?: boolean }): Promise<void> => {
      const controller = getRunController(runId, path)
      let stopped = true
      if (controller) {
        stopped = await controller.stop()
      } else {
        const result = await window.vyotiq.chatCancel(runId)
        if (!result.ok) {
          pushToast(result.error, 'error')
          return
        }
      }
      if (stopped && !opts?.quiet) sayStopped(path, runId)
      await refreshWorkspaceRuns(path)
      await refreshActiveRuns()
      setHomeRefreshVersion((version) => version + 1)
    },
    [getRunController, refreshActiveRuns, refreshWorkspaceRuns, sayStopped]
  )

  /**
   * Continues an interrupted run from outside the chat surface.
   *
   * Resuming is controller work — it reconciles the transcript, supersedes the
   * dead invoke and restarts the stream — and a controller only exists for a
   * run that is open. So this opens the session first and then resumes it.
   * `resumeInterrupted` is self-guarding, so racing the auto-resume queue
   * (when that setting is on) costs nothing: the loser returns false.
   */
  const onResumeRunInWorkspace = useCallback(
    async (path: string, runId: string): Promise<void> => {
      await onSelectRunInWorkspace(path, runId)
      const controller = getRunController(runId, path)
      if (!controller) {
        pushToast('That session could not be opened.', 'error')
        return
      }
      if (!(await controller.resumeInterrupted())) return
      await refreshWorkspaceRuns(path)
      await refreshActiveRuns()
      setHomeRefreshVersion((version) => version + 1)
    },
    [getRunController, onSelectRunInWorkspace, refreshActiveRuns, refreshWorkspaceRuns]
  )

  /**
   * A failed task's Retry from outside it (its navigator row, the Inbox): the
   * record's own Retry — the task's controller sends CONTINUE_PROMPT — so it
   * opens the task first, as resuming does. A task already going again is
   * left alone.
   */
  const onRetryRunInWorkspace = useCallback(
    async (path: string, runId: string): Promise<void> => {
      await onSelectRunInWorkspace(path, runId)
      const controller = getRunController(runId, path)
      if (!controller) {
        pushToast('That session could not be opened.', 'error')
        return
      }
      if (controller.running || controller.pendingRun) return
      if (!(await controller.send(CONTINUE_PROMPT))) return
      await refreshWorkspaceRuns(path)
      await refreshActiveRuns()
      setHomeRefreshVersion((version) => version + 1)
    },
    [getRunController, onSelectRunInWorkspace, refreshActiveRuns, refreshWorkspaceRuns]
  )
  // The toast can be pressed while the stop is still landing (main accepted
  // the cancel; the stream has not ended): wait for the run to go idle first.
  resumeRunRef.current = async (path, runId) => {
    const controller = getRunController(runId, path)
    if (controller && !(await whenRunIdle(controller, RESUME_WAIT_MS))) return
    await onRetryRunInWorkspace(path, runId)
  }

  /**
   * Pause a task's standing goal, then stop the run it launched — the goal
   * banner's order. Pausing alone would leave the agent working on a goal the
   * navigator now calls paused.
   */
  const onPauseGoalInWorkspace = useCallback(
    async (path: string, runId: string, live: boolean): Promise<void> => {
      const res = await window.vyotiq?.setGoalStatus({ workspacePath: path, runId, action: 'pause' })
      if (!res) return
      if (!res.ok) {
        pushToast(res.error, 'error')
        return
      }
      if (live) await onStopRunInWorkspace(path, runId, { quiet: true })
      else await refreshWorkspaceRuns(path)
    },
    [onStopRunInWorkspace, refreshWorkspaceRuns]
  )

  const onStopLoopInWorkspace = useCallback(
    async (path: string, runId: string): Promise<void> => {
      const res = await window.vyotiq?.setLoop({ workspacePath: path, runId, action: 'stop' })
      if (!res) return
      if (!res.ok) {
        pushToast(res.error, 'error')
        return
      }
      await refreshWorkspaceRuns(path)
    },
    [refreshWorkspaceRuns]
  )

  /** Home's Deny / Allow once, through the run's own controller so its record clears at once. */
  const onRespondApprovalFromHome = useCallback(
    async (path: string, runId: string, requestId: string, decision: ToolApprovalDecision): Promise<void> => {
      const controller = getRunController(runId, path)
      if (!controller) throw new Error('That task could not be reached.')
      await controller.respondToApproval(requestId, decision)
    },
    [getRunController]
  )

  const onReviewChangesInWorkspace = useCallback(
    async (path: string, runId?: string): Promise<void> => {
      if (runId) {
        await onSelectRunInWorkspace(path, runId)
      } else {
        await switchWorkspace(path)
        setView('chat')
      }
      setOpenChangesScope('uncommitted')
      setOpenChangesRequest((request) => request + 1)
    },
    [onSelectRunInWorkspace, switchWorkspace]
  )

  /** A finished task's Review: the task, with Changes on what this task changed. */
  const onReviewTask = useCallback(
    async (path: string, runId: string): Promise<void> => {
      await onSelectRunInWorkspace(path, runId)
      setOpenChangesScope('agent')
      setOpenChangesRequest((request) => request + 1)
    },
    [onSelectRunInWorkspace]
  )

  /** Set up's folder picker: opens it here, and stays on Set up for step 3. */
  const setupChooseFolder = useCallback(async (): Promise<string | null> => {
    const res = await pickWorkspace()
    // A picker that failed is already the window's banner (useSettings).
    if (!res.ok || !res.data) return null
    let error: string | null = null
    await addWorkspace(res.data, { onError: (message) => (error = message) })
    return error
  }, [addWorkspace, pickWorkspace])

  const setupOpenPath = useCallback(
    async (path: string): Promise<string | null> => {
      let error: string | null = null
      await addWorkspace(path, { onError: (message) => (error = message) })
      return error
    },
    [addWorkspace]
  )

  /**
   * Set up's Start: save the approval choice, then send the instruction it held
   * back, back where it was written — or, with none held, open a new brief.
   */
  const setupStart = useCallback(
    async (path: string, mode: ToolApprovalMode): Promise<string | null> => {
      const res = await update({
        toolApproval: { ...settings.toolApproval, mode },
        toolApprovalOnboardingDone: true
      })
      // Said on Set up itself: the window's settings banner is not on screen there.
      if (!res.ok) return res.error
      if (pendingSendRef.current) {
        // Taken before the view changes, so leaving Set up can't drop it first.
        const sent = flushPendingSend()
        setupSendShownRef.current = false
        setSetupSend(null)
        setView('chat')
        // A send that fails keeps its text in the composer; nothing to say here.
        await sent.catch(() => false)
        return null
      }
      onNewSessionInWorkspace(path, '')
      return null
    },
    [flushPendingSend, onNewSessionInWorkspace, settings.toolApproval, update]
  )

  // Drafts of the open workspaces. A new task (the count moving) reads them
  // again: main removes the draft a task was started from.
  const taskDrafts = useTaskDrafts(openWorkspaces, taskCount)
  // The draft New task is continuing, while New task is what is on screen.
  const newTaskWorkspace = focusedWorkspacePath ?? activeWorkspace
  const continuedDraftId = useBriefState(newTaskWorkspace).draftId
  const openDraft =
    view === 'chat' && !focusedRunId && newTaskWorkspace && continuedDraftId
      ? { workspacePath: newTaskWorkspace, draftId: continuedDraftId }
      : null

  /** Continue a draft on New task — after asking, when that page holds unsaved work. */
  const openTaskDraft = useCallback(
    async (path: string, draft: TaskDraft): Promise<void> => {
      const current = briefStateFor(path)
      if (current.draftId !== draft.id) {
        const text = resolveHotComposerDraft(getWorkspaceHotUi(path), null)
        const key = composerAttachmentKey(path, null)
        const attached = key ? getComposerAttachments(key) : null
        const unsaved =
          text.trim().length > 0 ||
          current.checks.length > 0 ||
          (attached != null &&
            attached.images.length + attached.files.length + attached.nativeFiles.length + attached.audio.length > 0)
        if (unsaved) {
          const replace = await confirm(
            'What is on New task now isn’t saved. Opening the draft replaces it.',
            { title: `Open “${draftTitle(draft)}”?`, confirmLabel: 'Open draft' }
          )
          if (!replace) return
        }
      }
      setBriefState(path, { ...briefStateFor(path), draftId: draft.id, checks: draft.doneWhen })
      setComposerDraftForPane(path, null, draft.brief)
      const key = composerAttachmentKey(path, null)
      if (key) {
        setComposerAttachments(key, {
          images: draft.attachments?.images ?? [],
          files: draft.attachments?.files ?? [],
          nativeFiles: draft.attachments?.nativeFiles ?? [],
          audio: draft.attachments?.audio ?? []
        })
      }
      // The text lands again once the workspace switch settles (as Home's does).
      onNewSessionInWorkspace(path, draft.brief)
    },
    [confirm, onNewSessionInWorkspace, setComposerDraftForPane]
  )

  const deleteTaskDraft = useCallback(async (path: string, draft: TaskDraft): Promise<void> => {
    const res = await deleteTaskDraftFor(path, draft.id)
    if (!res.ok) {
      pushToast(`Couldn’t delete the draft: ${res.error}`, 'error')
      return
    }
    pushToast('Draft deleted', {
      detail: draftTitle(draft),
      icon: 'trash',
      action: {
        label: 'Undo',
        onClick: () => {
          void saveTaskDraftFor({
            workspacePath: path,
            brief: draft.brief,
            doneWhen: draft.doneWhen,
            ...(draft.attachments ? { attachments: draft.attachments } : {})
          })
        }
      }
    })
  }, [])

  const draftActions = useMemo(
    () => ({
      onOpen: (path: string, draft: TaskDraft) => void openTaskDraft(path, draft),
      onDelete: (path: string, draft: TaskDraft) => void deleteTaskDraft(path, draft)
    }),
    [openTaskDraft, deleteTaskDraft]
  )

  const runsByWorkspacePath = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(contexts).map(([path, ctx]) => {
          const liveParentId =
            activeWorkspace && workspacePathsEqual(path, activeWorkspace)
              ? (chat.runId ?? ctx.activeRunId)
              : ctx.activeRunId
          const liveInstances =
            activeWorkspace && workspacePathsEqual(path, activeWorkspace)
              ? chat.agentInstances
              : undefined
          // Older pages stay in ctx.olderRuns across refreshes; a run there can
          // also re-enter the fresh top cap after activity — dedupe by runId.
          const seen = new Set(ctx.runs.map((r) => r.runId))
          const mergedRuns = [
            ...ctx.runs,
            ...ctx.olderRuns.filter((r) => !seen.has(r.runId))
          ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          return [
            path,
            {
              runs: mergedRuns,
              instanceRuns: mergeLiveInstanceRuns(
                ctx.instanceRuns ?? [],
                liveInstances,
                liveParentId
              ),
              runsCapped: ctx.runsCapped,
              runsError: ctx.runsError,
              runsLoaded: ctx.runsLoaded,
              activeRunId: ctx.activeRunId
            }
          ]
        })
      ),
    [contexts, activeWorkspace, chat.runId, chat.agentInstances]
  )

  const focusedRun =
    focusedRunId && (focusedWorkspacePath ?? activeWorkspace)
      ? {
          workspacePath: (focusedWorkspacePath ?? activeWorkspace)!,
          runId: focusedRunId,
          // The instance open in place of its record, marked under its task in the list.
          instanceRunId: focusedRunId === focusedParentRunId ? focusedOpenInstance : null
        }
      : null

  const shellWorkspaceProps = {
    openWorkspaces,
    activeRuns,
    activeRunsLoaded,
    runsByWorkspacePath,
    focusedRun,
    isRunOpenInPane: isSessionOpenInPane,
    onDismissRunsError: clearRunsError,
    onSwitchWorkspace: (path: string) => {
      setOpenInstanceByParent({})
      void switchWorkspace(path)
    },
    onCloseWorkspace,
    onAddWorkspace: onPickWorkspace,
    recentWorkspaces: setupRecents(registry?.recentPaths ?? [], openWorkspaces, scratchPath?.path ?? null),
    onOpenRecentWorkspace: (path: string) => {
      void addWorkspace(path).then((added) => {
        if (added) handoffToChatAfterWorkspaceAdd(added.activePath, added.activeRunId)
      })
    },
    onNewChatInWorkspace,
    onNewTaskWithText: onNewSessionInWorkspace,
    onSelectRunInWorkspace: (path: string, runId: string) => void onSelectRunInWorkspace(path, runId),
    onOpenRunBeside: (path: string, runId: string) => {
      const pane = getFocusedPane()
      if (!pane || !pane.runId) {
        void onSelectRunInWorkspace(path, runId)
        setView('chat')
        return
      }
      handleSessionDrop(pane.paneId, 'right', { workspacePath: path, runId })
    },
    onRenameRunInWorkspace: (path: string, runId: string, goal: string) =>
      void onRenameRunInWorkspace(path, runId, goal),
    onDeleteRunInWorkspace: (path: string, runId: string) => void onDeleteRunInWorkspace(path, runId),
    onExportRunInWorkspace: (path: string, runId: string) => void onExportRunInWorkspace(path, runId),
    onCopyRunLinkInWorkspace,
    onLoadOlderRuns: (path: string) => void loadOlderWorkspaceRuns(path),
    onOpenWorkspaceFile: (path: string, file: string) => {
      if (!activeWorkspace || !workspacePathsEqual(path, activeWorkspace)) void switchWorkspace(path)
      setView('chat')
      requestOpenWorkspaceFile(path, file)
    }
  }

  if (loading || setupUndecided) {
    return (
      <AppShell
        view="chat"
        workspacePath={null}
        onOpenSettings={() => {}}
        onOpenMarketplace={() => {}}
        onOpenChat={() => {}}
        onOpenHome={() => {}}
        onOpenUsage={() => {}}
        onNewChat={() => {}}
        {...shellWorkspaceProps}
        loading
      >
        <PaneSkeleton label="Loading Agent V…" />
      </AppShell>
    )
  }

  return (
    <AppShell
      view={view}
      workspacePath={activeWorkspace}
      firstRun={view === 'home' && setupFirstRun ? { workspace: setupChosenWorkspace } : null}
      drafts={{ items: taskDrafts, actions: draftActions, open: openDraft }}
      onOpenSettings={() => {
        setView('settings')
      }}
      onOpenFeedback={() => {
        setSettingsSection('about')
        setView('settings')
        setFeedbackOpen(true)
      }}
      onOpenSettingsSection={(section) => {
        setSettingsSection(section)
        setView('settings')
      }}
      onOpenMarketplace={() => setView('marketplace')}
      onAppearanceChange={onAppearanceChange}
      appearance={{ theme: settings.theme, skinId: settings.skinId }}
      onArchiveRuns={onArchiveRuns}
      onDeleteRuns={(items) => void onDeleteRunsInWorkspace(items)}
      onOpenChat={() => setView('chat')}
      onOpenHome={() => setView('home')}
      onOpenUsage={() => setView('usage')}
      onNewChat={onNewChat}
      pinnedRunKeys={settings.pinnedRuns}
      onTogglePinnedRun={onTogglePinnedRun}
      archivedRunKeys={settings.archivedRuns}
      onToggleArchivedRun={onToggleArchivedRun}
      onRespondApproval={onRespondApprovalFromHome}
      onStopRunInWorkspace={(path, runId) => void onStopRunInWorkspace(path, runId)}
      onResumeRunInWorkspace={(path, runId) => void onResumeRunInWorkspace(path, runId)}
      onRetryRunInWorkspace={(path, runId) => void onRetryRunInWorkspace(path, runId)}
      onForkRunInWorkspace={(path, runId) => void paneRunActionsRef.current.fork(path, runId)}
      onImportTask={(path) => void onImportTaskInWorkspace(path)}
      onPauseGoalInWorkspace={(path, runId, live) => void onPauseGoalInWorkspace(path, runId, live)}
      onStopLoopInWorkspace={(path, runId) => void onStopLoopInWorkspace(path, runId)}
      onReviewTask={(path, runId) => void onReviewTask(path, runId)}
      running={chat.running || chat.pendingRun}
      onChatStop={onChatStop}
      onCloseChat={() => {
        const id = chat.runId ?? getFocusedPane()?.runId
        if (id) closeRunTab(id)
      }}
      onSplitPane={onSplitPane}
      {...shellWorkspaceProps}
    >
      {view === 'settings' ? (
        <ErrorBoundary title="Settings couldn't render" resetKey={settingsSection}>
          <Suspense fallback={<ViewSuspenseFallback />}>
            <SettingsView
            settings={settings}
            secrets={secrets}
            encryptionAvailable={encryptionAvailable}
            secretsLoadError={secretsLoadError}
            appError={settingsError}
            onDismissAppError={() => setSettingsError(null)}
            backRef={settingsBackRef}
            section={settingsSection}
            onSectionChange={setSettingsSection}
            feedbackOpen={feedbackOpen}
            onFeedbackOpenChange={setFeedbackOpen}
            backLabel={SETTINGS_BACK_LABELS[settingsReturn]}
            onClose={() => setView(settingsReturn)}
            onUpdate={update}
            onSaveSecret={saveSecret}
            onClearSecret={removeSecret}
            onAppearanceChange={onAppearanceChange}
            customCssError={customCssError}
            onPickWorkspace={async () => {
              const res = await pickWorkspace()
              if (res.ok && res.data) {
                const added = await addWorkspace(res.data)
                if (added) handoffToChatAfterWorkspaceAdd(added.activePath, added.activeRunId)
              }
              return res
            }}
            activeWorkspacePath={focusedWorkspacePath ?? activeWorkspace}
            openWorkspaces={openWorkspaces}
            settingsOverridesByPath={registry?.settingsOverridesByPath ?? {}}
            effectiveChatSettings={effectiveChatSettings}
            onSetSettingsOverride={setSettingsOverride}
            onModelsRefreshed={() => setModelsRefreshNonce((n) => n + 1)}
            onOpenMarketplace={(tab) => {
              setMarketplaceFocusTab(tab)
              setView('marketplace')
            }}
            />
          </Suspense>
        </ErrorBoundary>
      ) : view === 'marketplace' ? (
        <ErrorBoundary
          title="Extensions couldn't render"
          resetKey={`${marketplaceFocusServerId ?? ''}:${marketplaceFocusSkillPath ?? ''}:${marketplaceFocusRulePath ?? ''}:marketplace`}
        >
          <Suspense fallback={<ViewSuspenseFallback />}>
            <MarketplaceView
            settings={settings}
            onUpdate={update}
            onReloadSettings={refresh}
            activeWorkspacePath={focusedWorkspacePath ?? activeWorkspace}
            settingsOverridesByPath={registry?.settingsOverridesByPath ?? {}}
            onSetSettingsOverride={setSettingsOverride}
            focusServerId={marketplaceFocusServerId}
            focusSkillPath={marketplaceFocusSkillPath}
            focusRulePath={marketplaceFocusRulePath}
            focusManageTab={marketplaceFocusTab}
            onFocusManageTabConsumed={() => setMarketplaceFocusTab(null)}
            onFocusServerConsumed={() => setMarketplaceFocusServerId(null)}
            onFocusSkillConsumed={() => setMarketplaceFocusSkillPath(null)}
            onFocusRuleConsumed={() => setMarketplaceFocusRulePath(null)}
            onClose={() => setView('chat')}
          />
          </Suspense>
        </ErrorBoundary>
      ) : view === 'home' && showSetup ? (
        <ErrorBoundary title="Set up couldn't render" resetKey="setup">
          <Suspense fallback={<ViewSuspenseFallback />}>
            <SetupPage
              settings={settings}
              secrets={secrets}
              workspace={setupChosenWorkspace}
              recents={setupRecents(registry?.recentPaths ?? [], openWorkspaces, scratchPath?.path ?? null)}
              // The shipped default (off) is nobody's choice: Set up starts on the
              // recommended mode unless one was set in Settings before this.
              approvalMode={setupStartingMode(settings.toolApproval.mode)}
              mcpProtection={settings.toolApproval.mcpProtection !== false}
              onChangeProvider={() => {
                setSettingsSection('providers')
                setView('settings')
              }}
              onChooseFolder={setupChooseFolder}
              onOpenPath={setupOpenPath}
              onStart={setupStart}
              next={setupSend ? 'send' : setupFirstRun ? 'first-task' : 'task'}
            />
          </Suspense>
        </ErrorBoundary>
      ) : view === 'home' ? (
        <ErrorBoundary title="Home couldn't render" resetKey="home">
          <Suspense fallback={<ViewSuspenseFallback />}>
            <HomePage
              openWorkspaces={openWorkspaces}
              activeWorkspace={activeWorkspace}
              runsByWorkspacePath={runsByWorkspacePath}
              activeRuns={shellWorkspaceProps.activeRuns}
              providerIssue={homeProviderIssue}
              onNewTaskInWorkspace={(path) => onNewSessionInWorkspace(path, '')}
              onOpenTask={shellWorkspaceProps.onSelectRunInWorkspace}
              onOpenWorkspace={(path) => {
                shellWorkspaceProps.onSwitchWorkspace(path)
                requestNavigatorScope(path)
              }}
              onAddWorkspace={shellWorkspaceProps.onAddWorkspace}
              onRespondApproval={onRespondApprovalFromHome}
              onOpenProviderSettings={() => {
                setSettingsSection('providers')
                setView('settings')
              }}
              onOpenMcpServer={(serverId) => {
                setMarketplaceFocusServerId(serverId)
                setView('marketplace')
              }}
              onReviewChangesInWorkspace={(path) => void onReviewChangesInWorkspace(path)}
              onOpenUsage={() => setView('usage')}
              refreshVersion={homeRefreshVersion}
            />
          </Suspense>
        </ErrorBoundary>
      ) : view === 'usage' ? (
        <ErrorBoundary title="Usage couldn't render" resetKey="usage">
          <Suspense fallback={<ViewSuspenseFallback />}>
            <UsagePage
              openWorkspaces={openWorkspaces}
              onOpenTask={shellWorkspaceProps.onSelectRunInWorkspace}
              refreshVersion={homeRefreshVersion}
            />
          </Suspense>
        </ErrorBoundary>
      ) : (
        <ErrorBoundary title="Task couldn't render" resetKey={chatSurfaceEpoch}>
          <ChatView
            items={chat.items}
            itemsStore={chat.itemsStore}
            running={chat.running}
            invokeId={chat.invokeId}
            pendingRun={chat.pendingRun}
            workspacePath={focusedWorkspacePath ?? activeWorkspace}
            activeRunId={chat.runId ?? activeContext?.activeRunId ?? null}
            headingRef={chatHeadingRef}
            taskTitle={chatTaskTitle}
            onSend={onChatSend}
            onStop={onChatStop}
            canUndoWrites={Boolean(chat.writeCheckpoint && !chat.writeCheckpoint.undone)}
            undoBusy={undoBusy}
            resolveBlockedReason={
              chat.running ? 'Stop the run to Keep/Discard agent writes.' : null
            }
            onUndoWrites={onUndoWrites}
            writeFileResolutions={writeFileResolutions}
            writeResolvablePaths={writeResolvablePaths}
            writeConflictedPaths={writeConflictedPaths}
            writeCheckpointFiles={writeCheckpointFiles}
            onKeepWriteFile={onKeepWriteFile}
            onDiscardWriteFile={onDiscardWriteFile}
            onKeepAllWrites={onKeepAllWrites}
            settle={settleActions}
            multiPane={multiPaneConfig}
            loadError={registry ? null : workspaceError}
            onPaneCapacityChange={setPaneCapacityContext}
            paneCount={paneLayout?.panes.length ?? 1}
            openChangesRequest={openChangesRequest}
            openChangesScope={openChangesScope}
            onOpenChangesRequestHandled={consumeOpenChangesRequest}
          />
        </ErrorBoundary>
      )}
      <LiveRegion />
      <ToastHost />
      {confirmDialog}
      {linkFolderDialog}
      {rewindDialog}
    </AppShell>
  )
}

export default App
