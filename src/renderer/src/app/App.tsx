import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AppShell } from './AppShell'
import { launchViewFor } from './launchView'
import { pinnedRunKey, prunePinnedRun, togglePinnedRun } from '../features/home/pinnedRuns'
import { ChatView } from '../features/chat/ChatView'
import { SessionChatColumn } from '../features/chat/SessionChatColumn'
import type { ChatPane } from '@renderer/lib/chat/chatPaneLayout'
import type { PaneRenderOptions } from '../features/chat/ChatPaneHost'
import type { SettingsSection } from '../features/settings'
import { useAppearance } from '@renderer/lib/hooks/useAppearance'
import { useCustomSkinCss } from '@renderer/lib/hooks/useCustomSkinCss'
import { pickAppearanceSettings, stepFontScale, DEFAULT_FONT_SCALE } from '@shared/appearance'
import { useSettings } from '@renderer/lib/hooks/useSettings'
import { useWorkspaceManager, resolveComposerDraft } from '@renderer/lib/hooks/useWorkspaceManager'
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
  ChatRewindPreviewResult
} from '@shared/ipc'
import { defaultModelFor } from '@shared/providers'
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
import { ConfirmFileList } from '../features/chat/components/ConfirmFileList'

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
  const workspace = useWorkspaceManager({
    openInstanceRunIds,
    getDefaultProviderModelForWorkspace
  })
  const {
    registry,
    activeWorkspace,
    openWorkspaces,
    activeContext,
    contexts,
    activeRuns,
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
    focusedRunId
  } = workspace

  const focusedParentRunId = chat.runId ?? activeContext?.activeRunId ?? null
  contextsForModelRef.current = contexts
  const focusedOpenInstance =
    focusedParentRunId != null ? (openInstanceByParent[focusedParentRunId] ?? null) : null

  const [view, setView] = useState<'chat' | 'settings' | 'marketplace' | 'home'>('chat')
  const previousViewRef = useRef(view)
  const [marketplaceFocusServerId, setMarketplaceFocusServerId] = useState<string | null>(null)
  const [marketplaceFocusSkillPath, setMarketplaceFocusSkillPath] = useState<string | null>(null)
  const [marketplaceFocusRulePath, setMarketplaceFocusRulePath] = useState<string | null>(null)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  // Lifted so the command palette can open the feedback dialog from any view.
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [modelsRefreshNonce, setModelsRefreshNonce] = useState(0)
  const [homeRefreshVersion, setHomeRefreshVersion] = useState(0)
  const [openChangesRequest, setOpenChangesRequest] = useState(0)
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

  // Navigation-mode preference applies once settings have loaded. During load the
  // shell keeps the established chat skeleton; the launch view lands before the
  // first post-load paint (useLayoutEffect) so no wrong surface flashes.
  const launchViewAppliedRef = useRef(false)
  useLayoutEffect(() => {
    if (loading || launchViewAppliedRef.current) return
    launchViewAppliedRef.current = true
    setView(launchViewFor(settings.navigationMode))
  }, [loading, settings.navigationMode])

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

  // Pin/unpin a session above the Home recency list — same data-array settings
  // pattern as favoriteModels. The cap keeps the newest pins (pinnedRuns.ts).
  const onTogglePinnedRun = useCallback(
    (key: string): void => {
      void update({ pinnedRuns: togglePinnedRun(settings.pinnedRuns, key) })
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
      if (!pane.runId) return 'New chat'
      const ctx = findByWorkspacePath(contexts, pane.workspacePath)
      const run = ctx?.runs.find((r) => r.runId === pane.runId)
      const goal = run?.goal?.trim()
      return goal || 'Chat'
    },
    [contexts]
  )

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

  const onPickWorkspace = (): void => {
    void pickWorkspace().then(async (res) => {
      if (res.ok && res.data) {
        await addWorkspace(res.data)
      }
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

  const dismissApprovalOnboarding = useCallback(async () => {
    pendingSendRef.current = null
    await update({
      toolApproval: { ...settings.toolApproval, mode: 'off' },
      toolApprovalOnboardingDone: true
    })
    setApprovalOnboardingOpen(false)
  }, [settings.toolApproval, update])

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

  const confirmRevertToUserMessage = useCallback(
    async (
      userMessageIndex: number,
      turnCount: number,
      io: {
        preview: (index: number) => Promise<ChatRewindPreviewResult | null>
        revert: (index: number) => Promise<RevertWritesOutcome | false>
      }
    ): Promise<boolean> => {
      const preview = await io.preview(userMessageIndex)
      const files = preview?.files ?? []
      const notUndoable = files.filter((f) => !f.undoable).length
      const turnText = turnCount === 1 ? '1 turn' : `${turnCount} turns`
      const baseMessage =
        files.length > 0
          ? `Revert to before this prompt? ${turnText} will be removed and ${
              files.length === 1 ? '1 file' : `${files.length} files`
            } restored to their state before the agent ran.`
          : turnCount === 1
            ? 'Revert to before this prompt? The reply and any workspace edits made after it are undone and the turn is removed from the chat.'
            : `Revert to before this prompt? ${turnCount} turns and any workspace edits made after it are undone and removed from the chat.`
      const message =
        files.length > 0 && notUndoable > 0
          ? `${baseMessage} ${
              notUndoable === 1 ? '1 file' : `${notUndoable} files`
            } can't be auto-restored and will be skipped.`
          : baseMessage
      const ok = await confirm(message, {
        title: 'Revert to earlier prompt',
        confirmLabel: 'Revert',
        danger: true,
        ...(files.length > 0 ? { details: <ConfirmFileList files={files} /> } : {})
      })
      if (!ok) return false
      const done = await io.revert(userMessageIndex)
      if (done) {
        const restored = done.restored.length
        const skipped = done.skipped.length
        let toastText = 'Reverted to the earlier prompt. Later turns were removed.'
        if (restored > 0 || skipped > 0) {
          toastText = `Reverted to the earlier prompt. ${
            restored === 1 ? '1 file' : `${restored} files`
          } restored.`
          if (skipped > 0) {
            toastText += ` ${skipped === 1 ? '1 file' : `${skipped} files`} could not be restored.`
          }
        }
        pushToast(toastText, 'success')
      }
      return done !== false
    },
    [confirm]
  )

  const onChatRevertToUserMessage = useCallback(
    (userMessageIndex: number) => {
      const actions = chatActionsRef.current
      return confirmRevertToUserMessage(
        userMessageIndex,
        Math.max(0, chat.messages.length - userMessageIndex - 1),
        {
          preview: (i) => actions?.previewRewindToUserMessage?.(i) ?? Promise.resolve(null),
          revert: (i) => actions?.revertToUserMessage?.(i) ?? Promise.resolve(false)
        }
      )
    },
    [confirmRevertToUserMessage, chat.messages]
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
      onOpenSettings: (section?: 'voice' | 'providers') => {
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
        `UI recovered after a renderer crash (${reason}${code ? ` · ${code}` : ''}). Recent crash details are in Settings → General.`
      )
    })()
    return () => {
      cancelled = true
    }
  }, [setSettingsError])

  // Surface available app updates outside Settings → About: one toast per
  // available/downloaded state so users notice without opening settings.
  // autoDownload stays off — the user starts the download from the update card.
  useEffect(() => {
    const seen = new Set<string>()
    const updaterApi = window.vyotiq?.updater
    if (!updaterApi) return
    const stop = updaterApi.onState((payload) => {
      if (payload.status !== 'available' && payload.status !== 'downloaded') return
      const version = payload.info?.version ?? ''
      const key = `${payload.status}:${version}`
      if (seen.has(key)) return
      seen.add(key)
      if (payload.status === 'available') {
        pushToast(
          version
            ? `Version ${version} is available. Open the update card to review and download.`
            : 'An update is available. Open the update card to review and download.'
        )
      } else {
        pushToast(
          version
            ? `Version ${version} downloaded. Click to restart and install now.`
            : 'Update downloaded. Click to restart and install now.',
          'success',
          12000,
          () => {
            void window.vyotiq?.updater.install()
          }
        )
      }
    })
    return stop
  }, [])

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

  const renderPaneSession = useCallback(
    (pane: ChatPane, options: PaneRenderOptions) => {
      const { focused, sideRailPad, onOpenChanges, onOpenWorkspaceFile } =
        options
      const snap = getPaneChatSnapshot(pane.workspacePath, pane.runId)
      const paneContext = findByWorkspacePath(contexts, pane.workspacePath)
      const paneScrollKey = pane.runId ?? '__draft__'
      const paneScroll =
        paneContext && paneScrollKey in paneContext.ui.scrollTopByRunId
          ? paneContext.ui.scrollTopByRunId[paneScrollKey]
          : paneContext &&
              Object.keys(paneContext.ui.scrollTopByRunId).length === 0 &&
              paneContext.ui.scrollTop > 0
            ? paneContext.ui.scrollTop
            : undefined
      const paneCollapsed =
        snap.collapsedTurnIndices.length > 0
          ? new Set(snap.collapsedTurnIndices)
          : undefined
      const paneCtrl = getRunController(pane.runId, pane.workspacePath)
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
          onRevertToUserMessage={(userMessageIndex) =>
            confirmRevertToUserMessage(
              userMessageIndex,
              Math.max(0, snap.messages.length - userMessageIndex - 1),
              {
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
          onThinkingToggle={
            paneCtrl
              ? (messageId, expanded) => paneCtrl.setThinkingExpanded(messageId, expanded)
              : undefined
          }
          onToolToggle={
            paneCtrl
              ? (toolCallId, expanded) => paneCtrl.setToolExpanded(toolCallId, expanded)
              : undefined
          }
          onGroupToggle={
            paneCtrl
              ? (anchorToolCallId, expanded) =>
                  paneCtrl.setGroupExpanded(anchorToolCallId, expanded)
              : undefined
          }
          onTurnToggle={
            paneCtrl ? (turnIndex) => paneCtrl.toggleTurnCollapsed(turnIndex) : undefined
          }
          collapsedTurns={paneCollapsed}
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
          sideRailPad={sideRailPad}
          onOpenChanges={onOpenChanges}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
        />
      )
    },
    [
      chatSurfaceEpoch,
      contexts,
      confirmRevertToUserMessage,
      createSlashHandlers,
      getPaneChatSnapshot,
      getRunController,
      mcpServerNames,
      focusPaneById,
      gateSendWithOnboarding,
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
      onToggleFavorite
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
      getPaneTitle,
      renderPane: renderPaneSession
    }
  }, [
    closePaneById,
    focusPaneById,
    getPaneTitle,
    handleSessionDrop,
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
      pushToast(`Chat exported to ${res.data.path}`)
    }
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

  const onReviewChangesInWorkspace = useCallback(
    async (path: string, runId?: string): Promise<void> => {
      if (runId) {
        await onSelectRunInWorkspace(path, runId)
      } else {
        await switchWorkspace(path)
        setView('chat')
      }
      setOpenChangesRequest((request) => request + 1)
    },
    [onSelectRunInWorkspace, switchWorkspace]
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

  const shellWorkspaceProps = {
    openWorkspaces,
    activeRuns,
    runsByWorkspacePath,
    onSwitchWorkspace: (path: string) => {
      setOpenInstanceByParent({})
      void switchWorkspace(path)
    },
    onCloseWorkspace,
    onAddWorkspace: onPickWorkspace,
    onNewChatInWorkspace,
    workspaceHasBackgroundRun,
    expandedByPath: workspace.workspaceExpandedByPath,
    onSetWorkspaceExpanded: workspace.setWorkspaceExpanded,
    onSelectRunInWorkspace: (path: string, runId: string) => void onSelectRunInWorkspace(path, runId),
    onRenameRunInWorkspace: (path: string, runId: string, goal: string) =>
      void onRenameRunInWorkspace(path, runId, goal),
    onDeleteRunInWorkspace: (path: string, runId: string) => void onDeleteRunInWorkspace(path, runId),
    onExportRunInWorkspace: (path: string, runId: string) => void onExportRunInWorkspace(path, runId),
    onLoadOlderRuns: (path: string) => void loadOlderWorkspaceRuns(path),
    isRunOpenInPane: isSessionOpenInPane,
    isRunFocusedInPane: isSessionFocusedInPane,
    openInstanceRunId: focusedOpenInstance
  }

  if (loading) {
    return (
      <AppShell
        view="chat"
        workspacePath={null}
        sessionQuery=""
        onSessionQuery={() => {}}
        onOpenSettings={() => {}}
        onOpenMarketplace={() => {}}
        onOpenChat={() => {}}
        onOpenHome={() => {}}
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
      navigationMode={settings.navigationMode}
      onDismissRunsError={clearRunsError}
      sessionQuery=""
      onSessionQuery={setSessionQuery}
      onOpenSettings={() => {
        setView('settings')
      }}
      onOpenFeedback={() => {
        setSettingsSection('general')
        setView('settings')
        setFeedbackOpen(true)
      }}
      onOpenNotificationSettings={() => {
        setSettingsSection('general')
        setView('settings')
      }}
      focusedRunId={focusedRunId}
      onOpenMarketplace={() => setView('marketplace')}
      onOpenChat={() => setView('chat')}
      onOpenHome={() => setView('home')}
      onNewChat={onNewChat}
      running={chat.running || chat.pendingRun}
      onChatStop={onChatStop}
      onCloseChat={() => {
        const id = chat.runId ?? getFocusedPane()?.runId
        if (id) closeRunTab(id)
      }}
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
            onClose={() => setView('chat')}
            onUpdate={update}
            onReloadSettings={refresh}
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
              if (res.ok && res.data) await addWorkspace(res.data)
              return res
            }}
            activeWorkspacePath={focusedWorkspacePath ?? activeWorkspace}
            openWorkspaces={openWorkspaces}
            settingsOverridesByPath={registry?.settingsOverridesByPath ?? {}}
            effectiveChatSettings={effectiveChatSettings}
            onSetSettingsOverride={setSettingsOverride}
            onModelsRefreshed={() => setModelsRefreshNonce((n) => n + 1)}
            onOpenComposerModel={() => {
              setView('chat')
              window.setTimeout(() => {
                const trigger = document.querySelector<HTMLButtonElement>(
                  'button[aria-label="Select model"]'
                )
                trigger?.focus()
                trigger?.click()
              }, 80)
              }}
            />
          </Suspense>
        </ErrorBoundary>
      ) : view === 'marketplace' ? (
        <ErrorBoundary
          title="Marketplace couldn't render"
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
            onFocusServerConsumed={() => setMarketplaceFocusServerId(null)}
            onFocusSkillConsumed={() => setMarketplaceFocusSkillPath(null)}
            onFocusRuleConsumed={() => setMarketplaceFocusRulePath(null)}
            onClose={() => setView('chat')}
          />
          </Suspense>
        </ErrorBoundary>
      ) : view === 'home' ? (
        <ErrorBoundary title="Home couldn't render" resetKey="home">
          <Suspense fallback={<ViewSuspenseFallback />}>
            <HomePage
              openWorkspaces={openWorkspaces}
              runsByWorkspacePath={runsByWorkspacePath}
              activeRuns={shellWorkspaceProps.activeRuns}
              workspaceHasBackgroundRun={shellWorkspaceProps.workspaceHasBackgroundRun}
              onNewSessionInWorkspace={onNewSessionInWorkspace}
              onSelectRunInWorkspace={shellWorkspaceProps.onSelectRunInWorkspace}
              onSwitchWorkspace={shellWorkspaceProps.onSwitchWorkspace}
              onAddWorkspace={shellWorkspaceProps.onAddWorkspace}
              onRenameRunInWorkspace={shellWorkspaceProps.onRenameRunInWorkspace}
              onDeleteRunInWorkspace={shellWorkspaceProps.onDeleteRunInWorkspace}
              onExportRunInWorkspace={shellWorkspaceProps.onExportRunInWorkspace}
              onStopRunInWorkspace={onStopRunInWorkspace}
              onReviewChangesInWorkspace={(path, runId) => void onReviewChangesInWorkspace(path, runId)}
              onRefreshWorkspaceRuns={(path) => refreshWorkspaceRuns(path)}
              refreshVersion={homeRefreshVersion}
              isRunOpenInPane={shellWorkspaceProps.isRunOpenInPane}
              isRunFocusedInPane={shellWorkspaceProps.isRunFocusedInPane}
              pinnedRunKeys={settings.pinnedRuns}
              onTogglePinnedRun={onTogglePinnedRun}
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
            headingRef={chatHeadingRef}
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
            onOpenChangesRequestHandled={consumeOpenChangesRequest}
          />
        </ErrorBoundary>
      )}
      <LiveRegion />
      <ToastHost />
      {confirmDialog}
      <ToolApprovalOnboardingModal
        open={approvalOnboardingOpen}
        error={settingsError}
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
