import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AppShell } from './AppShell'
import { requestOpenWorkspaceFile } from '@renderer/lib/chat/workspaceFileRequests'
import { launchViewFor } from './launchView'
import { needsDraftChatAfterWorkspaceAdd } from './workspaceAddHandoff'
import { pinnedRunKey, prunePinnedRun, togglePinnedRun } from '../features/home/pinnedRuns'
import { requestNavigatorScope } from './navigator/useNavigatorScope'
import { ChatView } from '../features/chat/ChatView'
import { SessionChatColumn } from '../features/chat/SessionChatColumn'
import { AgentInstancePane } from '../features/chat/components/AgentInstancePane'
import { runTitle } from './navigator/runTitle'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import type { ChatPane } from '@renderer/lib/chat/chatPaneLayout'
import type { PaneRenderOptions } from '../features/chat/ChatPaneHost'
import type { SettingsSection } from '../features/settings'
import { useAppearance } from '@renderer/lib/hooks/useAppearance'
import { useCustomSkinCss } from '@renderer/lib/hooks/useCustomSkinCss'
import { pickAppearanceSettings, stepFontScale, DEFAULT_FONT_SCALE } from '@shared/appearance'
import { useSettings } from '@renderer/lib/hooks/useSettings'
import { useWorkspaceManager, resolveComposerDraft } from '@renderer/lib/hooks/useWorkspaceManager'
import { useAgentProfiles } from '@renderer/lib/hooks/useAgentProfiles'
import type { WorkspaceContext } from '@renderer/lib/hooks/useWorkspaceManager'
import { ErrorBoundary } from '@renderer/lib/ErrorBoundary'
import { ToastHost, pushToast } from '@renderer/lib/ui'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import { focusComposerMessage } from '@renderer/lib/shortcuts'
import { useLiveAnnouncer } from '@renderer/lib/a11y'
import type {
  ProviderId,
  SecretProvider,
  ServiceTier,
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
import { ToolApprovalOnboardingModal } from '../features/chat/components/ToolApprovalOnboardingModal'
import { useOfflineSendQueue } from '@renderer/lib/hooks/useOfflineSendQueue'
import {
  removeOfflineQueueEntriesForRun,
  resolveOfflineFlushTarget
} from '@renderer/lib/hooks/offlineQueueStore'
import {
  clearComposerAttachments,
  composerAttachmentKey
} from '@renderer/lib/hooks/composerAttachmentStore'
import { mergeLiveInstanceRuns } from './mergeLiveInstanceRuns'
import type { SlashClientHandlers } from '../features/chat/components/composer/slashCommandExecute'
import { formatLoopStatusLine, loopUsageMessage, parseLoopCommand } from '@shared/goalRuntime'
import type {
  ChatStreamController,
  RevertWritesOutcome
} from '@renderer/lib/hooks/createChatStreamController'
import { rewoundToastText, useRewindDialog } from '@renderer/features/task/RewindDialog'
import { needsSetup, setupRecents, setupWorkspace } from '@renderer/features/setup/setupModel'

/** Full-screen secondary views are code-split; they parse on first open, not at boot. */
const SettingsView = lazy(() =>
  import('../features/settings').then((m) => ({ default: m.SettingsView }))
)
const MarketplaceView = lazy(() =>
  import('../features/marketplace').then((m) => ({ default: m.MarketplaceView }))
)
const TeammatesView = lazy(() =>
  import('../features/teammates').then((m) => ({ default: m.TeammatesView }))
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

function ViewSuspenseFallback() {
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-hidden p-6" aria-busy="true">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 animate-pulse">
        <div className="h-4 w-2/5 rounded bg-surface" />
        <div className="h-4 w-3/5 rounded bg-surface" />
        <div className="h-4 w-1/3 rounded bg-surface" />
      </div>
    </div>
  )
}

/** Sent as a visible user turn when resuming a run that was cut short. */
const CONTINUE_PROMPT = 'Continue from where you stopped.'

/** Settings' Back names the view it returns to. */
const SETTINGS_BACK_LABELS = {
  chat: 'Back to the task',
  home: 'Back to Home',
  usage: 'Back to Usage',
  marketplace: 'Back to Extensions',
  teammates: 'Back to Teammates'
} as const

function modelsRefreshKeyFor(
  chatSettings: {
    provider: string
    ollamaBaseUrl?: string
    customOpenAiBaseUrl?: string
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
  return `${providerKey}:${nonce}`
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
    (workspacePath: string): { provider: ProviderId; model: string } | null => {
      if (!workspacePath) return null
      const ctx = findByWorkspacePath(contextsForModelRef.current, workspacePath)
      const effective = resolveEffectiveSettings(settings, ctx?.settingsOverride)
      return { provider: effective.provider, model: effective.model }
    },
    [settings]
  )
  const { profiles: rosterProfiles, ready: rosterReady } = useAgentProfiles()
  const workspace = useWorkspaceManager({
    openInstanceRunIds,
    getDefaultProviderModelForWorkspace,
    getAgentProfileModelPin: (profileId) =>
      rosterProfiles.find((p) => p.id === profileId)?.model ?? null,
    getValidAgentProfileIds: () =>
      rosterReady ? new Set(rosterProfiles.map((profile) => profile.id)) : null,
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
    onLoadToolContent,
    onThinkingToggle,
    onToolToggle,
    onGroupToggle,
    onTurnToggle,
    onApprovalDecision,
    onQuestionSubmit,
    collapsedTurns,
    openRunTab,
    openRunInWorkspace,
    newChatInWorkspace,
    closeRunTab,
    purgeDeletedRunUi,
    setSessionQuery,
    addWorkspace,
    switchWorkspace,
    removeWorkspace,
    getRunController,
    loadRunIntoTab: loadRunTranscriptIntoTab,
    refreshActiveRuns,
    refreshWorkspaceRuns,
    loadOlderRuns: loadOlderWorkspaceRuns,
    workspaceHasBackgroundRun,
    scrollRestoreToken,
    setComposerDraft,
    setComposerDraftForPane,
    setAgentMode,
    setAgentProfileIdForRun,
    getAgentProfileIdForRun,
    pruneAgentProfileBindings,
    onMessageListScroll,
    onMessageListScrollForPane,
    setPaneCapacityContext,
    setSettingsOverride,
    workspaceError,
    clearWorkspaceError,
    clearRunsError,
    activeScrollTop,
    chatSurfaceEpoch,
    paneLayout,
    focusPaneById,
    closePaneById,
    setPaneSizesByIndex,
    dropSessionOnPane,
    isSessionOpenInPane,
    isSessionFocusedInPane,
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

  // A deleted teammate must never ride a stale binding into chatStart — main
  // rejects the whole send ('Unknown agent profile'). Prune every chat's
  // binding that no longer resolves in the roster whenever the roster changes.
  useEffect(() => {
    if (!rosterReady) return
    pruneAgentProfileBindings(new Set(rosterProfiles.map((p) => p.id)))
  }, [rosterReady, rosterProfiles, pruneAgentProfileBindings])

  const focusedParentRunId = chat.runId ?? activeContext?.activeRunId ?? null
  contextsForModelRef.current = contexts
  const focusedOpenInstance =
    focusedParentRunId != null ? (openInstanceByParent[focusedParentRunId] ?? null) : null

  const [view, setView] = useState<'chat' | 'settings' | 'marketplace' | 'teammates' | 'home' | 'usage'>('chat')
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
      if (previous === 'settings' || previous === 'marketplace' || previous === 'teammates')
        return
      requestAnimationFrame(() => requestAnimationFrame(() => {
        focusComposerMessage()
      }))
    }
  }, [view])

  // Set up is the first run: no approval choice recorded, and no task in any open
  // workspace. Until the open workspaces' task lists have loaded that can't be
  // told, so a returning user never sees Set up flash by on the way to Home.
  // Once told it stays told — a folder opened from Set up loads its tasks too.
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
  const showSetup = !setupUndecided && needsSetup(settings.toolApprovalOnboardingDone, taskCount)

  // Navigation-mode preference applies once settings have loaded. During load the
  // shell keeps the established chat skeleton; the launch view lands before the
  // first post-load paint (useLayoutEffect) so no wrong surface flashes. A first
  // run lands on Home, where Set up lives.
  const launchViewAppliedRef = useRef(false)
  useLayoutEffect(() => {
    if (loading || setupUndecided || launchViewAppliedRef.current) return
    launchViewAppliedRef.current = true
    setView(showSetup ? 'home' : launchViewFor(settings.navigationMode))
  }, [loading, setupUndecided, showSetup, settings.navigationMode])

  useLayoutEffect(() => {
    hydrate(
      pickAppearanceSettings({
        theme: settings.theme,
        fontScale: settings.fontScale,
        uiDensity: settings.uiDensity,
        skinId: settings.skinId,
        customCssPath: settings.customCssPath
      })
    )
  }, [
    settings.theme,
    settings.fontScale,
    settings.uiDensity,
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

  const onProviderModelForWorkspace = useCallback((
    workspacePath: string | null | undefined,
    provider: ProviderId,
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

  const onProviderModel = (provider: ProviderId, model: string): void => {
    onProviderModelForWorkspace(focusedWorkspacePath ?? activeWorkspace, provider, model)
  }

  /** Pin a model change to the session that made it, then update the shared default. */
  const onSessionProviderModel = (
    runId: string | null,
    workspacePath: string | null | undefined,
    provider: ProviderId,
    model: string
  ): void => {
    if (!workspacePath) return
    getRunController(runId, workspacePath)?.setProviderModel(provider, model)
  }

  const onToggleFavorite = useCallback((provider: ProviderId, model: string): void => {
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

  const onServiceTierChange = (tier: ServiceTier): void => {
    const key = modelSelectionKey(effectiveChatSettings.provider, effectiveChatSettings.model)
    void update({
      serviceTier: tier,
      serviceTierByModel: { ...settings.serviceTierByModel, [key]: tier }
    })
  }

  const onChatSettingsChange = (patch: ChatSettingsPatch): void => {
    onChatSettingsChangeForWorkspace(
      focusedWorkspacePath ?? activeWorkspace,
      patch,
      effectiveChatSettings
    )
  }

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

  // Session-pinned model: what this session actually uses and displays; falls back to
  // the shared effective settings until the session's first send (or a composer change
  // made in this session) pins it — a model change in a different session cannot bleed in.
  const focusedSessionModel = chat.providerModel
  const focusedChatSettings = focusedSessionModel
    ? {
        ...effectiveChatSettings,
        provider: focusedSessionModel.provider,
        model: focusedSessionModel.model
      }
    : effectiveChatSettings

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

  const modelsRefreshKey = modelsRefreshKeyFor(
    effectiveChatSettings,
    secrets,
    modelsRefreshNonce
  )

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

  /** Route a vyotiq:// payload to the right chat, adding the workspace if needed. */
  const handleDeepLinkPayload = useCallback(
    async (payload: import('@shared/ipc').DeepLinkPayload): Promise<void> => {
      const { target } = payload
      if (!target) {
        pushToast('Unrecognized Vyotiq link.', 'error')
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
          pushToast('That chat is not in any open workspace.', 'error')
          return
        }
        path = match[0]
      }
      const isOpen = openWorkspaces.some((open) => workspacePathsEqual(open, path))
      if (!isOpen) {
        const added = await addWorkspace(path)
        if (!added) {
          pushToast('Could not open the workspace for that link.', 'error')
          return
        }
      }
      await onSelectRunInWorkspace(path, target.runId)
    },
    [addWorkspace, contexts, onSelectRunInWorkspace, openWorkspaces]
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
        pushToast('The workspace for that chat is not open.')
        return false
      }
      const ok = dropSessionOnPane(anchorPaneId, zone, payload)
      if (!ok) {
        pushToast('Not enough room for another chat pane.')
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
      if (!run) return 'Chat'
      return runTitle(run) || 'Chat'
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
      pushToast('Send a message in this pane first.')
      return
    }
    if (!splitFocusedPane()) {
      pushToast('Not enough room for another chat pane.')
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

  // Async when the target workspace differs (switch IPC runs first): bounded
  // retry so focus lands once the composer mounts (AppShell search-focus pattern).
  const onNewChatInWorkspace = useCallback(
    (path: string): void => {
      setOpenInstanceByParent({})
      void newChatInWorkspace(path)
      setView('chat')
      let attempts = 0
      const tryFocus = (): void => {
        if (focusComposerMessage()) return
        if (attempts++ < 10) window.setTimeout(tryFocus, 0)
      }
      window.setTimeout(tryFocus, 0)
    },
    [newChatInWorkspace]
  )

  // Teammate rows: fresh chat in the active workspace, bound to the profile so
  // the first send already carries identity + the profile's memory namespace.
  const onStartTeammateChat = useCallback(
    (profileId: string): void => {
      const path = workspace.focusedWorkspacePath ?? workspace.activeWorkspace
      if (!path) return
      setAgentProfileIdForRun(path, null, profileId)
      onNewChatInWorkspace(path)
    },
    [workspace.focusedWorkspacePath, workspace.activeWorkspace, setAgentProfileIdForRun, onNewChatInWorkspace]
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
      let attempts = 0
      const tryFocus = (): void => {
        if (focusComposerMessage()) return
        if (attempts++ < 10) window.setTimeout(tryFocus, 0)
      }
      window.setTimeout(tryFocus, 0)
    },
    [newChatInWorkspace, setComposerDraftForPane]
  )

  // Where a new task's brief can move: the open workspaces, named as the navigator names them.
  const newTaskTargets = useMemo(
    () => ({
      workspaces: openWorkspaces.map((path) => ({ path, name: formatWorkspaceName(path) })),
      onMove: onNewSessionInWorkspace
    }),
    [openWorkspaces, onNewSessionInWorkspace]
  )

  const focusComposerSoon = useCallback((): void => {
    let attempts = 0
    const tryFocus = (): void => {
      if (focusComposerMessage()) return
      if (attempts++ < 10) window.setTimeout(tryFocus, 0)
    }
    window.setTimeout(tryFocus, 0)
  }, [])

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
  const [approvalOnboardingOpen, setApprovalOnboardingOpen] = useState(false)
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
  const agentSessionContext = focusedWorkspacePath
    ? (findByWorkspacePath(contexts, focusedWorkspacePath) ?? activeContext)
    : activeContext

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
    }
    return ok
  }, [setComposerDraftForPane])

  const completeApprovalOnboarding = useCallback(
    async (mode: ToolApprovalMode) => {
      const res = await update({
        toolApproval: { ...settings.toolApproval, mode },
        toolApprovalOnboardingDone: true
      })
      if (!res.ok) return
      setApprovalOnboardingOpen(false)
      await flushPendingSend()
    },
    [flushPendingSend, settings.toolApproval, update]
  )

  const dismissApprovalOnboarding = useCallback(() => {
    // Close without sending and without marking onboarding done or forcing Off.
    // The next send re-opens the modal until the user picks an explicit mode.
    pendingSendRef.current = null
    setApprovalOnboardingOpen(false)
  }, [])

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
    ) => {
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
        setApprovalOnboardingOpen(true)
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
   * Home's Start: a new task in that workspace, sent at once through the same
   * onboarding gate, offline queue and controller the brief's Start task uses.
   * With no key for the provider nothing could run, so the brief opens with the
   * text in it instead, where the missing key is spelled out.
   */
  const onStartTaskFromHome = useCallback(
    (path: string, brief: string): void => {
      if (homeProviderIssue) {
        onNewSessionInWorkspace(path, brief)
        return
      }
      setOpenInstanceByParent({})
      setView('chat')
      void newChatInWorkspace(path).then(() =>
        gateSendWithOnboarding(
          (text, images, files, extras) =>
            sendWithOfflineQueue(
              text,
              images,
              files,
              extras,
              (t, i, f, e) => getRunControllerRef.current(null, path)?.send(t, i, f, e) ?? false,
              { runId: null, workspacePath: path }
            ),
          brief,
          undefined,
          undefined,
          undefined,
          { workspacePath: path, runId: null }
        )
      )
    },
    [gateSendWithOnboarding, homeProviderIssue, newChatInWorkspace, onNewSessionInWorkspace, sendWithOfflineQueue]
  )

  const onChatEditAndResend = useCallback(
    async (
      editMessageIndex: number,
      text: string,
      images?: string[],
      files?: AttachedFile[],
      extras?: import('@shared/ipc').ComposerSendExtras
    ) => {
      return (
        chatActionsRef.current?.editAndResend?.(editMessageIndex, text, images, files, extras) ??
        false
      )
    },
    []
  )

  const { confirm, dialog: confirmDialog } = useConfirm()
  const { askRewind, dialog: rewindDialog } = useRewindDialog()

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
        preview: (index: number) => Promise<ChatRewindPreviewResult | null>
        revert: (index: number) => Promise<RevertWritesOutcome | false>
      }
    ): Promise<boolean> => {
      const preview = await io.preview(userMessageIndex)
      const ok = await askRewind({ runN: runN ?? null, files: preview?.files ?? null })
      if (!ok) return false
      const done = await io.revert(userMessageIndex)
      if (done) {
        pushToast(rewoundToastText(runN ?? null, done), 'success')
        // The rewound edits no longer wait on Keep or Undo.
        if (io.workspacePath) refreshWorkspaceRuns(io.workspacePath)
      }
      return done !== false
    },
    [askRewind, refreshWorkspaceRuns]
  )

  const onChatRevertToUserMessage = useCallback(
    (userMessageIndex: number, runN?: number) => {
      const actions = chatActionsRef.current
      return confirmRevertToUserMessage(
        userMessageIndex,
        runN,
        {
          workspacePath: focusedWorkspacePath ?? activeWorkspace,
          preview: (i) => actions?.previewRewindToUserMessage?.(i) ?? Promise.resolve(null),
          revert: (i) => actions?.revertToUserMessage?.(i) ?? Promise.resolve(false)
        }
      )
    },
    [activeWorkspace, confirmRevertToUserMessage, focusedWorkspacePath]
  )

  const onChatStop = useCallback(() => {
    void chatActionsRef.current?.stop()
  }, [])

  const onRemoveFollowUp = useCallback((id: string) => {
    void chatActionsRef.current?.removeFollowUp?.(id)
  }, [])

  const onEditFollowUp = useCallback((id: string, text: string) => {
    return chatActionsRef.current?.editFollowUp?.(id, text) ?? false
  }, [])

  const onSendFollowUpNow = useCallback((id: string) => {
    void chatActionsRef.current?.sendFollowUpNow?.(id)
  }, [])

  const onChatContinue = useCallback(() => {
    void chatActionsRef.current?.send(CONTINUE_PROMPT)
  }, [])

  const activeRunId = chat.runId
  const [undoBusy, setUndoBusy] = useState(false)
  const onCompactContext = useCallback(
    async (focus?: string) => {
      const workspacePath = focusedWorkspacePath ?? activeWorkspace
      const runId = activeRunId
      if (!workspacePath || !runId) {
        return { ok: false as const, message: 'Compaction is unavailable.' }
      }
      chatActionsRef.current?.setCompacting?.(true)
      try {
        const res = await window.vyotiq.chatCompact(workspacePath, runId, focus)
        if (!res.ok) {
          return { ok: false as const, message: res.error }
        }
        chatActionsRef.current?.applyManualCompaction?.(res.data)
        return {
          ok: true as const,
          message: `Summarized ${res.data.messagesBefore - res.data.keptMessages} messages; ${res.data.keptMessages} kept verbatim.`
        }
      } finally {
        chatActionsRef.current?.setCompacting?.(false)
      }
    },
    [activeWorkspace, activeRunId, focusedWorkspacePath]
  )

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
    ): Promise<boolean> => {
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
      const checkpointId = writeCheckpoint?.undone
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
        // Resolved edits can take the task out of Ready for review; main has
        // already dropped its cached list, so ask for it again.
        refreshWorkspaceRuns(workspacePath)
        return true
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
    return resolveAgentWrites('discard')
  }, [resolveAgentWrites])

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
    return run ? runTitle(run) || null : null
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
          pushToast('Open a chat first.')
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
      onOpenSettings: (section?: 'voice' | 'providers' | 'agent') => {
        if (section) setSettingsSection(section)
        setView('settings')
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
      onHarnessApply: async (proposalPath?: string) => {
        if (!scope.workspacePath) {
          setSettingsError('Open a workspace to apply a harness proposal.')
          return false
        }
        const preview = await window.vyotiq.harnessPreviewApply({
          workspacePath: scope.workspacePath,
          ...(proposalPath?.trim() ? { proposalPath: proposalPath.trim() } : {})
        })
        if (!preview.ok) {
          setSettingsError(preview.error)
          return false
        }
        if (!preview.data.changed) {
          setSettingsError('Harness already matches the proposal — nothing to apply.')
          return true
        }
        const confirmed = window.confirm(
          `Apply harness proposal?\n\n${preview.data.relativePath}\n→ resources/harness/default.md only\n\nRuns fixed harness vitest subset; reverts that file on failure.\nEvaluator / gate-test changes need a normal PR.`
        )
        if (!confirmed) return false
        const res = await window.vyotiq.harnessApply({
          workspacePath: scope.workspacePath,
          ...(proposalPath?.trim() ? { proposalPath: proposalPath.trim() } : {}),
          confirm: true
        })
        if (!res.ok) {
          setSettingsError(res.error)
          return false
        }
        if (!res.data.applied) {
          setSettingsError(
            res.data.reverted
              ? `Harness apply reverted — tests failed.\n${res.data.validationOutput.slice(0, 800)}`
              : res.data.validationOutput
          )
          return false
        }
        setSettingsError(null)
        logger.info('Applied harness proposal', {
          scope: 'slash',
          path: res.data.relativePath
        })
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
          'Usage: /goal <objective> — /goal pause, /goal resume, /goal complete. Prefer a new chat.'
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

  const slashHandlersValue = useMemo(
    () =>
      createSlashHandlers({
        workspacePath: focusedWorkspacePath ?? activeWorkspace,
        runId: focusedRunId ?? chat.runId ?? null,
        running: chat.running,
        pendingRun: chat.pendingRun,
        onClear: () => {
          onNewChat()
        },
        onCompact: onCompactContext,
        onUndoWrites,
        onSetAgentMode: (mode) => {
          setAgentMode(mode, {
            workspacePath: focusedWorkspacePath ?? undefined,
            runId: focusedRunId
          })
        },
        onStop: onChatStop
      }),
    [
      activeWorkspace,
      chat.pendingRun,
      chat.runId,
      chat.running,
      createSlashHandlers,
      focusedRunId,
      focusedWorkspacePath,
      onCompactContext,
      onNewChat,
      onUndoWrites,
      onChatStop,
      setAgentMode
    ]
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
  }>({ rename: async () => {}, exportRun: async () => {}, deleteRun: async () => {} })
  const renderPaneSession = useCallback(
    (pane: ChatPane, options: PaneRenderOptions) => {
      const { focused, onShowInspector, onOpenChanges, onOpenWorkspaceFile, multi, onClose, onSplit } =
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
            onShowInspector={onShowInspector}
            showThinking={paneChatSettings.showThinking}
            onOpenWorkspaceFile={onOpenWorkspaceFile}
            approvalAutoFocus={focused}
            instanceRun={paneContext?.instanceRuns?.find((r) => r.runId === pane.runId) ?? null}
            parentTitle={parentRun ? runTitle(parentRun) : undefined}
            siblings={parentCtrl?.agentInstances}
            onOpenInstance={(siblingRunId) => {
              void openRunInWorkspace(pane.workspacePath, siblingRunId)
            }}
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
                  message: `Summarized ${res.data.messagesBefore - res.data.keptMessages} messages; ${res.data.keptMessages} kept verbatim.`
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
        onUndoWrites: () =>
          resolveAgentWrites('discard', undefined, {
            workspacePath: pane.workspacePath,
            runId: pane.runId,
            running: snap.running,
            writeCheckpoint: snap.writeCheckpoint,
            applyWriteCheckpointResolution: paneCtrl?.applyWriteCheckpointResolution.bind(paneCtrl)
          }),
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
          invokeId={snap.invokeId}
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
          showPageHeading={false}
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
          agentProfileId={getAgentProfileIdForRun(pane.workspacePath, pane.runId)}
          onAgentProfileChange={(profileId) =>
            setAgentProfileIdForRun(pane.workspacePath, pane.runId, profileId)
          }
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
            void paneCtrl?.stop()
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
                preview: (i) => paneCtrl?.previewRewindToUserMessage(i) ?? Promise.resolve(null),
                revert: (i) => paneCtrl?.revertToUserMessage(i) ?? Promise.resolve(false)
              }
            )
          }
          messages={snap.messages}
          pendingFollowUps={snap.pendingFollowUps}
          agentInstances={snap.agentInstances}
          openInstanceRunId={pane.runId ? (openInstanceByParent[pane.runId] ?? null) : null}
          onOpenInstanceRunIdChange={(id) => setOpenInstanceForParent(pane.runId, id)}
          getInstanceController={getRunController}
          onRemoveFollowUp={(id) => {
            void paneCtrl?.removeFollowUp(id)
          }}
          onEditFollowUp={(id, text) => paneCtrl?.editFollowUp(id, text) ?? false}
          onSendFollowUpNow={(id) => {
            void paneCtrl?.sendFollowUpNow(id)
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
          onShowInspector={onShowInspector}
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
            onCopyLink: pane.runId ? () => onCopyRunLinkInWorkspace(pane.workspacePath, pane.runId!) : undefined,
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
      setAgentProfileIdForRun,
      getAgentProfileIdForRun,
      settings,
      update,
      onChatSettingsChangeForWorkspace,
      onProviderModelForWorkspace,
      onToggleFavorite,
      newTaskTargets
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
    if (nextPins !== settings.pinnedRuns) {
      void update({ pinnedRuns: [...nextPins] })
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

  paneRunActionsRef.current = {
    rename: onRenameRunInWorkspace,
    exportRun: onExportRunInWorkspace,
    deleteRun: onDeleteRunInWorkspace
  }

  const onStopRunInWorkspace = useCallback(
    async (path: string, runId: string): Promise<void> => {
      const controller = getRunController(runId, path)
      if (controller) {
        await controller.stop()
      } else {
        const result = await window.vyotiq.chatCancel(runId)
        if (!result.ok) {
          pushToast(result.error, 'error')
          return
        }
      }
      await refreshWorkspaceRuns(path)
      await refreshActiveRuns()
      setHomeRefreshVersion((version) => version + 1)
    },
    [getRunController, refreshActiveRuns, refreshWorkspaceRuns]
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
      if (live) await onStopRunInWorkspace(path, runId)
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

  /** Start your first task: the approval choice is saved the way the first-send question saves it. */
  const setupStart = useCallback(
    async (path: string, mode: ToolApprovalMode): Promise<void> => {
      const res = await update({
        toolApproval: { ...settings.toolApproval, mode },
        toolApprovalOnboardingDone: true
      })
      if (!res.ok) return
      onNewSessionInWorkspace(path, '')
    },
    [onNewSessionInWorkspace, settings.toolApproval, update]
  )

  const chatError = chat.error

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
      ? { workspacePath: (focusedWorkspacePath ?? activeWorkspace)!, runId: focusedRunId }
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
        <div
          className="flex min-h-0 flex-1 flex-col gap-3 px-5 pt-6"
          role="status"
          aria-busy="true"
        >
          <span className="sr-only">Loading Agent V…</span>
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 animate-fade-in">
            <div className="h-4 w-2/5 animate-pulse rounded bg-surface" />
            <div className="h-4 w-3/5 animate-pulse rounded bg-surface" />
            <div className="h-4 w-1/3 animate-pulse rounded bg-surface" />
            <div className="mt-4 h-24 animate-pulse rounded-lg border border-border bg-surface/60" />
          </div>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell
      view={view}
      workspacePath={activeWorkspace}
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
      onOpenChat={() => setView('chat')}
      onOpenHome={() => setView('home')}
      onOpenUsage={() => setView('usage')}
      onNewChat={onNewChat}
      pinnedRunKeys={settings.pinnedRuns}
      onTogglePinnedRun={onTogglePinnedRun}
      onStopRunInWorkspace={(path, runId) => void onStopRunInWorkspace(path, runId)}
      onResumeRunInWorkspace={(path, runId) => void onResumeRunInWorkspace(path, runId)}
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
            onAppearanceChange={(partial) => {
              const prev = pickAppearanceSettings(settings)
              setAppearance(partial)
              void update(partial).then((res) => {
                if (!res.ok) setAppearance(prev)
              })
            }}
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
      ) : view === 'teammates' ? (
        <ErrorBoundary title="Teammates couldn't render" resetKey="teammates">
          <Suspense fallback={<ViewSuspenseFallback />}>
            <TeammatesView
              secrets={secrets}
              ollamaBaseUrl={settings.ollamaBaseUrl}
              customOpenAiBaseUrl={settings.customOpenAiBaseUrl}
              openWorkspaces={openWorkspaces}
              activeWorkspacePath={focusedWorkspacePath ?? activeWorkspace}
              onClose={() => setView('chat')}
              onStartTeammateChat={onStartTeammateChat}
              onOpenTaskRun={(path, runId) => void onSelectRunInWorkspace(path, runId)}
            />
          </Suspense>
        </ErrorBoundary>
      ) : view === 'home' && showSetup ? (
        <ErrorBoundary title="Set up couldn't render" resetKey="setup">
          <Suspense fallback={<ViewSuspenseFallback />}>
            <SetupPage
              settings={settings}
              secrets={secrets}
              workspace={setupWorkspace(activeWorkspace, openWorkspaces, scratchPath?.path ?? null)}
              recents={setupRecents(registry?.recentPaths ?? [], openWorkspaces, scratchPath?.path ?? null)}
              // Until someone chooses, the saved mode is only the shipped default (off);
              // Set up starts on the recommended one, as the first-send question does.
              approvalMode="mutating"
              mcpProtection={settings.toolApproval.mcpProtection !== false}
              onChangeProvider={() => {
                setSettingsSection('providers')
                setView('settings')
              }}
              onChooseFolder={setupChooseFolder}
              onOpenPath={setupOpenPath}
              onStart={setupStart}
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
              onStartTask={onStartTaskFromHome}
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
        <ErrorBoundary title="Chat couldn't render" resetKey={chatSurfaceEpoch}>
          <ChatView
            items={chat.items}
            itemsStore={chat.itemsStore}
            metaStore={chat.metaStore}
            running={chat.running}
            invokeId={chat.invokeId}
            pendingRun={chat.pendingRun}
            error={chatError}
            errorCode={chat.errorCode}
            networkWait={chat.networkWait}
            compacting={chat.compacting}
            incomplete={chat.incomplete}
            turnStatus={chat.turnStatus}
            onContinue={onChatContinue}
            contextUsage={chat.contextUsage}
            turnUsage={chat.turnUsage}
            onCompactContext={
              (focusedWorkspacePath ?? activeWorkspace) && activeRunId
                ? onCompactContext
                : undefined
            }
            operationalError={operationalError}
            hasWorkspace={Boolean(focusedWorkspacePath ?? activeWorkspace)}
            workspacePath={focusedWorkspacePath ?? activeWorkspace}
            provider={focusedChatSettings.provider}
            model={focusedChatSettings.model}
            ollamaBaseUrl={effectiveChatSettings.ollamaBaseUrl}
            customOpenAiBaseUrl={effectiveChatSettings.customOpenAiBaseUrl}
            modelsRefreshKey={modelsRefreshKey}
            secrets={secrets}
            activeRunId={chat.runId ?? activeContext?.activeRunId ?? null}
            transcriptLoading={chat.transcriptLoading}
            transcriptHasEarlier={chat.transcriptHasEarlier}
            transcriptLoadingEarlier={chat.transcriptLoadingEarlier}
            onLoadEarlierMessages={() => {
              void chatActionsRef.current?.loadEarlierMessages()
            }}
            headingRef={chatHeadingRef}
            taskTitle={chatTaskTitle}
            onProviderModel={(provider, model) => {
              onSessionProviderModel(
                focusedParentRunId,
                focusedWorkspacePath ?? activeWorkspace,
                provider,
                model
              )
              onProviderModel(provider, model)
            }}
            favoriteModels={settings.favoriteModels}
            recentModels={settings.recentModels}
            serviceTier={resolveServiceTier(
              settings,
              focusedChatSettings.provider,
              focusedChatSettings.model
            )}
            onToggleFavorite={onToggleFavorite}
            onServiceTierChange={onServiceTierChange}
            chatSettings={focusedChatSettings}
            onChatSettingsChange={onChatSettingsChange}
            agentMode={agentSessionContext?.ui.agentMode ?? 'agent'}
            onAgentModeChange={(mode) =>
              setAgentMode(mode, {
                workspacePath: focusedWorkspacePath ?? undefined,
                runId: focusedRunId
              })
            }
            agentProfileId={getAgentProfileIdForRun(
              focusedWorkspacePath ?? activeWorkspace,
              focusedRunId
            )}
            onAgentProfileChange={(profileId) =>
              setAgentProfileIdForRun(
                focusedWorkspacePath ?? activeWorkspace,
                focusedRunId,
                profileId
              )
            }
            onContinueInAgent={() => {
              setAgentMode('agent', {
                workspacePath: focusedWorkspacePath ?? undefined,
                runId: focusedRunId
              })
              setComposerDraft(
                'Implement the approved plan from plan.md (run artifact — read plan.md to load it).'
              )
            }}
            onSend={onChatSend}
            onEditAndResend={onChatEditAndResend}
            onRevertToUserMessage={onChatRevertToUserMessage}
            messages={chat.messages}
            onStop={onChatStop}
            pendingFollowUps={chat.pendingFollowUps}
            onRemoveFollowUp={onRemoveFollowUp}
            onEditFollowUp={onEditFollowUp}
            onSendFollowUpNow={onSendFollowUpNow}
            onDismissError={onDismissChatBanner}
            onComposerDraftChange={setComposerDraft}
            restoreScrollTop={activeScrollTop}
            scrollRestoreToken={scrollRestoreToken}
            onScrollTopChange={onMessageListScroll}
            chatSurfaceEpoch={chatSurfaceEpoch}
            showThinking={effectiveChatSettings.showThinking}
            onLoadToolContent={onLoadToolContent}
            onThinkingToggle={onThinkingToggle}
            onToolToggle={onToolToggle}
            onGroupToggle={onGroupToggle}
            onTurnToggle={onTurnToggle}
            collapsedTurns={collapsedTurns}
            onApprovalDecision={onApprovalDecision}
            onQuestionSubmit={onQuestionSubmit}
            mcpServerNames={mcpServerNames}
            slashHandlers={slashHandlersValue}
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
            multiPane={multiPaneConfig}
            onPaneCapacityChange={setPaneCapacityContext}
            paneCount={paneLayout?.panes.length ?? 1}
            agentInstances={chat.agentInstances}
            openInstanceRunId={focusedOpenInstance}
            onOpenInstanceRunIdChange={(id) =>
              setOpenInstanceForParent(focusedParentRunId, id)
            }
            getInstanceController={getRunController}
            openChangesRequest={openChangesRequest}
            openChangesScope={openChangesScope}
            onOpenChangesRequestHandled={consumeOpenChangesRequest}
          />
        </ErrorBoundary>
      )}
      <LiveRegion />
      <ToastHost />
      {confirmDialog}
      {rewindDialog}
      <ToolApprovalOnboardingModal
        open={approvalOnboardingOpen}
        error={settingsError}
        mcpProtection={settings.toolApproval.mcpProtection !== false}
        onChoose={(mode) => {
          void completeApprovalOnboarding(mode)
        }}
        onDismiss={() => {
          void dismissApprovalOnboarding()
        }}
      />
    </AppShell>
  )
}

export default App
