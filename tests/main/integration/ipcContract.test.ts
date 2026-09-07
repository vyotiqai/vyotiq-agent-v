import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { IPC } from '@shared/channels'
import type { VyotiqApi } from '@shared/vyotiqApi'

/** Invoke channels exposed on VyotiqApi (push listeners + sync send excluded). */
const VYOTIQ_INVOKE_MAP: Record<
  Exclude<
    keyof VyotiqApi,
    | 'platform'
    | 'onChatEvent'
    | 'onToolApprovalRequest'
    | 'onAgentQuestionRequest'
    | 'onWindowMaximizedChanged'
    | 'onWindowFocusChanged'
    | 'onSystemThemeChanged'
    | 'onBrowserState'
    | 'onPtyData'
    | 'onPtyExit'
    | 'onWorkspaceEditorFlushRequest'
    | 'onCodeIndexStatus'
    | 'onDictationStatus'
    | 'onGithubAuthStatus'
    | 'onSkillsChanged'
    | 'onNotificationsChanged'
    | 'onNotificationActivate'
    | 'onAppearanceCustomCssChanged'
    | 'onUpdaterStatus'
    | 'onAccessibilitySupportChanged'
    | 'updateWorkspaceUiStateSync'
    | 'respondWorkspaceEditorFlush'
  >,
  string
