import type {
  ActiveRunsResult,
  AgentEvent,
  ChatMessage,
  ChatFollowUpRemoveRequest,
  ChatFollowUpRemoveResult,
  ChatFollowUpUpdateRequest,
  ChatFollowUpUpdateResult,
  ChatFollowUpPromoteRequest,
  ChatFollowUpPromoteResult,
  ChatFollowUpRequest,
  ChatFollowUpResult,
  ChatQueueModeRequest,
  ChatQueueModeResult,
  ChatStartRequest,
  ChatStartResult,
  ChatUiSubscribeRequest,
  ChatUiSubscribeAddRequest,
  ChatRewindAndStartRequest,
  ChatRewindRequest,
  ChatRewindResult,
  ChatRewindPreviewResult,
  CompactRunResult,
  ResolveWritesResult,
  ReadRunArtifactResult,
  RunArtifactName,
  RunStatsResult,
  HarnessReviewResult,
  HarnessPreviewApplyResult,
  HarnessApplyResult,
  GitCommitResult,
  GitBlameResult,
  GitGenerateCommitMessageResult,
  GitStatusResult,
  IpcResult,
  ListModelsResult,
  ListRunsResult,
  ListOlderRunsResult,
  ExportRunResult,
  LoadRunResult,
  PersistedEvent,
  ProviderId,
  RunSummary,
  SetGoalStatusRequest,
  SetGoalStatusResult,
  SetLoopRequest,
  SetLoopResult,
  SecretProvider,
  SecretsStatus,
  Settings,
  StorageCleanupPreviewResult,
  StorageCleanupRunResult,
  StorageReportResult,
  CodeIndexSettings,
  CodeIndexRuntimeStatus,
  ProcessMetricsSnapshot,
  DictationRuntimeStatus,
  DictationLocalModelId,
  TelemetryStatus,
  AppInfo,
  UpdateInfo,
  UpdaterStatePayload,
  FeedbackComposeRequest,
  FeedbackComposeResult,
  WorkspaceAgentContextRequest,
  WorkspaceAgentContextResult,
  WorkspaceGrepRequest,
  WorkspaceGrepResult,
  GitConflictFileResult,
  GithubIssuesListResult,
  GithubIssueCreateResult,
  CrashDiagnosticsSnapshot,
  CrashRecoveryPending,
  TraceStartResult,
  TraceStatusResult,
  TraceStopResult,
  ToolApprovalDecision,
  ToolApprovalRequest,
  AgentQuestionRequest,
  AgentQuestionAnswer,
  ExtractAttachmentRequest,
  ExtractAttachmentResult,
  DictationTranscribeRequest,
  DictationTranscribeResult,
  McpStatusResult,
  MarketplaceIndex,
  MarketplaceCatalogEntry,
  MarketplaceInstallResult,
  MarketplaceInstallRequest,
  MarketplaceBrowseRequest,
  McpDetectRequest,
  McpDetectResult,
  McpApplyDetectedRequest,
  McpApplyDetectedResult,
  McpScanExternalRequest,
  McpImportExternalRequest,
  McpImportExternalResult,
  PackageContents,
  WorkspaceSettingsOverride,
  WorkspacesState,
  WorkspaceUiState,
  ComposerAttachmentsClearRequest,
  ComposerAttachmentsGetResult,
  ComposerAttachmentsSetRequest,
  WorkspaceFileListRequest,
  WorkspaceFileListResult,
  WorkspaceFileReadRequest,
  WorkspaceFileReadResult,
  WorkspaceFileStatRequest,
  WorkspaceFileStatResult,
  WorkspaceFileSaveRequest,
  WorkspaceFileSaveResult,
  WorkspaceFileCreateRequest,
  WorkspaceFileCreateResult,
  WorkspaceFileMoveRequest,
  WorkspaceFileMoveResult,
  WorkspaceFileDeleteRequest,
  WorkspaceFileDeleteResult,
  WorkspaceFileRevealRequest,
  WorkspaceFormatterStatusRequest,
  WorkspaceFormatterStatus,
  WorkspaceFormatFileRequest,
  WorkspaceFormatFileResult,
  WorkspaceLspStatusRequest,
  WorkspaceLspStatus,
  WorkspaceLspRequest,
  WorkspaceLspResponse,
  WorkspaceInlineCompleteRequest,
  WorkspaceInlineCompleteAbortRequest,
  WorkspaceInlineCompleteResult,
  WorkspaceEditorRecoverySaveRequest,
  WorkspaceEditorRecoveryLoadRequest,
  WorkspaceEditorRecoveryLoadResult,
  WorkspaceEditorRecoveryClearRequest,
  SlashCommandDescriptor,
  SlashCommandResolveResult,
  SlashCommandsCreateRuleResult,
  SlashCommandsCreateSkillResult,
  LocalSkillItem,
  SkillsReadLocalResult,
  SkillsWriteLocalResult,
  NotificationList,
  NotificationMutateRequest,
  NotificationAction
} from './ipc'

