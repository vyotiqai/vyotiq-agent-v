import { clipboard, contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/channels'
import {
  parseRendererChatEvent,
  ToolApprovalRequestSchema,
  AgentQuestionRequestSchema,
  AgentQuestionRejectSchema,
  AgentBrowserStateSchema,
  CodeIndexRuntimeStatusSchema,
  UpdaterStatePayloadSchema,
  DictationRuntimeStatusSchema,
  GithubAuthStatusSchema,
  SkillsChangedPayloadSchema,
  NotificationListSchema,
  NotificationActionSchema
} from '../shared/ipc'
import type { VyotiqApi } from '../shared/vyotiqApi'
import type { IpcResult } from '../shared/ipc'

export type { HostPlatform, VyotiqApi } from '../shared/vyotiqApi'

// Sentry is initialized in the renderer after settings.telemetryEnabled is known.

const api: VyotiqApi = {
  platform: process.platform,
  pickWorkspace: () => ipcRenderer.invoke(IPC.pickWorkspace),
  getWorkspaces: () => ipcRenderer.invoke(IPC.workspacesGet),
  addWorkspace: (path) => ipcRenderer.invoke(IPC.workspacesAdd, path ? { path } : {}),
  removeWorkspace: (path, stopActiveRuns) =>
    ipcRenderer.invoke(IPC.workspacesRemove, { path, stopActiveRuns }),
  setActiveWorkspace: (path) => ipcRenderer.invoke(IPC.workspacesSetActive, { path }),
  updateWorkspaceUiState: (path, ui) =>
    ipcRenderer.invoke(IPC.workspacesUpdateUiState, { path, ui }),
  updateWorkspaceUiStateSync: (path, ui) =>
    ipcRenderer.send(IPC.workspacesUpdateUiStateSync, { path, ui }),
  getComposerAttachments: (workspacePath) =>
    ipcRenderer.invoke(IPC.composerAttachmentsGet, { workspacePath }),
  setComposerAttachments: (payload) => ipcRenderer.invoke(IPC.composerAttachmentsSet, payload),
  clearComposerAttachments: (payload) => ipcRenderer.invoke(IPC.composerAttachmentsClear, payload),
  setWorkspaceSettingsOverride: (path, override) =>
    ipcRenderer.invoke(IPC.workspacesSetSettingsOverride, { path, override }),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (partial) => ipcRenderer.invoke(IPC.setSettings, partial),
  getAccessibilitySupportState: () =>
    ipcRenderer.invoke(IPC.accessibilitySupportState) as Promise<
      IpcResult<{ enabled: boolean }>
    >,
  onAccessibilitySupportChanged: (
    listener: (payload: { enabled: boolean }) => void
  ): (() => void) => {
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => {
      if (
        !payload ||
        typeof payload !== 'object' ||
        typeof (payload as { enabled?: unknown }).enabled !== 'boolean'
      ) {
        return
      }
      listener(payload as { enabled: boolean })
    }
    ipcRenderer.on(IPC.accessibilitySupportChanged, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC.accessibilitySupportChanged, wrapped)
    }
  },
  setSecret: (provider, key) => ipcRenderer.invoke(IPC.setSecret, { provider, key }),
  clearSecret: (provider) => ipcRenderer.invoke(IPC.clearSecret, { provider }),
  secretStatus: () => ipcRenderer.invoke(IPC.secretStatus),
  listModels: (payload) => ipcRenderer.invoke(IPC.listModels, payload),
  chatStart: (payload) => ipcRenderer.invoke(IPC.chatStart, payload),
  chatUiSubscribe: (payload) => ipcRenderer.invoke(IPC.chatUiSubscribe, payload),
  chatUiSubscribeAdd: (payload) => ipcRenderer.invoke(IPC.chatUiSubscribeAdd, payload),
  chatRewindAndStart: (payload) => ipcRenderer.invoke(IPC.chatRewindAndStart, payload),
  chatRewind: (payload) => ipcRenderer.invoke(IPC.chatRewind, payload),
  chatRewindPreview: (payload) => ipcRenderer.invoke(IPC.chatRewindPreview, payload),
  chatCancel: (runId) => ipcRenderer.invoke(IPC.chatCancel, { runId }),
  chatFollowUp: (payload) => ipcRenderer.invoke(IPC.chatFollowUp, payload),
  chatFollowUpRemove: (payload) => ipcRenderer.invoke(IPC.chatFollowUpRemove, payload),
  chatFollowUpUpdate: (payload) => ipcRenderer.invoke(IPC.chatFollowUpUpdate, payload),
  chatFollowUpPromote: (payload) => ipcRenderer.invoke(IPC.chatFollowUpPromote, payload),
  chatQueueMode: (payload) => ipcRenderer.invoke(IPC.chatQueueMode, payload),
  chatCompact: (workspacePath, runId, focus) =>
    ipcRenderer.invoke(IPC.chatCompact, {
      workspacePath,
      runId,
      ...(focus?.trim() ? { focus: focus.trim() } : {})
    }),
  resolveWrites: (payload) => ipcRenderer.invoke(IPC.runsResolveWrites, payload),
  readRunArtifact: (payload) => ipcRenderer.invoke(IPC.runsReadArtifact, payload),
  runStats: (payload) => ipcRenderer.invoke(IPC.runStats, payload),
  harnessReview: (payload) => ipcRenderer.invoke(IPC.harnessReview, payload),
  harnessPreviewApply: (payload) => ipcRenderer.invoke(IPC.harnessPreviewApply, payload),
  harnessApply: (payload) => ipcRenderer.invoke(IPC.harnessApply, payload),
  onChatEvent: (handler) => {
    const listener = (_: IpcRendererEvent, raw: unknown): void => {
      const parsed = parseRendererChatEvent(raw)
      if (!parsed) {
        const kind =
          raw && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as { type?: unknown }).type
            : undefined
        console.warn('[vyotiq] Invalid chat event dropped', typeof kind === 'string' ? kind : '(unknown type)')
        return
      }
      handler(parsed)
    }
    ipcRenderer.on(IPC.chatEvent, listener)
    return () => {
      ipcRenderer.removeListener(IPC.chatEvent, listener)
    }
  },
  onToolApprovalRequest: (handler) => {
    const listener = (_: IpcRendererEvent, raw: unknown): void => {
      const parsed = ToolApprovalRequestSchema.safeParse(raw)
      if (!parsed.success) {
        console.warn('[vyotiq] Invalid approval request dropped', parsed.error.issues[0]?.message)
        return
      }
      handler(parsed.data)
    }
    ipcRenderer.on(IPC.toolApprovalRequest, listener)
    return () => {
      ipcRenderer.removeListener(IPC.toolApprovalRequest, listener)
    }
  },
  respondToolApproval: (requestId, decision, runId) =>
    ipcRenderer.invoke(IPC.toolApprovalResponse, { requestId, decision, runId }),
  listPendingToolApprovals: (runId) =>
    ipcRenderer.invoke(IPC.toolApprovalListPending, { runId }),
  onAgentQuestionRequest: (handler) => {
    const listener = (_: IpcRendererEvent, raw: unknown): void => {
      const parsed = AgentQuestionRequestSchema.safeParse(raw)
      if (!parsed.success) {
        console.warn(
          '[vyotiq] Invalid question request dropped',
          parsed.error.issues[0]?.message
        )
        const rejectParsed = AgentQuestionRejectSchema.safeParse(raw)
        if (rejectParsed.success) {
          void ipcRenderer.invoke(IPC.agentQuestionReject, rejectParsed.data)
          return
        }
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const partial = raw as { requestId?: unknown; runId?: unknown }
          const requestId =
            typeof partial.requestId === 'string' && partial.requestId.trim()
              ? partial.requestId
              : undefined
          const runId =
            typeof partial.runId === 'string' && partial.runId.trim()
              ? partial.runId
              : undefined
          // Either id is enough — main looks up pending by requestId or runId.
          if (requestId || runId) {
            void ipcRenderer.invoke(IPC.agentQuestionReject, {
              ...(requestId ? { requestId } : {}),
              ...(runId ? { runId } : {}),
              reason: parsed.error.issues[0]?.message
            })
          }
        }
        return
      }
      handler(parsed.data)
    }
    ipcRenderer.on(IPC.agentQuestionRequest, listener)
    return () => {
      ipcRenderer.removeListener(IPC.agentQuestionRequest, listener)
    }
  },
  respondAgentQuestion: (requestId, answers, runId) =>
    ipcRenderer.invoke(IPC.agentQuestionResponse, { requestId, answers, runId }),
  listPendingAgentQuestions: (runId) =>
    ipcRenderer.invoke(IPC.agentQuestionListPending, { runId }),
  extractAttachment: (payload) => ipcRenderer.invoke(IPC.attachmentExtract, payload),
  transcribeDictation: (payload) => ipcRenderer.invoke(IPC.dictationTranscribe, payload),
  cancelDictation: (requestId) => ipcRenderer.invoke(IPC.dictationCancel, { requestId }),
  dictationStatus: () => ipcRenderer.invoke(IPC.dictationStatus),
  dictationInstall: (payload) => ipcRenderer.invoke(IPC.dictationInstall, payload),
  dictationUnload: () => ipcRenderer.invoke(IPC.dictationUnload),
  dictationDeleteCache: (payload) => ipcRenderer.invoke(IPC.dictationDeleteCache, payload),
  onDictationStatus: (handler) => {
    const listener = (_: IpcRendererEvent, status: unknown): void => {
      const parsed = DictationRuntimeStatusSchema.safeParse(status)
      if (!parsed.success) return
      handler(parsed.data)
    }
    ipcRenderer.on(IPC.dictationStatusEvent, listener)
    return () => {
      ipcRenderer.removeListener(IPC.dictationStatusEvent, listener)
    }
  },
  listRuns: (workspacePath) => {
    const path = workspacePath?.trim() ?? ''
    if (!path) {
      return Promise.resolve({ ok: true as const, data: { runs: [], capped: false } })
    }
    return ipcRenderer.invoke(IPC.listRuns, { workspacePath: path })
  },
  listOlderRuns: (workspacePath, olderThan, limit) => {
    const path = workspacePath?.trim() ?? ''
    const cursor = olderThan?.trim() ?? ''
    if (!path || !cursor) {
      return Promise.resolve({ ok: true as const, data: { runs: [], hasMore: false } })
    }
    return ipcRenderer.invoke(IPC.listOlderRuns, limit && limit > 0 ? { workspacePath: path, olderThan: cursor, limit } : { workspacePath: path, olderThan: cursor })
  },
  loadRun: (workspacePath, runId) => ipcRenderer.invoke(IPC.loadRun, { workspacePath, runId }),
  loadRunEvents: (workspacePath, runId) =>
    ipcRenderer.invoke(IPC.loadRunEvents, { workspacePath, runId }),
  loadToolResult: (workspacePath, runId, toolCallId) =>
    ipcRenderer.invoke(IPC.loadToolResult, { workspacePath, runId, toolCallId }),
  deleteRun: (workspacePath, runId) =>
    ipcRenderer.invoke(IPC.runsDelete, { workspacePath, runId }),
  exportRun: (workspacePath, runId) =>
    ipcRenderer.invoke(IPC.runsExport, { workspacePath, runId }),
  renameRun: (workspacePath, runId, goal) =>
    ipcRenderer.invoke(IPC.runsRename, { workspacePath, runId, goal }),
  setGoalStatus: (payload) => ipcRenderer.invoke(IPC.runsSetGoalStatus, payload),
  setLoop: (payload) => ipcRenderer.invoke(IPC.runsSetLoop, payload),
  listActiveRuns: () => ipcRenderer.invoke(IPC.runsActive),
  gitStatus: (workspacePath) => ipcRenderer.invoke(IPC.gitStatus, { workspacePath }),
  gitGenerateCommitMessage: (payload) =>
    ipcRenderer.invoke(IPC.gitGenerateCommitMessage, payload),
  gitCommit: (workspacePath, message, push, mode) =>
    ipcRenderer.invoke(IPC.gitCommit, { workspacePath, message, push, mode }),
  gitStageAll: (workspacePath) => ipcRenderer.invoke(IPC.gitStageAll, { workspacePath }),
  gitStagePaths: (payload) => ipcRenderer.invoke(IPC.gitStagePaths, payload),
  gitUnstagePaths: (payload) => ipcRenderer.invoke(IPC.gitUnstagePaths, payload),
  gitBranches: (workspacePath) => ipcRenderer.invoke(IPC.gitBranches, { workspacePath }),
  gitCheckout: (workspacePath, branch) =>
    ipcRenderer.invoke(IPC.gitCheckout, { workspacePath, branch }),
  gitLog: (payload) => ipcRenderer.invoke(IPC.gitLog, payload),
  gitCommitFiles: (payload) => ipcRenderer.invoke(IPC.gitCommitFiles, payload),
  gitDiff: (payload) => ipcRenderer.invoke(IPC.gitDiff, payload),
  gitBlame: (workspacePath, path) =>
    ipcRenderer.invoke(IPC.gitBlame, { workspacePath, path }),
  prView: (workspacePath) => ipcRenderer.invoke(IPC.prView, { workspacePath }),
  prCreate: (workspacePath, options) =>
    ipcRenderer.invoke(IPC.prCreate, { workspacePath, ...options }),
  prMerge: (workspacePath, method, number) =>
    ipcRenderer.invoke(IPC.prMerge, { workspacePath, method, number }),
  prDiff: (payload) => ipcRenderer.invoke(IPC.prDiff, payload),
  prClose: (workspacePath, number) =>
    ipcRenderer.invoke(IPC.prClose, { workspacePath, number }),
  prEditTitle: (workspacePath, title, number) =>
    ipcRenderer.invoke(IPC.prEditTitle, { workspacePath, title, number }),
  githubAuthStatus: () => ipcRenderer.invoke(IPC.githubAuthStatus),
  githubAuthStart: () => ipcRenderer.invoke(IPC.githubAuthStart),
  githubAuthCancel: () => ipcRenderer.invoke(IPC.githubAuthCancel),
  githubAuthLogout: () => ipcRenderer.invoke(IPC.githubAuthLogout),
  onGithubAuthStatus: (handler) => {
    const listener = (_: IpcRendererEvent, status: unknown): void => {
      const parsed = GithubAuthStatusSchema.safeParse(status)
      if (!parsed.success) return
      handler(parsed.data)
    }
    ipcRenderer.on(IPC.githubAuthStatusEvent, listener)
    return () => {
      ipcRenderer.removeListener(IPC.githubAuthStatusEvent, listener)
    }
  },
  githubCliInstall: () => ipcRenderer.invoke(IPC.githubCliInstall),
  shellOpenExternal: (url) => ipcRenderer.invoke(IPC.shellOpenExternal, { url }),
  ptyCreate: (payload) => ipcRenderer.invoke(IPC.ptyCreate, payload),
  ptyList: (workspacePath) =>
    ipcRenderer.invoke(IPC.ptyList, workspacePath ? { workspacePath } : {}),
  ptyWrite: (id, data, workspacePath) =>
    ipcRenderer.invoke(IPC.ptyWrite, { id, data, workspacePath }),
  ptyResize: (id, cols, rows, workspacePath) =>
    ipcRenderer.invoke(IPC.ptyResize, { id, cols, rows, workspacePath }),
  ptyKill: (id, workspacePath) => ipcRenderer.invoke(IPC.ptyKill, { id, workspacePath }),
  onPtyData: (handler) => {
    const listener = (_: IpcRendererEvent, raw: unknown): void => {
      if (!raw || typeof raw !== 'object') return
      const rec = raw as { id?: unknown; data?: unknown }
      if (typeof rec.id !== 'string' || typeof rec.data !== 'string') return
      handler({ id: rec.id, data: rec.data })
    }
    ipcRenderer.on(IPC.ptyData, listener)
    return () => {
      ipcRenderer.removeListener(IPC.ptyData, listener)
    }
  },
  onPtyExit: (handler) => {
    const listener = (_: IpcRendererEvent, raw: unknown): void => {
      if (!raw || typeof raw !== 'object') return
      const rec = raw as { id?: unknown; exitCode?: unknown }
      if (typeof rec.id !== 'string') return
      handler({
        id: rec.id,
        exitCode: typeof rec.exitCode === 'number' ? rec.exitCode : null
      })
    }
    ipcRenderer.on(IPC.ptyExit, listener)
    return () => {
      ipcRenderer.removeListener(IPC.ptyExit, listener)
    }
  },
  windowMinimize: () => ipcRenderer.invoke(IPC.windowMinimize),
  windowMaximize: () => ipcRenderer.invoke(IPC.windowMaximize),
  windowClose: () => ipcRenderer.invoke(IPC.windowClose),
  windowIsMaximized: () => ipcRenderer.invoke(IPC.windowIsMaximized),
  onWindowMaximizedChanged: (handler) => {
    const listener = (_: IpcRendererEvent, maximized: unknown): void => {
      if (typeof maximized !== 'boolean') return
      handler(maximized)
    }
    ipcRenderer.on(IPC.windowMaximizedChanged, listener)
    return () => {
      ipcRenderer.removeListener(IPC.windowMaximizedChanged, listener)
    }
  },
  onWindowFocusChanged: (handler) => {
    const listener = (_: IpcRendererEvent, focused: unknown): void => {
      if (typeof focused !== 'boolean') return
      handler(focused)
    }
    ipcRenderer.on(IPC.windowFocusChanged, listener)
    return () => {
      ipcRenderer.removeListener(IPC.windowFocusChanged, listener)
    }
  },
  onBrowserState: (handler) => {
    const listener = (_: IpcRendererEvent, raw: unknown): void => {
      const parsed = AgentBrowserStateSchema.safeParse(raw)
      if (!parsed.success) {
        console.warn('[vyotiq] Invalid browser state dropped', parsed.error.issues[0]?.message)
        return
      }
      handler(parsed.data)
    }
    ipcRenderer.on(IPC.browserState, listener)
    return () => {
      ipcRenderer.removeListener(IPC.browserState, listener)
    }
  },
  browserGetState: async () => {
    const res = await ipcRenderer.invoke(IPC.browserGetState)
    if (!res?.ok) return res
    const parsed = AgentBrowserStateSchema.safeParse(res.data)
    if (!parsed.success) {
      return { ok: false as const, error: 'Invalid browser state' }
    }
    return { ok: true as const, data: parsed.data }
  },
  browserFocus: () => ipcRenderer.invoke(IPC.browserFocus),
  browserClose: () => ipcRenderer.invoke(IPC.browserClose),
  browserSelectTab: (tabId: string, workspacePath?: string) =>
    ipcRenderer.invoke(IPC.browserSelectTab, workspacePath ? { tabId, workspacePath } : { tabId }),
  browserOpenTab: (payload) => ipcRenderer.invoke(IPC.browserOpenTab, payload ?? {}),
  browserCloseTab: (tabId?: string, workspacePath?: string) =>
    ipcRenderer.invoke(IPC.browserCloseTab, {
      ...(tabId ? { tabId } : {}),
      ...(workspacePath ? { workspacePath } : {})
    }),
  browserTakeControl: () => ipcRenderer.invoke(IPC.browserTakeControl),
  browserReleaseControl: () => ipcRenderer.invoke(IPC.browserReleaseControl),
  browserBack: (workspacePath?: string) =>
    ipcRenderer.invoke(IPC.browserBack, workspacePath ? { workspacePath } : undefined),
  browserForward: (workspacePath?: string) =>
    ipcRenderer.invoke(IPC.browserForward, workspacePath ? { workspacePath } : undefined),
  browserSetBounds: (bounds) => ipcRenderer.invoke(IPC.browserSetBounds, bounds),
  browserNavigate: (url: string, workspacePath?: string) => ipcRenderer.invoke(IPC.browserNavigate, workspacePath ? { url, workspacePath } : url),
  browserReload: (workspacePath?: string) =>
    ipcRenderer.invoke(IPC.browserReload, workspacePath ? { workspacePath } : undefined),
  browserTakeScreenshot: (payload) => ipcRenderer.invoke(IPC.browserTakeScreenshot, payload),
  browserClearBrowsingData: (payload) =>
    ipcRenderer.invoke(IPC.browserClearBrowsingData, payload),
  openLogsDir: () => ipcRenderer.invoke(IPC.logsOpenDir),
  getLogsPath: () => ipcRenderer.invoke(IPC.logsGetPath),
  getCrashDiagnostics: () => ipcRenderer.invoke(IPC.crashDiagnosticsGet),
  consumeCrashRecovery: () => ipcRenderer.invoke(IPC.crashRecoveryConsume),
  telemetryStatus: () => ipcRenderer.invoke(IPC.telemetryStatus),
  startTrace: () => ipcRenderer.invoke(IPC.traceStart),
  getTraceStatus: () => ipcRenderer.invoke(IPC.traceStatus),
  stopTrace: () => ipcRenderer.invoke(IPC.traceStop),
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  updater: {
    check: () => ipcRenderer.invoke(IPC.updaterCheck),
    download: () => ipcRenderer.invoke(IPC.updaterDownload),
    install: () => ipcRenderer.invoke(IPC.updaterInstall),
    onState: (handler) => {
      const listener = (_: IpcRendererEvent, payload: unknown): void => {
        const parsed = UpdaterStatePayloadSchema.safeParse(payload)
        if (!parsed.success) return
        handler(parsed.data)
      }
      ipcRenderer.on(IPC.updaterState, listener)
      return () => {
        ipcRenderer.removeListener(IPC.updaterState, listener)
      }
    }
  },
  feedback: {
    compose: (payload) => ipcRenderer.invoke(IPC.feedbackCompose, payload)
  },
  workspaceGrep: (payload) => ipcRenderer.invoke(IPC.workspaceGrep, payload),
  gitConflictFile: (payload) => ipcRenderer.invoke(IPC.gitConflictFile, payload),
  gitResolveConflict: (payload) => ipcRenderer.invoke(IPC.gitResolveConflict, payload),
  prReview: (payload) => ipcRenderer.invoke(IPC.prReview, payload),
  githubIssuesList: (payload) => ipcRenderer.invoke(IPC.githubIssuesList, payload),
  githubIssueCreate: (payload) => ipcRenderer.invoke(IPC.githubIssueCreate, payload),
  mcpStatus: (payload) => ipcRenderer.invoke(IPC.mcpStatus, payload ?? {}),
  mcpRefresh: (payload) => ipcRenderer.invoke(IPC.mcpRefresh, payload ?? {}),
  mcpSetAuthToken: (serverId, token) =>
    ipcRenderer.invoke(IPC.mcpSetAuthToken, { serverId, token }),
  mcpClearAuthToken: (serverId) => ipcRenderer.invoke(IPC.mcpClearAuthToken, { serverId }),
  mcpSetOAuthClientSecret: (serverId, secret) =>
    ipcRenderer.invoke(IPC.mcpSetOAuthClientSecret, { serverId, secret }),
  mcpClearOAuthClientSecret: (serverId) =>
    ipcRenderer.invoke(IPC.mcpClearOAuthClientSecret, { serverId }),
  mcpSetGoogleClientSecret: (secret) =>
    ipcRenderer.invoke(IPC.mcpSetGoogleClientSecret, { secret }),
  mcpClearGoogleClientSecret: () => ipcRenderer.invoke(IPC.mcpClearGoogleClientSecret, {}),
  mcpStartOAuth: (serverId, opts) =>
    ipcRenderer.invoke(IPC.mcpStartOAuth, { serverId, ...opts }),
  marketplaceListInstalled: () => ipcRenderer.invoke(IPC.marketplaceListInstalled),
  marketplaceBrowse: (payload) => ipcRenderer.invoke(IPC.marketplaceBrowse, payload ?? {}),
  marketplaceRefreshCatalog: () => ipcRenderer.invoke(IPC.marketplaceRefreshCatalog),
  marketplaceInstall: (payload) => ipcRenderer.invoke(IPC.marketplaceInstall, payload),
  marketplaceDetectMcp: (payload) => ipcRenderer.invoke(IPC.marketplaceDetectMcp, payload),
  marketplaceApplyDetectedMcp: (payload) =>
    ipcRenderer.invoke(IPC.marketplaceApplyDetectedMcp, payload),
  marketplaceScanExternalMcp: (payload) =>
    ipcRenderer.invoke(IPC.marketplaceScanExternalMcp, payload ?? {}),
  marketplaceImportExternalMcp: (payload) =>
    ipcRenderer.invoke(IPC.marketplaceImportExternalMcp, payload),
  marketplaceUninstall: (id, opts) =>
    ipcRenderer.invoke(IPC.marketplaceUninstall, { id, ...opts }),
  marketplaceSetEnabled: (id, enabled) =>
    ipcRenderer.invoke(IPC.marketplaceSetEnabled, { id, enabled }),
  marketplacePickLocal: () => ipcRenderer.invoke(IPC.marketplacePickLocal),
  marketplaceGetContents: (id) => ipcRenderer.invoke(IPC.marketplaceGetContents, { id }),
  marketplaceAckRemoteInstall: (acked) =>
    ipcRenderer.invoke(IPC.marketplaceAckRemoteInstall, { acked }),
  getSystemTheme: () => ipcRenderer.invoke(IPC.getSystemTheme),
  appearancePickCustomCss: () => ipcRenderer.invoke(IPC.appearancePickCustomCss),
  appearanceReadCustomCss: () => ipcRenderer.invoke(IPC.appearanceReadCustomCss),
  onAppearanceCustomCssChanged: (handler) => {
    const listener = (_: IpcRendererEvent): void => handler()
    ipcRenderer.on(IPC.appearanceCustomCssChanged, listener)
    return () => {
      ipcRenderer.removeListener(IPC.appearanceCustomCssChanged, listener)
    }
  },
  probeNetwork: () => ipcRenderer.invoke(IPC.networkProbe),
  agentContext: (payload) => ipcRenderer.invoke(IPC.agentContext, payload),
  codeIndexStatus: () => ipcRenderer.invoke(IPC.codeIndexStatus),
  codeIndexReindex: (payload) => ipcRenderer.invoke(IPC.codeIndexReindex, payload ?? {}),
  processMetrics: () => ipcRenderer.invoke(IPC.processMetrics),
  onCodeIndexStatus: (handler) => {
    const listener = (_: IpcRendererEvent, status: unknown): void => {
      const parsed = CodeIndexRuntimeStatusSchema.safeParse(status)
      if (!parsed.success) return
      handler(parsed.data)
    }
    ipcRenderer.on(IPC.codeIndexStatusEvent, listener)
    return () => {
      ipcRenderer.removeListener(IPC.codeIndexStatusEvent, listener)
    }
  },
  slashCommandsList: (payload) => ipcRenderer.invoke(IPC.slashCommandsList, payload ?? {}),
  slashCommandsResolve: (payload) => ipcRenderer.invoke(IPC.slashCommandsResolve, payload),
  slashCommandsCreateRule: (payload) =>
    ipcRenderer.invoke(IPC.slashCommandsCreateRule, payload),
  slashCommandsCreateSkill: (payload) =>
    ipcRenderer.invoke(IPC.slashCommandsCreateSkill, payload),
  slashCommandsOpenFile: (payload) => ipcRenderer.invoke(IPC.slashCommandsOpenFile, payload),
  skillsListLocal: (payload) => ipcRenderer.invoke(IPC.skillsListLocal, payload ?? {}),
  skillsOpenLocal: (payload) => ipcRenderer.invoke(IPC.skillsOpenLocal, payload),
  skillsReadLocal: (payload) => ipcRenderer.invoke(IPC.skillsReadLocal, payload),
  skillsWriteLocal: (payload) => ipcRenderer.invoke(IPC.skillsWriteLocal, payload),
  skillsDeleteLocal: (payload) => ipcRenderer.invoke(IPC.skillsDeleteLocal, payload),
  onSkillsChanged: (handler) => {
    const listener = (_: IpcRendererEvent, raw: unknown): void => {
      const parsed = SkillsChangedPayloadSchema.safeParse(raw)
      if (!parsed.success) return
      handler(parsed.data)
    }
    ipcRenderer.on(IPC.skillsChanged, listener)
    return () => {
      ipcRenderer.removeListener(IPC.skillsChanged, listener)
    }
  },
  listNotifications: () => ipcRenderer.invoke(IPC.notificationsList),
  markNotificationsRead: (payload) => ipcRenderer.invoke(IPC.notificationsMarkRead, payload),
  dismissNotifications: (payload) => ipcRenderer.invoke(IPC.notificationsDismiss, payload),
  onNotificationsChanged: (handler) => {
    const listener = (_: IpcRendererEvent, raw: unknown): void => {
      const parsed = NotificationListSchema.safeParse(raw)
      if (!parsed.success) return
      handler(parsed.data)
    }
    ipcRenderer.on(IPC.notificationsChanged, listener)
    return () => {
      ipcRenderer.removeListener(IPC.notificationsChanged, listener)
    }
  },
  onNotificationActivate: (handler) => {
    const listener = (_: IpcRendererEvent, raw: unknown): void => {
      const parsed = NotificationActionSchema.safeParse(raw)
      if (!parsed.success) return
      handler(parsed.data)
    }
    ipcRenderer.on(IPC.notificationsActivate, listener)
    return () => {
      ipcRenderer.removeListener(IPC.notificationsActivate, listener)
    }
  },
  workspaceSuggestPaths: (payload) => ipcRenderer.invoke(IPC.workspaceSuggestPaths, payload),
  workspaceReadText: (payload) => ipcRenderer.invoke(IPC.workspaceReadText, payload),
  workspaceReadImage: (payload) => ipcRenderer.invoke(IPC.workspaceReadImage, payload),
  workspaceFileList: (payload) => ipcRenderer.invoke(IPC.workspaceFileList, payload),
  workspaceFileRead: (payload) => ipcRenderer.invoke(IPC.workspaceFileRead, payload),
  workspaceFileStat: (payload) => ipcRenderer.invoke(IPC.workspaceFileStat, payload),
  workspaceFileSave: (payload) => ipcRenderer.invoke(IPC.workspaceFileSave, payload),
  workspaceFileCreate: (payload) => ipcRenderer.invoke(IPC.workspaceFileCreate, payload),
  workspaceFileMove: (payload) => ipcRenderer.invoke(IPC.workspaceFileMove, payload),
  workspaceFileDelete: (payload) => ipcRenderer.invoke(IPC.workspaceFileDelete, payload),
  workspaceFileReveal: (payload) => ipcRenderer.invoke(IPC.workspaceFileReveal, payload),
  workspaceFormatterStatus: (payload) =>
    ipcRenderer.invoke(IPC.workspaceFormatterStatus, payload),
  workspaceFormatFile: (payload) => ipcRenderer.invoke(IPC.workspaceFormatFile, payload),
  workspaceLspStatus: (payload) => ipcRenderer.invoke(IPC.workspaceLspStatus, payload),
  workspaceLspRequest: (payload) => ipcRenderer.invoke(IPC.workspaceLspRequest, payload),
  workspaceInlineComplete: (payload) => ipcRenderer.invoke(IPC.workspaceInlineComplete, payload),
  workspaceInlineCompleteAbort: (payload) =>
    ipcRenderer.invoke(IPC.workspaceInlineCompleteAbort, payload),
  workspaceEditorRecoverySave: (payload) =>
    ipcRenderer.invoke(IPC.workspaceEditorRecoverySave, payload),
  workspaceEditorRecoveryLoad: (payload) =>
    ipcRenderer.invoke(IPC.workspaceEditorRecoveryLoad, payload),
  workspaceEditorRecoveryClear: (payload) =>
    ipcRenderer.invoke(IPC.workspaceEditorRecoveryClear, payload),
  onWorkspaceEditorFlushRequest: (handler) => {
    const listener = (_: IpcRendererEvent, raw: unknown): void => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
      const requestId = (raw as { requestId?: unknown }).requestId
      if (typeof requestId === 'string' && requestId.length > 0) handler(requestId)
    }
    ipcRenderer.on(IPC.workspaceEditorFlushRequest, listener)
    return () => {
      ipcRenderer.removeListener(IPC.workspaceEditorFlushRequest, listener)
    }
  },
  respondWorkspaceEditorFlush: (requestId, ok) => {
    ipcRenderer.send(IPC.workspaceEditorFlushResponse, { requestId, ok })
  },
  workspaceListDocs: (payload) => ipcRenderer.invoke(IPC.workspaceListDocs, payload),
  workspaceListRules: (payload) => ipcRenderer.invoke(IPC.workspaceListRules, payload),
  workspaceDiagnostics: (payload) => ipcRenderer.invoke(IPC.workspaceDiagnostics, payload),
  onSystemThemeChanged: (handler) => {
    const listener = (_: IpcRendererEvent, prefersDark: unknown): void => {
      if (typeof prefersDark !== 'boolean') return
      handler(prefersDark)
    }
    ipcRenderer.on(IPC.themeChanged, listener)
    return () => {
      ipcRenderer.removeListener(IPC.themeChanged, listener)
    }
  },
  writeClipboard: (text) => {
    if (typeof text !== 'string') return false
    try {
      clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }
}

contextBridge.exposeInMainWorld('vyotiq', api)