> = {
  pickWorkspace: IPC.pickWorkspace,
  getWorkspaces: IPC.workspacesGet,
  addWorkspace: IPC.workspacesAdd,
  removeWorkspace: IPC.workspacesRemove,
  setActiveWorkspace: IPC.workspacesSetActive,
  updateWorkspaceUiState: IPC.workspacesUpdateUiState,
  setWorkspaceSettingsOverride: IPC.workspacesSetSettingsOverride,
  getComposerAttachments: IPC.composerAttachmentsGet,
  setComposerAttachments: IPC.composerAttachmentsSet,
  clearComposerAttachments: IPC.composerAttachmentsClear,
  getSettings: IPC.getSettings,
  getAccessibilitySupportState: IPC.accessibilitySupportState,
  setSettings: IPC.setSettings,
  setSecret: IPC.setSecret,
  clearSecret: IPC.clearSecret,
  secretStatus: IPC.secretStatus,
  listModels: IPC.listModels,
  chatStart: IPC.chatStart,
  chatUiSubscribe: IPC.chatUiSubscribe,
  chatUiSubscribeAdd: IPC.chatUiSubscribeAdd,
  chatRewindAndStart: IPC.chatRewindAndStart,
  chatRewind: IPC.chatRewind,
  chatCancel: IPC.chatCancel,
  chatFollowUp: IPC.chatFollowUp,
  chatFollowUpRemove: IPC.chatFollowUpRemove,
  chatFollowUpUpdate: IPC.chatFollowUpUpdate,
  chatFollowUpPromote: IPC.chatFollowUpPromote,
  chatQueueMode: IPC.chatQueueMode,
  chatCompact: IPC.chatCompact,
  chatRewindPreview: IPC.chatRewindPreview,
  resolveWrites: IPC.runsResolveWrites,
  readRunArtifact: IPC.runsReadArtifact,
  setGoalStatus: IPC.runsSetGoalStatus,
  setLoop: IPC.runsSetLoop,
  harnessReview: IPC.harnessReview,
  harnessPreviewApply: IPC.harnessPreviewApply,
  harnessApply: IPC.harnessApply,
  respondToolApproval: IPC.toolApprovalResponse,
  listPendingToolApprovals: IPC.toolApprovalListPending,
  respondAgentQuestion: IPC.agentQuestionResponse,
  listPendingAgentQuestions: IPC.agentQuestionListPending,
  extractAttachment: IPC.attachmentExtract,
  transcribeDictation: IPC.dictationTranscribe,
  cancelDictation: IPC.dictationCancel,
  dictationStatus: IPC.dictationStatus,
  dictationInstall: IPC.dictationInstall,
  dictationUnload: IPC.dictationUnload,
  dictationDeleteCache: IPC.dictationDeleteCache,
  listRuns: IPC.listRuns,
  listOlderRuns: IPC.listOlderRuns,
  loadRun: IPC.loadRun,
  loadRunEvents: IPC.loadRunEvents,
  loadToolResult: IPC.loadToolResult,
  deleteRun: IPC.runsDelete,
  exportRun: IPC.runsExport,
  renameRun: IPC.runsRename,
  listActiveRuns: IPC.runsActive,
  browserGetState: IPC.browserGetState,
  browserFocus: IPC.browserFocus,
  browserClose: IPC.browserClose,
  browserSelectTab: IPC.browserSelectTab,
  browserOpenTab: IPC.browserOpenTab,
  browserCloseTab: IPC.browserCloseTab,
  browserTakeControl: IPC.browserTakeControl,
  browserReleaseControl: IPC.browserReleaseControl,
  browserBack: IPC.browserBack,
  browserForward: IPC.browserForward,
  browserSetBounds: IPC.browserSetBounds,
  browserNavigate: IPC.browserNavigate,
  browserReload: IPC.browserReload,
  browserTakeScreenshot: IPC.browserTakeScreenshot,
  browserClearBrowsingData: IPC.browserClearBrowsingData,
  gitStatus: IPC.gitStatus,
  gitGenerateCommitMessage: IPC.gitGenerateCommitMessage,
  gitDiff: IPC.gitDiff,
  gitBlame: IPC.gitBlame,
  gitCommit: IPC.gitCommit,
  gitStageAll: IPC.gitStageAll,
  gitLog: IPC.gitLog,
  gitCommitFiles: IPC.gitCommitFiles,
  prView: IPC.prView,
  prCreate: IPC.prCreate,
  prMerge: IPC.prMerge,
  prDiff: IPC.prDiff,
  prClose: IPC.prClose,
  prEditTitle: IPC.prEditTitle,
  ptyCreate: IPC.ptyCreate,
  ptyList: IPC.ptyList,
  ptyWrite: IPC.ptyWrite,
  ptyResize: IPC.ptyResize,
  ptyKill: IPC.ptyKill,
  gitStagePaths: IPC.gitStagePaths,
  gitUnstagePaths: IPC.gitUnstagePaths,
  gitBranches: IPC.gitBranches,
  gitCheckout: IPC.gitCheckout,
  marketplaceAckRemoteInstall: IPC.marketplaceAckRemoteInstall,
  githubAuthStatus: IPC.githubAuthStatus,
  githubAuthStart: IPC.githubAuthStart,
  githubAuthCancel: IPC.githubAuthCancel,
  githubAuthLogout: IPC.githubAuthLogout,
  githubCliInstall: IPC.githubCliInstall,
  shellOpenExternal: IPC.shellOpenExternal,
  workspaceSuggestPaths: IPC.workspaceSuggestPaths,
  workspaceReadText: IPC.workspaceReadText,
  workspaceReadImage: IPC.workspaceReadImage,
  workspaceFileList: IPC.workspaceFileList,
  workspaceFileRead: IPC.workspaceFileRead,
  workspaceFileStat: IPC.workspaceFileStat,
  workspaceFileSave: IPC.workspaceFileSave,
  workspaceFileCreate: IPC.workspaceFileCreate,
  workspaceFileMove: IPC.workspaceFileMove,
  workspaceFileDelete: IPC.workspaceFileDelete,
  workspaceFileReveal: IPC.workspaceFileReveal,
  workspaceFormatterStatus: IPC.workspaceFormatterStatus,
  workspaceFormatFile: IPC.workspaceFormatFile,
  workspaceLspStatus: IPC.workspaceLspStatus,
  workspaceLspRequest: IPC.workspaceLspRequest,
  workspaceInlineComplete: IPC.workspaceInlineComplete,
  workspaceInlineCompleteAbort: IPC.workspaceInlineCompleteAbort,
  workspaceEditorRecoverySave: IPC.workspaceEditorRecoverySave,
  workspaceEditorRecoveryLoad: IPC.workspaceEditorRecoveryLoad,
  workspaceEditorRecoveryClear: IPC.workspaceEditorRecoveryClear,
  workspaceListDocs: IPC.workspaceListDocs,
  workspaceListRules: IPC.workspaceListRules,
  agentContext: IPC.agentContext,
  workspaceDiagnostics: IPC.workspaceDiagnostics,
  windowMinimize: IPC.windowMinimize,
  windowMaximize: IPC.windowMaximize,
  windowClose: IPC.windowClose,
  windowIsMaximized: IPC.windowIsMaximized,
  openLogsDir: IPC.logsOpenDir,
  getLogsPath: IPC.logsGetPath,
  getCrashDiagnostics: IPC.crashDiagnosticsGet,
  consumeCrashRecovery: IPC.crashRecoveryConsume,
  telemetryStatus: IPC.telemetryStatus,
  startTrace: IPC.traceStart,
  getTraceStatus: IPC.traceStatus,
  stopTrace: IPC.traceStop,
  getAppInfo: IPC.appInfo,
  getUpdaterStatus: IPC.updaterStatus,
  checkForAppUpdates: IPC.updaterCheck,
  downloadAppUpdate: IPC.updaterDownload,
  installAppUpdate: IPC.updaterInstall,
  workspaceGrep: IPC.workspaceGrep,
  gitConflictFile: IPC.gitConflictFile,
  gitResolveConflict: IPC.gitResolveConflict,
  prReview: IPC.prReview,
  githubIssuesList: IPC.githubIssuesList,
  githubIssueCreate: IPC.githubIssueCreate,
  mcpStatus: IPC.mcpStatus,
  mcpRefresh: IPC.mcpRefresh,
  mcpSetAuthToken: IPC.mcpSetAuthToken,
  mcpClearAuthToken: IPC.mcpClearAuthToken,
  mcpSetOAuthClientSecret: IPC.mcpSetOAuthClientSecret,
  mcpClearOAuthClientSecret: IPC.mcpClearOAuthClientSecret,
  mcpSetGoogleClientSecret: IPC.mcpSetGoogleClientSecret,
  mcpClearGoogleClientSecret: IPC.mcpClearGoogleClientSecret,
  mcpStartOAuth: IPC.mcpStartOAuth,
  marketplaceListInstalled: IPC.marketplaceListInstalled,
  marketplaceBrowse: IPC.marketplaceBrowse,
  marketplaceRefreshCatalog: IPC.marketplaceRefreshCatalog,
  marketplaceInstall: IPC.marketplaceInstall,
  marketplaceDetectMcp: IPC.marketplaceDetectMcp,
  marketplaceApplyDetectedMcp: IPC.marketplaceApplyDetectedMcp,
  marketplaceScanExternalMcp: IPC.marketplaceScanExternalMcp,
  marketplaceImportExternalMcp: IPC.marketplaceImportExternalMcp,
  marketplaceUninstall: IPC.marketplaceUninstall,
  marketplaceSetEnabled: IPC.marketplaceSetEnabled,
  marketplacePickLocal: IPC.marketplacePickLocal,
  marketplaceGetContents: IPC.marketplaceGetContents,
  slashCommandsList: IPC.slashCommandsList,
  slashCommandsResolve: IPC.slashCommandsResolve,
  slashCommandsCreateRule: IPC.slashCommandsCreateRule,
  slashCommandsCreateSkill: IPC.slashCommandsCreateSkill,
  slashCommandsOpenFile: IPC.slashCommandsOpenFile,
  skillsListLocal: IPC.skillsListLocal,
  skillsOpenLocal: IPC.skillsOpenLocal,
  skillsReadLocal: IPC.skillsReadLocal,
  skillsWriteLocal: IPC.skillsWriteLocal,
  skillsDeleteLocal: IPC.skillsDeleteLocal,
  getSystemTheme: IPC.getSystemTheme,
  appearancePickCustomCss: IPC.appearancePickCustomCss,
  appearanceReadCustomCss: IPC.appearanceReadCustomCss,
  probeNetwork: IPC.networkProbe,
  codeIndexStatus: IPC.codeIndexStatus,
  codeIndexReindex: IPC.codeIndexReindex,
  processMetrics: IPC.processMetrics,
  listNotifications: IPC.notificationsList,
  markNotificationsRead: IPC.notificationsMarkRead,
  dismissNotifications: IPC.notificationsDismiss
}