/** Host OS from preload `process.platform`. */
export type HostPlatform = 'darwin' | 'win32' | 'linux' | string

/**
 * Renderer-facing updater namespace: `window.vyotiq.updater`.
 * State transitions arrive on the `updater:state` push channel.
 */
export interface VyotiqUpdaterApi {
  /** Current UpdateInfo when a check already found one; otherwise runs a check. */
  check: () => Promise<IpcResult<UpdateInfo | null>>
  download: () => Promise<IpcResult<undefined>>
  install: () => Promise<IpcResult<undefined>>
  onState: (handler: (payload: UpdaterStatePayload) => void) => () => void
}

/** Renderer-facing feedback namespace: `window.vyotiq.feedback`. */
export interface VyotiqFeedbackApi {
  compose: (payload: FeedbackComposeRequest) => Promise<IpcResult<FeedbackComposeResult>>
}

/**
 * Single source of truth for the contextBridge API.
 * Preload implements this; renderer `env.d.ts` types `window.vyotiq` from it.
 */
export interface VyotiqApi {
  platform: HostPlatform
  pickWorkspace: () => Promise<IpcResult<string | null>>
  getWorkspaces: () => Promise<IpcResult<WorkspacesState>>
  addWorkspace: (path?: string) => Promise<IpcResult<WorkspacesState>>
  removeWorkspace: (
    path: string,
    stopActiveRuns?: boolean,
    deleteStorage?: boolean
  ) => Promise<IpcResult<WorkspacesState>>
  setActiveWorkspace: (path: string) => Promise<IpcResult<WorkspacesState>>
  updateWorkspaceUiState: (path: string, ui: WorkspaceUiState) => Promise<IpcResult<true>>
  /** Fire-and-forget UI state flush (e.g. beforeunload). */
  updateWorkspaceUiStateSync: (path: string, ui: WorkspaceUiState) => void
  /** Persisted composer attachment buckets for a workspace (per run key). */
  getComposerAttachments: (workspacePath: string) => Promise<IpcResult<ComposerAttachmentsGetResult>>
  setComposerAttachments: (payload: ComposerAttachmentsSetRequest) => Promise<IpcResult<true>>
  clearComposerAttachments: (payload: ComposerAttachmentsClearRequest) => Promise<IpcResult<true>>
  setWorkspaceSettingsOverride: (
    path: string,
    override: WorkspaceSettingsOverride | null
  ) => Promise<IpcResult<WorkspacesState>>
  getSettings: () => Promise<IpcResult<Settings>>
  setSettings: (partial: Partial<Settings>) => Promise<IpcResult<Settings>>
  /** Live storage usage report (audit H4/H5 retention surface). */
  storageReport: () => Promise<IpcResult<StorageReportResult>>
  /** Reclaim preview for the confirm-gated "Free up space" flow. */
  storageCleanupPreview: () => Promise<IpcResult<StorageCleanupPreviewResult>>
  /** Run the confirmed cleanup — echoes the preview's confirm token. */
  storageCleanupRun: (payload: {
    confirmToken: string
  }) => Promise<IpcResult<StorageCleanupRunResult>>
  /** One-time ack that the user has seen Settings → Storage (§8.1). */
  storageAckSurface: (acked: boolean) => Promise<IpcResult<Settings>>
  getAccessibilitySupportState: () => Promise<IpcResult<{ enabled: boolean }>>
  onAccessibilitySupportChanged: (listener: (payload: { enabled: boolean }) => void) => () => void
  setSecret: (provider: SecretProvider, key: string) => Promise<IpcResult<true>>
  clearSecret: (provider: SecretProvider) => Promise<IpcResult<true>>
  secretStatus: () => Promise<IpcResult<SecretsStatus>>
  listModels: (payload: {
    provider: ProviderId
    baseUrl?: string
    forceRefresh?: boolean
    model?: string
  }) => Promise<IpcResult<ListModelsResult>>
  chatStart: (payload: ChatStartRequest) => Promise<IpcResult<ChatStartResult>>
  /** Tell main which run transcripts are on screen so hidden instance streams stay off the UI thread. */
  chatUiSubscribe: (payload: ChatUiSubscribeRequest) => Promise<IpcResult<true>>
  /** Add one run to the subscribed set the moment it starts (no dropped live deltas). */
  chatUiSubscribeAdd: (payload: ChatUiSubscribeAddRequest) => Promise<IpcResult<true>>
  chatRewindAndStart: (payload: ChatRewindAndStartRequest) => Promise<IpcResult<ChatStartResult>>
  chatRewind: (payload: ChatRewindRequest) => Promise<IpcResult<ChatRewindResult>>
  /** Read-only preview of which files chatRewind would restore. */
  chatRewindPreview: (
    payload: ChatRewindRequest
  ) => Promise<IpcResult<ChatRewindPreviewResult>>
  chatCancel: (runId: string) => Promise<IpcResult<true>>
  chatFollowUp: (payload: ChatFollowUpRequest) => Promise<IpcResult<ChatFollowUpResult>>
  chatFollowUpRemove: (
    payload: ChatFollowUpRemoveRequest
  ) => Promise<IpcResult<ChatFollowUpRemoveResult>>
  chatFollowUpUpdate: (
    payload: ChatFollowUpUpdateRequest
  ) => Promise<IpcResult<ChatFollowUpUpdateResult>>
  chatFollowUpPromote: (
    payload: ChatFollowUpPromoteRequest
  ) => Promise<IpcResult<ChatFollowUpPromoteResult>>
  chatQueueMode: (payload: ChatQueueModeRequest) => Promise<IpcResult<ChatQueueModeResult>>
  chatCompact: (
    workspacePath: string,
    runId: string,
    focus?: string
  ) => Promise<IpcResult<CompactRunResult>>
  resolveWrites: (payload: {
    workspacePath: string
    runId: string
    checkpointId?: string
    action: 'keep' | 'discard'
    paths?: string[]
  }) => Promise<IpcResult<ResolveWritesResult>>
  readRunArtifact: (payload: {
    workspacePath: string
    runId: string
    name: RunArtifactName
  }) => Promise<IpcResult<ReadRunArtifactResult>>
  runStats: (payload: {
    workspacePath: string
    runIds: string[]
  }) => Promise<IpcResult<RunStatsResult>>
  harnessReview: (payload: {
    workspacePath: string
    limit?: number
  }) => Promise<IpcResult<HarnessReviewResult>>
  harnessPreviewApply: (payload: {
    workspacePath: string
    proposalPath?: string
  }) => Promise<IpcResult<HarnessPreviewApplyResult>>
  harnessApply: (payload: {
    workspacePath: string
    proposalPath?: string
    confirm: true
  }) => Promise<IpcResult<HarnessApplyResult>>
  onChatEvent: (handler: (event: AgentEvent) => void) => () => void
  onToolApprovalRequest: (handler: (request: ToolApprovalRequest) => void) => () => void
  respondToolApproval: (
    requestId: string,
    decision: ToolApprovalDecision,
    runId: string
  ) => Promise<IpcResult<boolean>>
  listPendingToolApprovals: (runId: string) => Promise<IpcResult<ToolApprovalRequest[]>>
  onAgentQuestionRequest: (handler: (request: AgentQuestionRequest) => void) => () => void
  respondAgentQuestion: (
    requestId: string,
    answers: AgentQuestionAnswer[],
    runId: string
  ) => Promise<IpcResult<boolean>>
  listPendingAgentQuestions: (runId: string) => Promise<IpcResult<AgentQuestionRequest[]>>
  extractAttachment: (
    payload: ExtractAttachmentRequest
  ) => Promise<IpcResult<ExtractAttachmentResult>>
  transcribeDictation: (
    payload: DictationTranscribeRequest
  ) => Promise<IpcResult<DictationTranscribeResult>>
  cancelDictation: (requestId: string) => Promise<IpcResult<boolean>>
  dictationStatus: () => Promise<IpcResult<DictationRuntimeStatus>>
  dictationInstall: (payload: {
    modelId: DictationLocalModelId
  }) => Promise<IpcResult<DictationRuntimeStatus>>
  dictationUnload: () => Promise<IpcResult<DictationRuntimeStatus>>
  dictationDeleteCache: (payload: {
    modelId: DictationLocalModelId
  }) => Promise<IpcResult<DictationRuntimeStatus>>
  onDictationStatus: (handler: (status: DictationRuntimeStatus) => void) => () => void
  listRuns: (workspacePath: string) => Promise<IpcResult<ListRunsResult>>
  listOlderRuns: (
    workspacePath: string,
    olderThan: string,
    limit?: number
  ) => Promise<IpcResult<ListOlderRunsResult>>
  loadRun: (
    workspacePath: string,
    runId: string
  ) => Promise<IpcResult<LoadRunResult>>
  loadRunEvents: (
    workspacePath: string,
    runId: string
  ) => Promise<IpcResult<PersistedEvent[]>>
  loadToolResult: (
    workspacePath: string,
    runId: string,
    toolCallId: string
  ) => Promise<IpcResult<{ content: string }>>
  deleteRun: (workspacePath: string, runId: string) => Promise<IpcResult<true>>
  exportRun: (
    workspacePath: string,
    runId: string
  ) => Promise<IpcResult<ExportRunResult>>
  renameRun: (
    workspacePath: string,
    runId: string,
    goal: string
  ) => Promise<IpcResult<RunSummary>>
  setGoalStatus: (payload: SetGoalStatusRequest) => Promise<IpcResult<SetGoalStatusResult>>
  setLoop: (payload: SetLoopRequest) => Promise<IpcResult<SetLoopResult>>
  listActiveRuns: () => Promise<IpcResult<ActiveRunsResult>>
  /** Discriminated: ok | not_repo | unavailable (git missing from PATH). */
  gitStatus: (workspacePath: string) => Promise<IpcResult<GitStatusResult>>
  gitGenerateCommitMessage: (payload: {
    workspacePath: string
    mode?: 'all' | 'staged'
  }) => Promise<IpcResult<GitGenerateCommitMessageResult>>
  gitCommit: (
    workspacePath: string,
    message: string,
    push: boolean,
    mode?: 'all' | 'staged'
  ) => Promise<IpcResult<GitCommitResult>>
  gitStageAll: (workspacePath: string) => Promise<IpcResult<{ staged: boolean; detail: string }>>
  gitStagePaths: (payload: {
    workspacePath: string
    paths: string[]
  }) => Promise<IpcResult<{ staged: boolean; detail: string }>>
  gitUnstagePaths: (payload: {
    workspacePath: string
    paths: string[]
  }) => Promise<IpcResult<{ unstaged: boolean; detail: string }>>
  gitBranches: (
    workspacePath: string
  ) => Promise<IpcResult<import('./ipc').GitBranchEntry[]>>
  gitCheckout: (
    workspacePath: string,
    branch: string
  ) => Promise<IpcResult<{ detail: string }>>
  gitLog: (payload: {
    workspacePath: string
    limit?: number
  }) => Promise<IpcResult<import('./ipc').GitLogEntry[]>>
  gitCommitFiles: (payload: {
    workspacePath: string
    sha: string
  }) => Promise<IpcResult<{ files: import('./ipc').GitChangedFile[] }>>
  gitDiff: (payload: {
    workspacePath: string
    path?: string
    staged?: boolean
    ignoreWhitespace?: boolean
    sha?: string
    vsHead?: boolean
  }) => Promise<IpcResult<{ content: string }>>
  gitBlame: (workspacePath: string, path: string) => Promise<IpcResult<GitBlameResult>>
  prView: (workspacePath: string) => Promise<IpcResult<import('./ipc').PrView | null>>
  prCreate: (
    workspacePath: string,
    options?: {
      message?: string
      mode?: 'all' | 'staged'
      draft?: boolean
    }
  ) => Promise<IpcResult<import('./ipc').PrCreateResult>>
  prMerge: (
    workspacePath: string,
    method: import('./ipc').PrMergeMethod,
    number: number
  ) => Promise<IpcResult<{ detail: string }>>
  prDiff: (payload: {
    workspacePath: string
    path?: string
    ignoreWhitespace?: boolean
    number: number
  }) => Promise<IpcResult<{ content: string }>>
  prClose: (
    workspacePath: string,
    number: number
  ) => Promise<IpcResult<{ detail: string }>>
  prEditTitle: (
    workspacePath: string,
    title: string,
    number: number
  ) => Promise<IpcResult<{ title: string }>>
  githubAuthStatus: () => Promise<IpcResult<import('./ipc').GithubAuthStatus>>
  githubAuthStart: () => Promise<IpcResult<import('./ipc').GithubAuthStatus>>
  githubAuthCancel: () => Promise<IpcResult<import('./ipc').GithubAuthStatus>>
  githubAuthLogout: () => Promise<IpcResult<import('./ipc').GithubAuthStatus>>
  onGithubAuthStatus: (handler: (status: import('./ipc').GithubAuthStatus) => void) => () => void
  githubCliInstall: () => Promise<IpcResult<import('./ipc').GithubCliInstallResult>>
  shellOpenExternal: (url: string) => Promise<IpcResult<true>>
  ptyCreate: (payload: {
    workspacePath: string
    cols?: number
    rows?: number
  }) => Promise<IpcResult<import('./ipc').PtySessionInfo>>
  ptyList: (workspacePath?: string) => Promise<IpcResult<import('./ipc').PtySessionInfo[]>>
  ptyWrite: (id: string, data: string, workspacePath: string) => Promise<IpcResult<boolean>>
  ptyResize: (
    id: string,
    cols: number,
    rows: number,
    workspacePath: string
  ) => Promise<IpcResult<boolean>>
  ptyKill: (id: string, workspacePath: string) => Promise<IpcResult<boolean>>
  onPtyData: (handler: (event: { id: string; data: string }) => void) => () => void
  onPtyExit: (handler: (event: { id: string; exitCode: number | null }) => void) => () => void
  windowMinimize: () => Promise<IpcResult<true>>
  windowMaximize: () => Promise<IpcResult<boolean>>
  windowClose: () => Promise<IpcResult<true>>
  windowIsMaximized: () => Promise<IpcResult<boolean>>
  onWindowMaximizedChanged: (handler: (maximized: boolean) => void) => () => void
  onWindowFocusChanged: (handler: (focused: boolean) => void) => () => void
  onBrowserState: (handler: (state: import('./ipc').AgentBrowserState) => void) => () => void
  browserGetState: () => Promise<IpcResult<import('./ipc').AgentBrowserState>>
  browserFocus: () => Promise<IpcResult<boolean>>
  browserClose: () => Promise<IpcResult<true>>
  browserSelectTab: (tabId: string, workspacePath?: string) => Promise<IpcResult<boolean>>
  browserOpenTab: (payload?: {
    url?: string
    workspacePath?: string
  }) => Promise<IpcResult<boolean>>
  browserCloseTab: (tabId?: string, workspacePath?: string) => Promise<IpcResult<boolean>>
  browserTakeControl: () => Promise<IpcResult<boolean>>
  browserReleaseControl: () => Promise<IpcResult<true>>
  browserBack: (workspacePath?: string) => Promise<IpcResult<boolean>>
  browserForward: (workspacePath?: string) => Promise<IpcResult<boolean>>
  browserSetBounds: (
    bounds: { x: number; y: number; width: number; height: number } | null
  ) => Promise<IpcResult<true>>
  browserNavigate: (url: string, workspacePath?: string) => Promise<IpcResult<boolean>>
  browserReload: (workspacePath?: string) => Promise<IpcResult<boolean>>
  browserTakeScreenshot: (payload: {
    workspacePath: string
    runId?: string
    tabId?: string
  }) => Promise<IpcResult<{ path: string }>>
  browserClearBrowsingData: (payload: {
    kind: 'history' | 'cookies' | 'cache' | 'all'
    workspacePath?: string
  }) => Promise<IpcResult<{ cleared: 'history' | 'cookies' | 'cache' | 'all' }>>
  openLogsDir: () => Promise<IpcResult<true>>
  getLogsPath: () => Promise<IpcResult<string>>
  getCrashDiagnostics: () => Promise<IpcResult<CrashDiagnosticsSnapshot>>
  consumeCrashRecovery: () => Promise<IpcResult<CrashRecoveryPending | null>>
  telemetryStatus: () => Promise<IpcResult<TelemetryStatus>>
  startTrace: () => Promise<IpcResult<TraceStartResult>>
  getTraceStatus: () => Promise<IpcResult<TraceStatusResult>>
  stopTrace: () => Promise<IpcResult<TraceStopResult>>
  getAppInfo: () => Promise<IpcResult<AppInfo>>
  updater: VyotiqUpdaterApi
  feedback: VyotiqFeedbackApi
  workspaceGrep: (payload: WorkspaceGrepRequest) => Promise<IpcResult<WorkspaceGrepResult>>
  gitConflictFile: (payload: {
    workspacePath: string
    path: string
  }) => Promise<IpcResult<GitConflictFileResult>>
  gitResolveConflict: (payload: {
    workspacePath: string
    path: string
    content: string
  }) => Promise<IpcResult<{ detail: string }>>
  prReview: (payload: {
    workspacePath: string
    event: 'approve' | 'request-changes' | 'comment'
    body?: string
    number?: number
  }) => Promise<IpcResult<{ detail: string }>>
  githubIssuesList: (payload: {
    workspacePath: string
  }) => Promise<IpcResult<GithubIssuesListResult>>
  githubIssueCreate: (payload: {
    workspacePath: string
    title: string
    body?: string
  }) => Promise<IpcResult<GithubIssueCreateResult>>
  mcpStatus: (payload?: { workspacePath?: string | null }) => Promise<IpcResult<McpStatusResult>>
  mcpRefresh: (payload?: { workspacePath?: string | null }) => Promise<IpcResult<McpStatusResult>>
  mcpSetAuthToken: (serverId: string, token: string) => Promise<IpcResult<true>>
  mcpClearAuthToken: (serverId: string) => Promise<IpcResult<true>>
  mcpStartOAuth: (
    serverId: string,
    opts?: {
      authScope?: 'all-workspaces' | 'this-workspace'
      workspacePath?: string
      googleAccess?: 'read' | 'read-write'
    }
  ) => Promise<IpcResult<McpStatusResult>>
  mcpSetOAuthClientSecret: (serverId: string, secret: string) => Promise<IpcResult<true>>
  mcpClearOAuthClientSecret: (serverId: string) => Promise<IpcResult<true>>
  mcpSetGoogleClientSecret: (secret: string) => Promise<IpcResult<true>>
  mcpClearGoogleClientSecret: () => Promise<IpcResult<true>>
  marketplaceListInstalled: () => Promise<IpcResult<MarketplaceIndex>>
  marketplaceBrowse: (
    payload?: MarketplaceBrowseRequest
  ) => Promise<IpcResult<{ packages: MarketplaceCatalogEntry[] }>>
  marketplaceRefreshCatalog: () => Promise<
    IpcResult<{ packages: MarketplaceCatalogEntry[]; remoteCount: number }>
  >
  marketplaceInstall: (
    payload: MarketplaceInstallRequest
  ) => Promise<IpcResult<MarketplaceInstallResult>>
  marketplaceDetectMcp: (
    payload: McpDetectRequest
  ) => Promise<IpcResult<McpDetectResult>>
  marketplaceApplyDetectedMcp: (
    payload: McpApplyDetectedRequest
  ) => Promise<IpcResult<McpApplyDetectedResult>>
  marketplaceScanExternalMcp: (
    payload?: McpScanExternalRequest
  ) => Promise<IpcResult<McpImportExternalResult>>
  marketplaceImportExternalMcp: (
    payload: McpImportExternalRequest
  ) => Promise<IpcResult<McpImportExternalResult>>
  marketplaceUninstall: (
    id: string,
    opts?: { signOutGithub?: boolean }
  ) => Promise<IpcResult<MarketplaceIndex>>
  marketplaceSetEnabled: (
    id: string,
    enabled: boolean
  ) => Promise<IpcResult<MarketplaceIndex>>
  marketplacePickLocal: () => Promise<IpcResult<string | null>>
  marketplaceGetContents: (id: string) => Promise<IpcResult<PackageContents>>
  marketplaceAckRemoteInstall: (acked: boolean) => Promise<IpcResult<Settings>>
  slashCommandsList: (payload?: {
    workspacePath?: string | null
  }) => Promise<IpcResult<{ commands: SlashCommandDescriptor[] }>>
  slashCommandsResolve: (payload: {
    id: string
    workspacePath?: string | null
    trailingText?: string
  }) => Promise<IpcResult<SlashCommandResolveResult>>
  slashCommandsCreateRule: (payload: {
    workspacePath: string
    title?: string
  }) => Promise<IpcResult<SlashCommandsCreateRuleResult>>
  slashCommandsCreateSkill: (payload: {
    workspacePath?: string | null
    title?: string
    scope?: 'project' | 'personal'
  }) => Promise<IpcResult<SlashCommandsCreateSkillResult>>
  slashCommandsOpenFile: (payload: {
    workspacePath: string
    path: string
  }) => Promise<IpcResult<true>>
  skillsListLocal: (payload?: {
    workspacePath?: string | null
  }) => Promise<IpcResult<{ skills: LocalSkillItem[] }>>
  skillsOpenLocal: (payload: {
    workspacePath?: string | null
    skillPath: string
  }) => Promise<IpcResult<true>>
  skillsReadLocal: (payload: {
    workspacePath?: string | null
    skillPath: string
  }) => Promise<IpcResult<SkillsReadLocalResult>>
  skillsWriteLocal: (payload: {
    workspacePath?: string | null
    skillPath: string
    content: string
  }) => Promise<IpcResult<SkillsWriteLocalResult>>
  skillsDeleteLocal: (payload: {
    workspacePath?: string | null
    skillPath: string
  }) => Promise<IpcResult<true>>
  workspaceSuggestPaths: (payload: {
    workspacePath: string
    query?: string
    maxResults?: number
  }) => Promise<IpcResult<{ paths: string[]; total: number }>>
  workspaceReadText: (payload: {
    workspacePath: string
    path: string
  }) => Promise<IpcResult<{ name: string; mime: string; text: string; truncated: boolean }>>
  workspaceReadImage: (payload: {
    workspacePath: string
    path: string
  }) => Promise<IpcResult<{ mime: string; dataUrl: string }>>
  workspaceFileList: (
    payload: WorkspaceFileListRequest
  ) => Promise<IpcResult<WorkspaceFileListResult>>
  workspaceFileRead: (
    payload: WorkspaceFileReadRequest
  ) => Promise<IpcResult<WorkspaceFileReadResult>>
  workspaceFileStat: (
    payload: WorkspaceFileStatRequest
  ) => Promise<IpcResult<WorkspaceFileStatResult>>
  workspaceFileSave: (
    payload: WorkspaceFileSaveRequest
  ) => Promise<IpcResult<WorkspaceFileSaveResult>>
  workspaceFileCreate: (
    payload: WorkspaceFileCreateRequest
  ) => Promise<IpcResult<WorkspaceFileCreateResult>>
  workspaceFileMove: (
    payload: WorkspaceFileMoveRequest
  ) => Promise<IpcResult<WorkspaceFileMoveResult>>
  workspaceFileDelete: (
    payload: WorkspaceFileDeleteRequest
  ) => Promise<IpcResult<WorkspaceFileDeleteResult>>
  workspaceFileReveal: (
    payload: WorkspaceFileRevealRequest
  ) => Promise<IpcResult<true>>
  workspaceFormatterStatus: (
    payload: WorkspaceFormatterStatusRequest
  ) => Promise<IpcResult<WorkspaceFormatterStatus>>
  workspaceFormatFile: (
    payload: WorkspaceFormatFileRequest
  ) => Promise<IpcResult<WorkspaceFormatFileResult>>
  workspaceLspStatus: (
    payload: WorkspaceLspStatusRequest
  ) => Promise<IpcResult<WorkspaceLspStatus>>
  workspaceLspRequest: (
    payload: WorkspaceLspRequest
  ) => Promise<IpcResult<WorkspaceLspResponse>>
  workspaceInlineComplete: (
    payload: WorkspaceInlineCompleteRequest
  ) => Promise<IpcResult<WorkspaceInlineCompleteResult>>
  workspaceInlineCompleteAbort: (
    payload: WorkspaceInlineCompleteAbortRequest
  ) => Promise<IpcResult<true>>
  workspaceEditorRecoverySave: (
    payload: WorkspaceEditorRecoverySaveRequest
  ) => Promise<IpcResult<true>>
  workspaceEditorRecoveryLoad: (
    payload: WorkspaceEditorRecoveryLoadRequest
  ) => Promise<IpcResult<WorkspaceEditorRecoveryLoadResult>>
  workspaceEditorRecoveryClear: (
    payload: WorkspaceEditorRecoveryClearRequest
  ) => Promise<IpcResult<true>>
  onWorkspaceEditorFlushRequest: (handler: (requestId: string) => void) => () => void
  respondWorkspaceEditorFlush: (requestId: string, ok: boolean) => void
  workspaceListDocs: (payload: {
    workspacePath: string
    query?: string
    maxResults?: number
  }) => Promise<IpcResult<{ paths: string[] }>>
  workspaceListRules: (payload: {
    workspacePath: string
  }) => Promise<
    IpcResult<{ rules: Array<{ path: string; description?: string; alwaysApply: boolean }> }>
  >
  workspaceDiagnostics: (payload: {
    workspacePath: string
    kind?: 'typecheck' | 'lint'
  }) => Promise<IpcResult<{ ok: boolean; content: string; kind: 'typecheck' | 'lint' }>>
  getSystemTheme: () => Promise<IpcResult<boolean>>
  appearancePickCustomCss: () => Promise<IpcResult<string | null>>
  appearanceReadCustomCss: () => Promise<IpcResult<{ css: string }>>
  onAppearanceCustomCssChanged: (handler: () => void) => () => void
  /** Main-process connectivity probe (1.1.1.1 HEAD) — matches agent retry logic. */
  probeNetwork: () => Promise<IpcResult<boolean>>
  /** Read-only "what the agent knows" summary for the active workspace. */
  agentContext: (payload: WorkspaceAgentContextRequest) => Promise<
    IpcResult<WorkspaceAgentContextResult>
  >
  /** Local codebase index embedder / download status. */
  codeIndexStatus: () => Promise<
    IpcResult<CodeIndexRuntimeStatus & { settings: CodeIndexSettings }>
  >
  /** Force re-sync of the active workspace code index. */
  codeIndexReindex: (payload?: { workspacePath?: string }) => Promise<
    IpcResult<{ scanned: number; indexed: number; skipped: number; removed: number } | null>
  >
  /** Live code-index / embed progress pushed from main. */
  onCodeIndexStatus: (handler: (status: CodeIndexRuntimeStatus) => void) => () => void
  /** Chromium per-process RSS/CPU plus embed utility RSS. */
  processMetrics: () => Promise<IpcResult<ProcessMetricsSnapshot>>
  onSkillsChanged: (handler: (payload: { workspacePath: string | null }) => void) => () => void
  listNotifications: () => Promise<IpcResult<NotificationList>>
  markNotificationsRead: (payload: NotificationMutateRequest) => Promise<IpcResult<NotificationList>>
  dismissNotifications: (payload: NotificationMutateRequest) => Promise<IpcResult<NotificationList>>
  onNotificationsChanged: (handler: (payload: NotificationList) => void) => () => void
  onNotificationActivate: (handler: (action: NotificationAction) => void) => () => void
  onSystemThemeChanged: (handler: (prefersDark: boolean) => void) => () => void
  /** Native OS clipboard write (sandboxed preload). Write-only. */
  writeClipboard: (text: string) => boolean
}