const PRELOAD_INTERNAL_INVOKE_CHANNELS = new Set<string>([IPC.agentQuestionReject])
const EVENT_CHANNELS = new Set<string>([
  IPC.workspaceEditorFlushRequest,
  IPC.workspaceEditorFlushResponse
])

const PUSH_CHANNELS = new Set<string>([
  IPC.chatEvent,
  IPC.toolApprovalRequest,
  IPC.agentQuestionRequest,
  IPC.windowMaximizedChanged,
  IPC.windowFocusChanged,
  IPC.themeChanged,
  IPC.browserState,
  IPC.ptyData,
  IPC.ptyExit,
  IPC.codeIndexStatusEvent,
  IPC.dictationStatusEvent,
  IPC.githubAuthStatusEvent,
  IPC.skillsChanged,
  IPC.notificationsChanged,
  IPC.notificationsActivate,
  IPC.appearanceCustomCssChanged,
  IPC.updaterStatusEvent,
  IPC.accessibilitySupportChanged
])

const VYOTIQ_SYNC_SEND_MAP: Record<'updateWorkspaceUiStateSync', string> = {
  updateWorkspaceUiStateSync: IPC.workspacesUpdateUiStateSync
}

const VYOTIQ_PUSH_MAP: Record<
  | 'onChatEvent'
  | 'onToolApprovalRequest'
  | 'onAgentQuestionRequest'
  | 'onWindowMaximizedChanged'
  | 'onWindowFocusChanged'
  | 'onSystemThemeChanged'
  | 'onBrowserState'
  | 'onPtyData'
  | 'onPtyExit'
  | 'onCodeIndexStatus'
  | 'onDictationStatus'
  | 'onGithubAuthStatus'
  | 'onSkillsChanged'
  | 'onNotificationsChanged'
  | 'onNotificationActivate'
  | 'onAppearanceCustomCssChanged'
  | 'onUpdaterStatus'
  | 'onAccessibilitySupportChanged',
  string
> = {
  onChatEvent: IPC.chatEvent,
  onToolApprovalRequest: IPC.toolApprovalRequest,
  onAgentQuestionRequest: IPC.agentQuestionRequest,
  onWindowMaximizedChanged: IPC.windowMaximizedChanged,
  onWindowFocusChanged: IPC.windowFocusChanged,
  onSystemThemeChanged: IPC.themeChanged,
  onBrowserState: IPC.browserState,
  onPtyData: IPC.ptyData,
  onPtyExit: IPC.ptyExit,
  onCodeIndexStatus: IPC.codeIndexStatusEvent,
  onDictationStatus: IPC.dictationStatusEvent,
  onGithubAuthStatus: IPC.githubAuthStatusEvent,
  onSkillsChanged: IPC.skillsChanged,
  onNotificationsChanged: IPC.notificationsChanged,
  onNotificationActivate: IPC.notificationsActivate,
  onAppearanceCustomCssChanged: IPC.appearanceCustomCssChanged,
  onUpdaterStatus: IPC.updaterStatusEvent,
  onAccessibilitySupportChanged: IPC.accessibilitySupportChanged
}

describe('main/renderer IPC contract', () => {
  it('maps every VyotiqApi invoke to a shared IPC channel', () => {
    const channels = new Set(Object.values(IPC))
    for (const channel of Object.values(VYOTIQ_INVOKE_MAP)) {
      expect(channels.has(channel)).toBe(true)
      expect(PUSH_CHANNELS.has(channel)).toBe(false)
    }
    expect(Object.keys(VYOTIQ_INVOKE_MAP)).toHaveLength(190)
  })

  it('maps every VyotiqApi push listener to a push channel', () => {
    const channels = new Set(Object.values(IPC))
    for (const channel of Object.values(VYOTIQ_PUSH_MAP)) {
      expect(channels.has(channel)).toBe(true)
      expect(PUSH_CHANNELS.has(channel)).toBe(true)
    }
    expect(Object.keys(VYOTIQ_PUSH_MAP)).toHaveLength(18)
  })

  it('accounts for every IPC channel as invoke or push', () => {
    const accounted = new Set([
      ...Object.values(VYOTIQ_INVOKE_MAP),
      ...Object.values(VYOTIQ_PUSH_MAP),
      ...Object.values(VYOTIQ_SYNC_SEND_MAP),
      ...PRELOAD_INTERNAL_INVOKE_CHANNELS,
      ...EVENT_CHANNELS
    ])
    const missing = Object.values(IPC).filter((channel) => !accounted.has(channel))
    expect(missing).toEqual([])
    expect(accounted.size).toBe(Object.values(IPC).length)
  })

  it('registers ipcMain handlers for all invoke channels', () => {
    const registerSrc = readFileSync(
      join(process.cwd(), 'src/main/ipc/register.ts'),
      'utf8'
    )
    for (const channel of Object.values(VYOTIQ_INVOKE_MAP)) {
      const key = channelKey(channel)
      expect(registerSrc).toMatch(new RegExp(`ipcMain\\.handle\\(\\s*IPC\\.${key}`))
    }
  })

  it('preload wires invoke channels to ipcRenderer.invoke', () => {
    const preloadSrc = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    for (const [method, channel] of Object.entries(VYOTIQ_INVOKE_MAP)) {
      expect(preloadSrc).toContain(`${method}:`)
      expect(preloadSrc).toContain(`ipcRenderer.invoke(IPC.${channelKey(channel)}`)
    }
  })

  it('preload wires push channels to ipcRenderer.on', () => {
    const preloadSrc = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    for (const [method, channel] of Object.entries(VYOTIQ_PUSH_MAP)) {
      expect(preloadSrc).toContain(`${method}:`)
      expect(preloadSrc).toContain(`ipcRenderer.on(IPC.${channelKey(channel)}`)
    }
  })

  it('preload invokes internal-only channels', () => {
    const preloadSrc = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    for (const channel of PRELOAD_INTERNAL_INVOKE_CHANNELS) {
      expect(preloadSrc).toContain(`ipcRenderer.invoke(IPC.${channelKey(channel)}`)
    }
  })

  it('preload wires sync send channels to ipcRenderer.send', () => {
    const preloadSrc = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    for (const [method, channel] of Object.entries(VYOTIQ_SYNC_SEND_MAP)) {
      expect(preloadSrc).toContain(`${method}:`)
      expect(preloadSrc).toContain(`ipcRenderer.send(IPC.${channelKey(channel)}`)
    }
  })
})

function channelKey(channel: string): string {
  const entry = Object.entries(IPC).find(([, value]) => value === channel)
  if (!entry) throw new Error(`Unknown IPC channel: ${channel}`)
  return entry[0]
}
