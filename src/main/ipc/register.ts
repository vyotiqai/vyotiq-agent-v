import { ipcMain, BrowserWindow, shell, nativeTheme, dialog, app } from 'electron'
import { release as osRelease } from 'os'
import { ZodError } from 'zod'
import { IPC } from '../../shared/channels'
import { isGithubMcpId, isGoogleMcpId } from '../../shared/mcpApps'
import { toolMessageForIpc } from '../../shared/utils/toolResultIpc'
import {
  ChatStartRequestSchema,
  ChatUiSubscribeRequestSchema,
  ChatUiSubscribeAddRequestSchema,
  ComposerAttachmentsClearRequestSchema,
  ComposerAttachmentsGetRequestSchema,
  ComposerAttachmentsSetRequestSchema,
  ChatRewindAndStartRequestSchema,
  ChatRewindRequestSchema,
  CancelRunRequestSchema,
  ChatFollowUpRequestSchema,
  ChatFollowUpRemoveRequestSchema,
  ChatFollowUpUpdateRequestSchema,
  ChatFollowUpPromoteRequestSchema,
  ChatQueueModeRequestSchema,
  CompactRunRequestSchema,
  ResolveWritesRequestSchema,
  ReadRunArtifactRequestSchema,
  RunStatsRequestSchema,
  HarnessReviewRequestSchema,
  HarnessPreviewApplyRequestSchema,
  HarnessApplyRequestSchema,
  SetSettingsRequestSchema,
  SetSecretRequestSchema,
  ClearSecretRequestSchema,
  ListModelsRequestSchema,
  ListRunsRequestSchema,
  ListOlderRunsRequestSchema,
  LoadRunRequestSchema,
  LoadRunEventsRequestSchema,
  type LoadRunResult,
  LoadToolResultRequestSchema,
  DeleteRunRequestSchema,
  ExportRunRequestSchema,
  RenameRunRequestSchema,
  SetGoalStatusRequestSchema,
  SetLoopRequestSchema,
  WorkspacesAddRequestSchema,
  WorkspacesRemoveRequestSchema,
  WorkspacesSetActiveRequestSchema,
  WorkspacesUpdateUiStateRequestSchema,
  WorkspacesSetSettingsOverrideRequestSchema,
  GitStatusRequestSchema,
  GitGenerateCommitMessageRequestSchema,
  GitCommitRequestSchema,
  GitStageAllRequestSchema,
  GitStagePathsRequestSchema,
  GitUnstagePathsRequestSchema,
  GitBranchesRequestSchema,
  GitCheckoutRequestSchema,
  GitDiffRequestSchema,
  GitBlameRequestSchema,
  GitLogRequestSchema,
  GitCommitFilesRequestSchema,
  PrViewRequestSchema,
  PrCreateRequestSchema,
  PrMergeRequestSchema,
  PrDiffRequestSchema,
  PrCloseRequestSchema,
  PrEditTitleRequestSchema,
  ShellOpenExternalRequestSchema,
  PtyCreateRequestSchema,
  PtyListRequestSchema,
  PtyIdRequestSchema,
  PtyWriteRequestSchema,
  PtyResizeRequestSchema,
  ToolApprovalResponseSchema,
  AgentQuestionResponseSchema,
  AgentQuestionRejectSchema,
  ListPendingAgentQuestionsRequestSchema,
  ListPendingToolApprovalsRequestSchema,
  ExtractAttachmentRequestSchema,
  DictationTranscribeRequestSchema,
  DictationCancelRequestSchema,
  WorkspaceSuggestPathsRequestSchema,
  WorkspaceReadTextRequestSchema,
  WorkspaceReadImageRequestSchema,
  WorkspaceFileListRequestSchema,
  WorkspaceFileReadRequestSchema,
  WorkspaceFileStatRequestSchema,
  WorkspaceFileSaveRequestSchema,
  WorkspaceFileCreateRequestSchema,
  WorkspaceFileMoveRequestSchema,
  WorkspaceFileDeleteRequestSchema,
  WorkspaceFileRevealRequestSchema,
  WorkspaceFormatterStatusRequestSchema,
  WorkspaceFormatFileRequestSchema,
  WorkspaceLspStatusRequestSchema,
  WorkspaceLspRequestSchema,
  WorkspaceInlineCompleteRequestSchema,
  WorkspaceInlineCompleteAbortRequestSchema,
  WorkspaceGrepRequestSchema,
  GitConflictFileRequestSchema,
  GitResolveConflictRequestSchema,
  PrReviewRequestSchema,
  GithubIssuesListRequestSchema,
  GithubIssueCreateRequestSchema,
  WorkspaceEditorRecoverySaveRequestSchema,
  WorkspaceEditorRecoveryLoadRequestSchema,
  WorkspaceEditorRecoveryClearRequestSchema,
  WorkspaceListDocsRequestSchema,
  WorkspaceListRulesRequestSchema,
  WorkspaceAgentContextRequestSchema,
  WorkspaceDiagnosticsRequestSchema,
  MarketplaceBrowseRequestSchema,
  MarketplaceGetContentsRequestSchema,
  MarketplaceInstallRequestSchema,
  MarketplaceRemoteInstallAckRequestSchema,
  MarketplaceSetEnabledRequestSchema,
  MarketplaceUninstallRequestSchema,
  McpDetectRequestSchema,
  McpClearAuthTokenRequestSchema,
  McpClearGoogleClientSecretRequestSchema,
  McpClearOAuthClientSecretRequestSchema,
  McpRefreshRequestSchema,
  McpSetAuthTokenRequestSchema,
  McpSetGoogleClientSecretRequestSchema,
  McpSetOAuthClientSecretRequestSchema,
  McpStartOAuthRequestSchema,
  McpStatusRequestSchema,
  McpApplyDetectedRequestSchema,
  McpImportExternalRequestSchema,
  McpScanExternalRequestSchema,
  SlashCommandsListRequestSchema,
  SlashCommandsResolveRequestSchema,
  SlashCommandsCreateRuleRequestSchema,
  SlashCommandsCreateSkillRequestSchema,
  SlashCommandsOpenFileRequestSchema,
  SkillsListLocalRequestSchema,
  SkillsOpenLocalRequestSchema,
  SkillsReadLocalRequestSchema,
  SkillsWriteLocalRequestSchema,
  SkillsDeleteLocalRequestSchema,
  CodeIndexReindexRequestSchema,
  DictationInstallRequestSchema,
  DictationDeleteCacheRequestSchema,
  ok,
  fail,
  type TraceStartResult,
  type TraceStatusResult,
  type TraceStopResult,
  MAX_ATTACHMENT_BYTES,
  WORKSPACE_FILE_BINARY_MAX_BYTES,
  type ExtractAttachmentResult,
  type DictationTranscribeResult,
  type IpcResult,
  type Settings,
  type StorageCleanupPreviewResult,
  type StorageCleanupRunResult,
  type StorageReportResult,
  type AgentEvent,
  type AgentQuestionRequest,
  type ToolApprovalRequest,
  type ChatStartResult,
  type ChatRewindResult,
  type ChatRewindPreviewResult,
  type ChatFollowUpResult,
  type ChatFollowUpRemoveResult,
  type ChatFollowUpUpdateResult,
  type ChatFollowUpPromoteResult,
  type ChatQueueModeResult,
  type ChatMessage,
  type CompactRunResult,
  type ResolveWritesResult,
  type ReadRunArtifactResult,
  type RunStatsResult,
  type HarnessReviewResult,
  type HarnessPreviewApplyResult,
  type HarnessApplyResult,
  type ListRunsResult,
  type ListOlderRunsResult,
  type RunSummary,
  type ExportRunResult,
  type SecretsStatus,
  type ListModelsResult,
  type PersistedEvent,
  type TelemetryStatus,
  type AppInfo,
  type UpdateInfo,
  type UpdaterStatePayload,
  type FeedbackComposeRequest,
  type FeedbackComposeResult,
  UpdaterCheckRequestSchema,
  UpdaterDownloadRequestSchema,
  UpdaterInstallRequestSchema,
  FeedbackComposeRequestSchema,
  type WorkspaceGrepResult,
  type GitConflictFileResult,
  type GithubIssuesListResult,
  type GithubIssueCreateResult,
  type CrashDiagnosticsSnapshot,
  type CrashRecoveryPending,
  type McpStatusResult,
  type WorkspacesState,
  type ActiveRunsResult,
  type GitStatusResult,
  type GitCommitResult,
  type AgentBrowserState,
  BrowserNavigateRequestSchema,
  BrowserWorkspaceScopeSchema,
  BrowserSelectTabRequestSchema,
  BrowserOpenTabRequestSchema,
  BrowserCloseTabRequestSchema,
  BrowserClearBrowsingDataRequestSchema,
  BrowserSetBoundsRequestSchema,
  BrowserTakeScreenshotRequestSchema,
  NotificationMutateRequestSchema,
  type ComposerAttachmentsGetResult,
  type NotificationList
} from '../../shared/ipc'
import {
  resolveProviderListBaseUrl,
  validateCustomOpenAiBaseUrl,
  validateOllamaBaseUrl
} from '../../shared/providers'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import { formatError, AppError, isAbortError, isAppError } from '../../shared/errors'
import { scrubString } from '../../shared/utils/scrub'
import { logger, logErrorSummary } from '../../shared/logger'
import { pickWorkspace } from '@main/workspace/workspace'
import { resolveInsideWorkspace } from '@main/workspace/safePath'
import { getSettings, setSettings, setMarketplaceRemoteInstallAcked, redactSettingsForIpc, enqueueSettingsMutation } from '@main/settings/settings'
import { syncMcpServers, getMcpServerStatus, mcpStatusExtras, refreshMcpServers, startMcpOAuth, setMcpStdioWorkspace } from '@main/agent/mcp'
import { headersWithoutAuthorization } from '../../shared/utils/mcpAuth'
import {
  browseCatalog,
  refreshRemoteCatalog,
  readMarketplaceIndex,
  installMarketplacePackage,
  removeInstalledItem,
  setInstalledEnabled,
  syncMarketplaceMcpIntoSettings,
  resolveEffectiveMcpServers,
  resolveMcpServersForSessionMap,
  getPackageContents,
  detectMcpInput,
  applyDetectedManualMcp,
  scanExternalMcpConfigs,
  importExternalMcpServers,
  invalidateMcpResolveCache
} from '@main/marketplace'
import {
  listSlashCommands,
  resolveSlashCommand,
  createWorkspaceRule,
  createWorkspaceSkill,
  openSlashFile
} from '@main/agent/slashCommands'
import { runHarnessReviewWithSettings } from '@main/agent/harnessReviewRun'
import {
  isAllowedLocalSkillPath,
  isSkillRelatedRelPath,
  listLocalSkillItems,
  readLocalSkillFile,
  writeLocalSkillFile,
  deleteLocalSkillFile
} from '@main/agent/skills/local'
import { notifySkillsChanged } from '@main/agent/skills/notify'
import { WORKSPACE_HARNESS_REL } from '@main/agent/harness'
import {
  applyHarnessProposal,
  previewHarnessApply,
  workspaceHasEditableHarness
} from '@main/agent/harnessApply'
import {
  setSecret,
  clearSecret,
  getSecret,
  secretStatus,
  setMcpAuthToken,
  clearMcpAuthToken,
  clearMcpOAuthState,
  setMcpOAuthClientSecret,
  clearMcpOAuthClientSecret,
  setGoogleMcpClientSecret,
  clearGoogleMcpClientSecret,
  enqueueSecretsMutation
} from '@main/settings/secrets'
import { getChatEventDispatcher, setChatEventUiSubscriptions, addChatEventUiSubscription } from './streamBatch'
import { installIpcTiming, timeSyncIpc } from '../perf/ipcTiming'
import { createRunId } from '../agent/loop'
import { hydrateRunFollowUps, startAgentRunInBackground } from '../agent/startAgentRun'
import {
  compactRunNow,
  CompactionUnavailableError,
  CompactionVerifyFailedError
} from '../agent/compactRun'
import { resolveWrites, planRewindWrites, getWriteCheckpointMeta } from '../agent/checkpoints'
import { prepareRewindAndReplaceUserMessage, prepareRewindToUserMessage } from '../agent/rewindRun'
import { resolveRunDir, workspaceSessionsRoot, workspaceBrowserArtifactsDir } from '@main/storage/paths'
import {
  collectStorageReport,
  previewStorageCleanup,
  runStorageCleanup,
  deleteWorkspaceStorageDir
} from '@main/storage/retention'
import { collectRunStats } from '../agent/runStats'
  import { focusAgentBrowser, closeAgentBrowser, getAgentBrowserState, selectBrowserTab, browserGoBack, browserGoForward, setAgentBrowserBounds, navigateUrl, clearAgentBrowserData, takeBrowserScreenshot, disposeAgentBrowserForWorkspace, takeBrowserControl, releaseBrowserControl, manageTabs } from '@main/app/agentBrowser'
import { extractAttachment } from '../attachments/extract'
import {
  clearComposerAttachmentsForWorkspace,
  listComposerAttachmentsForWorkspace,
  setComposerAttachmentsForWorkspace
} from '../attachments/composerStore'
import { transcribeDictation } from '../dictation/transcribe'
import {
  listPendingToolApprovals,
  resolveToolApproval
} from '../agent/toolApproval'
import {
  listPendingAgentQuestions,
  pendingQuestionRunId,
  resolveAgentQuestion,
  rejectAgentQuestion
} from '../agent/agentQuestion'
import { listProviderModels } from '../agent/providers'
import { clearModelCache } from '../agent/providers/modelCache'
import { collectWorkspaceFiles } from '../agent/tools/walk'
import {
  disposeWorkspaceIndexes,
  warmWorkspaceIndexes,
  workspaceIndexAbortSignal
} from '../agent/workspaceIndex'
import {
  onCodeIndexRuntimeStatus,
  getCodeIndexRuntimeStatus,
  reindexCodeIndex
} from '@main/agent/codeindex'
import { pruneStaleInstanceWorktreesBestEffort } from '../git/instanceWorktree'
import { listWorkspaceRulesForMention, clearRulesCache, isRuleRelatedRelPath } from '../agent/context/rules'
import { buildWorkspaceAgentContext } from '../agent/context/agentContext'
import { toolDiagnosticsAsync } from '../agent/tools/diagnostics'
import { disposeTerminalSessionsForWorkspace as disposeAgentTerminalSessionsForWorkspace } from '../agent/tools/terminalSessions'
import {
  chatCancelResult,
  listActiveRuns,
  tryRegisterRunAbort,
  clearRunAbort,
  isActive,
  isRunTurnComplete,
  waitUntilRunInactive,
  enqueueFollowUp,
  removeFollowUp,
  updateFollowUp,
  promoteFollowUp,
  peekFollowUps,
  setPendingMode,
  getRunInvokeId,
  followUpPreview,
  getRunWorkspace
} from '../agent/runRegistry'
import {
  loadFollowUpPreviews,
  syncFollowUpsToDisk,
  clearFollowUps as clearFollowUpsOnDisk
} from '../agent/followUpStore'
import {
  listRuns,
  listRunsOlder,
  buildRunMarkdownExport,
  loadMessagesAsync,
  loadEventsForRunAsync,
  LOAD_EVENTS_UI_LIMIT,
  loadToolResultContent,
  loadStatus,
  deleteRun,
  renameRun,
  runExists,
  appendEvent
} from '../agent/state'
import { pauseGoalIfActive, readGoal, updateGoalStatus } from '../agent/runGoal'
import { emitGoalUpdate } from '../agent/goalEvents'
import { armLoop, disarmLoop, readLoop } from '../agent/runLoopScheduler'
import { launchRunFollowUpOrStart } from '../agent/launchRunInvoke'
import { formatGoalContinueMessage } from '../../shared/goalRuntime'
import {
  getWorkspaces,
  addWorkspace,
  removeWorkspace,
  setActiveWorkspace,
  updateWorkspaceUiState,
  setWorkspaceSettingsOverride,
  findWorkspaceSettingsOverride,
  enqueueWorkspaceMutation
} from '@main/workspace/workspaces'
import { canonicalizeWorkspacePath, isCuratedDocPath, isSafeWorkspaceRelPath, workspacePathsEqual } from '../../shared/workspacePath'
import { relative, isAbsolute, join } from 'path'
import {
  checkoutBranch,
  commitAll,
  listLocalBranches,
  readGitCommitFiles,
  readGitBlame,
  readGitDiff,
  readGitLog,
  stageAll,
  stagePaths,
  unstagePaths,
  readConflictFile,
  resolveConflict
} from '@main/git/git'
import { invalidateGitStatusCache, readGitStatusCached } from '@main/git/gitStatusCache'
import { generateCommitMessage } from '@main/git/commitMessage'
import {
  prClose,
  prCreate,
  prCreateFromChanges,
  prDiff,
  prEditTitle,
  prMerge,
  prView,
  reviewPullRequest,
  listGithubIssues,
  createGithubIssue
} from '@main/git/gh'
import {
  cancelGithubAuth,
  githubAuthStatus,
  linkNativeGithubFromMcpToken,
  logoutGithubAuth,
  onGithubAuthStatus,
  startGithubAuth
} from '@main/git/githubAuth'
import { installGithubCli } from '@main/git/ghBinary'
import {
  checkForAppUpdates,
  downloadAppUpdate,
  installAppUpdate
} from '@main/updater'
import { composeFeedback } from '@main/feedback'
import { grepWorkspaceHits } from '@main/agent/tools/grep'
import {
  createPtySession,
  disposePtySessionsForWorkspace,
  killPty,
  listPtySessions,
  resizePty,
  writePty
} from '@main/app/ptySessions'
import {
  applyWindowChrome,
  getMainWindow
} from '@main/app/window'
import {
  initCustomCssWatchFromSettings,
  notifyCustomCssChanged,
  readCustomCssForSettings,
  syncCustomCssWatch
} from '@main/appearance/customCss'
import { logsDirectory } from '../logging/init'
import { getTraceAutoCapture } from '../perf/traceAutoCapture'
import {
  consumeRendererRecoveryPending,
  getCrashDiagnosticsSnapshot
} from '../logging/crashDiagnostics'
import { listNotifications, markNotificationsRead, dismissNotifications } from '../notifications/service'
import { applySentryTelemetry, isSentryBuildConfigured } from '../logging/sentry'
import { probeNetworkOnline } from '../agent/networkMonitor'
import { collectProcessMetrics } from '../perf/loadSnapshot'
import {
  clearEditorRecovery,
  createWorkspaceFile,
  deleteWorkspaceFile,
  listWorkspaceDirectory,
  loadEditorRecovery,
  moveWorkspaceFile,
  readWorkspaceFile,
  readWorkspaceAttachmentBytes,
  saveEditorRecovery,
  saveWorkspaceFile,
  statWorkspaceFile,
  WorkspaceFileError
} from '@main/workspace/fileService'
import {
  formatWorkspaceFile,
  workspaceFormatterStatus
} from '@main/workspace/formatter'
import {
  disposeWorkspaceLsp,
  workspaceLspRequest,
  workspaceLspStatus
} from '@main/workspace/lspService'
import { abortInlineComplete, completeInline } from '@main/workspace/inlineComplete'

export { chatCancelResult }

const dictationTranscriptions = new Map<string, AbortController>()

type IpcSender = { sender: Electron.WebContents; senderFrame?: Electron.WebFrameMain | null | undefined }

function senderOk(event: IpcSender): boolean {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return false
  const mainWindow = getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed() || win !== mainWindow) return false
  // Electron guidance: validate senderFrame so a compromised subframe cannot
  // invoke privileged handlers.
  const frame = event.senderFrame
  const main = event.sender.mainFrame
  if (frame === undefined && main === undefined) return false
  if (!frame || !main) return false
  if (typeof (frame as { isDestroyed?: () => boolean }).isDestroyed === 'function') {
    if ((frame as { isDestroyed: () => boolean }).isDestroyed()) return false
  }
  return frame === main
}

function sendToCurrentRenderer(
  channel: string,
  payload: unknown,
  fallback?: Electron.WebContents
): void {
  const current = getMainWindow()
  const target =
    current && !current.isDestroyed() && !current.webContents.isDestroyed()
      ? current.webContents
      : fallback && !fallback.isDestroyed()
        ? fallback
        : null
  target?.send(channel, payload)
}

/** Git runs commands in a directory, so only ever in one the user has opened. */
function isOpenWorkspace(path: string): boolean {
  return getWorkspaces().openPaths.some((open) => workspacePathsEqual(open, path))
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp'
}

function isExpectedIpcFailure(err: unknown): boolean {
  if (err instanceof AppError && (err.code === 'IPC_CLIENT' || err.code === 'MCP_CONNECT' || err.code === 'MCP_SPAWN')) {
    return true
  }
  const msg = formatError(err)
  return /no undoable write checkpoint|nothing to undo|no editable harness|already undone|already resolved|checkpoint not found|invalid checkpoint|no harness proposal found|missing a ## Proposed harness body|requires confirm|no git remote|no git remotes|no default remote|not a git repository|unable to determine base repository|could not determine base repository|no initial commit/i.test(
    msg
  )
}

function failFrom(err: unknown, channel: string, correlationId?: string): IpcResult<never> {
  const isValidation = err instanceof ZodError || (err instanceof AppError && err.code === 'IPC_VALIDATION')
  const message = formatError(err)
  const expected = !isValidation && !isAbortError(err) && isExpectedIpcFailure(err)
  // AppError `err` fields are taxonomy-only; append scrubbed message/cause for ops.
  const summary = isValidation
    ? logErrorSummary(err, 'IPC_VALIDATION')
    : isAbortError(err)
      ? logErrorSummary(err)
      : expected
        ? logErrorSummary(err, 'IPC_CLIENT')
        : logErrorSummary(err, 'IPC_HANDLER')
  const detail =
    isAppError(err) && message && message !== 'Unknown error'
      ? `${summary} — ${message}`
      : summary
  const logLine = isValidation
    ? `IPC validation failed: ${detail}`
    : isAbortError(err)
      ? `IPC aborted: ${detail}`
      : expected
        ? `IPC expected failure: ${detail}`
        : `IPC handler failed: ${detail}`
  const code = isValidation
    ? 'IPC_VALIDATION'
    : isAbortError(err)
      ? undefined
      : expected
        ? 'IPC_CLIENT'
        : 'IPC_HANDLER'
  if (isValidation) {
    logger.warn(logLine, {
      scope: 'ipc',
      code: 'IPC_VALIDATION',
      channel,
      correlationId,
      err,
      reason: message
    })
  } else if (isAbortError(err) || expected) {
    logger.warn(logLine, {
      scope: 'ipc',
      ...(code ? { code } : {}),
      channel,
      correlationId,
      err,
      reason: message
    })
  } else {
    logger.error(logLine, {
      scope: 'ipc',
      code,
      channel,
      correlationId,
      err,
      reason: message
    })
  }
  return fail(message, code)
}

/**
 * Expected user-state rejections (workspace/run checks, rewind index validation)
 * must still reach the log: they were previously returned silently, so a
 * renderer-side `IPC_CLIENT` error had no main-side cause to audit (2026-09-07
 * chatRewindAndStart failures). `reason` is an allow-listed log field and is
 * path/user-data scrubbed by the logger facade.
 */
function failExpected(
  error: string,
  channel: string,
  correlationId?: string,
  code?: string
): IpcResult<never> {
  logger.warn('IPC expected failure', {
    scope: 'ipc',
    ...(code ? { code } : {}),
    channel,
    ...(correlationId ? { correlationId } : {}),
    reason: error
  })
  return fail(error, code)
}

function failWorkspaceFile(err: unknown, channel: string): IpcResult<never> {
  if (err instanceof WorkspaceFileError) {
    logger.warn('Workspace file operation failed', {
      scope: 'ipc',
      channel,
      code: err.code,
      reason: err.message
    })
    return fail(err.message, err.code)
  }
  return failFrom(err, channel)
}

/** Persist Keep/Discard/Undo into events.jsonl so reload hydrates resolution state. */
function persistWriteCheckpointEvent(
  runDir: string,
  runId: string,
  checkpointId: string
): void {
  // Soft no-op resolveWrites returns checkpointId '' — do not validate/throw.
  if (!checkpointId.trim()) return
  const meta = getWriteCheckpointMeta(runDir, checkpointId)
  if (!meta) return
  appendEvent(runDir, {
    type: 'writes_checkpoint',
    runId,
    checkpointId: meta.id,
    undone: Boolean(meta.undone || meta.resolved),
    files: meta.files
  })
}

/** The process-wide flight recorder (created here if boot init has not run yet). */
function getTraceCapture(): ReturnType<typeof getTraceAutoCapture>['capture'] {
  return getTraceAutoCapture().capture
}

export function registerIpc(): void {
  installIpcTiming()

  // Push live code-index / embed progress to all renderer windows.
  onCodeIndexRuntimeStatus((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try {
        win.webContents.send(IPC.codeIndexStatusEvent, status)
      } catch {
        /* ignore */
      }
    }
  })

  void import('@main/dictation').then(({ onDictationRuntimeStatus }) => {
    onDictationRuntimeStatus((status) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue
        try {
          win.webContents.send(IPC.dictationStatusEvent, status)
        } catch {
          /* ignore */
        }
      }
    })
  })

  onGithubAuthStatus((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try {
        win.webContents.send(IPC.githubAuthStatusEvent, status)
      } catch {
        /* ignore */
      }
    }
  })

  ipcMain.handle(IPC.pickWorkspace, async (event): Promise<IpcResult<string | null>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      return ok(await pickWorkspace(win))
    } catch (err) {
      return failFrom(err, IPC.pickWorkspace)
    }
  })

  ipcMain.handle(IPC.workspacesGet, async (event): Promise<IpcResult<WorkspacesState>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(getWorkspaces())
    } catch (err) {
      return failFrom(err, IPC.workspacesGet)
    }
  })

  ipcMain.handle(
    IPC.workspacesAdd,
    async (event, raw): Promise<IpcResult<WorkspacesState>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = WorkspacesAddRequestSchema.parse(raw ?? {})
        const win = BrowserWindow.fromWebContents(event.sender)
        const next = await addWorkspace(win, req.path)
        invalidateMcpResolveCache()
        await syncMcpServers(resolveMcpServersForSessionMap())
        const warmPath = next.activePath ?? req.path
        if (warmPath) {
          warmWorkspaceIndexes(warmPath)
          pruneStaleInstanceWorktreesBestEffort(
            warmPath,
            new Set(listActiveRuns().map((run) => run.runId))
          )
        }
        return ok(next)
      } catch (err) {
        return failFrom(err, IPC.workspacesAdd)
      }
    }
  )

  ipcMain.handle(
    IPC.workspacesRemove,
    async (event, raw): Promise<IpcResult<WorkspacesState>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const { path, stopActiveRuns, deleteStorage } = WorkspacesRemoveRequestSchema.parse(raw)
        const activeRuns = listActiveRuns().filter((run) =>
          workspacePathsEqual(run.workspacePath, path)
        )
        if (activeRuns.length > 0 && !stopActiveRuns) {
          return fail(
            `Workspace has ${activeRuns.length} active run(s). Confirm “Stop run and close” to continue.`
          )
        }
        for (const run of activeRuns) {
          chatCancelResult(run.runId)
        }
        disposeAgentTerminalSessionsForWorkspace(path)
        disposePtySessionsForWorkspace(path)
        disposeAgentBrowserForWorkspace(path)
        disposeWorkspaceLsp(path)
        // Same mutation queue as UI state / setActive — flushPersistUiState sync
        // IPC otherwise races remove and can rewrite openPaths from a stale read.
        disposeWorkspaceIndexes(path)
        const next = await enqueueWorkspaceMutation(() => removeWorkspace(path))
        // Storage retention (audit H5): renderer-confirmed storage-dir delete
        // on workspace removal. Skip silently when the dir is gone already.
        if (deleteStorage && getSettings().storage.pruneOnWorkspaceRemoval) {
          await deleteWorkspaceStorageDir(path)
        }
        invalidateMcpResolveCache()
        await syncMcpServers(resolveMcpServersForSessionMap())
        return ok(next)
      } catch (err) {
        return failFrom(err, IPC.workspacesRemove)
      }
    }
  )

  ipcMain.handle(
    IPC.workspacesSetActive,
    async (event, raw): Promise<IpcResult<WorkspacesState>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const { path } = WorkspacesSetActiveRequestSchema.parse(raw)
        const state = await enqueueWorkspaceMutation(() => setActiveWorkspace(path))
        setMcpStdioWorkspace(path)
        warmWorkspaceIndexes(path)
        pruneStaleInstanceWorktreesBestEffort(
          path,
          new Set(listActiveRuns().map((run) => run.runId))
        )
        return ok(state)
      } catch (err) {
        return failFrom(err, IPC.workspacesSetActive)
      }
    }
  )

  ipcMain.handle(
    IPC.workspacesUpdateUiState,
    async (event, raw): Promise<IpcResult<true>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const { path, ui } = WorkspacesUpdateUiStateRequestSchema.parse(raw)
        if (!isOpenWorkspace(path)) return fail('Workspace is not open')
        return ok(await enqueueWorkspaceMutation(() => updateWorkspaceUiState(path, ui)))
      } catch (err) {
        return failFrom(err, IPC.workspacesUpdateUiState)
      }
    }
  )

  ipcMain.on(IPC.workspacesUpdateUiStateSync, (event, raw) => {
    if (!senderOk(event)) return
    timeSyncIpc(IPC.workspacesUpdateUiStateSync, () => {
      try {
        const { path, ui } = WorkspacesUpdateUiStateRequestSchema.parse(raw)
        if (!isOpenWorkspace(path)) return
        // Fire-and-forget through the same mutation queue / writeGeneration path
        // as the async handler so sync IPC cannot race other workspace writes.
        void enqueueWorkspaceMutation(() => updateWorkspaceUiState(path, ui)).catch((err) => {
          logger.warn('Sync UI state update failed', {
            scope: 'ipc',
            channel: IPC.workspacesUpdateUiStateSync,
            err
          })
        })
      } catch (err) {
        logger.warn('Sync UI state update failed', {
          scope: 'ipc',
          channel: IPC.workspacesUpdateUiStateSync,
          err
        })
      }
    })
  })

  ipcMain.handle(
    IPC.workspacesSetSettingsOverride,
    async (event, raw): Promise<IpcResult<WorkspacesState>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const { path, override } = WorkspacesSetSettingsOverrideRequestSchema.parse(raw)
        if (!isOpenWorkspace(path)) return fail('Workspace is not open')
        const next = await enqueueWorkspaceMutation(() =>
          setWorkspaceSettingsOverride(path, override)
        )
        invalidateMcpResolveCache()
        // Force-off / Force-on may change which MCP processes should stay alive.
        await syncMcpServers(resolveMcpServersForSessionMap())
        notifySkillsChanged(path)
        return ok(next)
      } catch (err) {
        return failFrom(err, IPC.workspacesSetSettingsOverride)
      }
    }
  )

  ipcMain.handle(IPC.getSettings, async (event): Promise<IpcResult<Settings>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(redactSettingsForIpc(getSettings()))
    } catch (err) {
      return failFrom(err, IPC.getSettings)
    }
  })

  ipcMain.handle(IPC.setSettings, async (event, raw): Promise<IpcResult<Settings>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const partial = SetSettingsRequestSchema.parse(raw)
      const next = await enqueueSettingsMutation(() => setSettings(partial))
      if (partial.theme !== undefined || partial.skinId !== undefined) {
        applyWindowChrome(next.theme, next.skinId)
      }
      if (partial.customCssPath !== undefined) {
        syncCustomCssWatch(next.customCssPath)
        notifyCustomCssChanged()
      }
      if (partial.telemetryEnabled !== undefined) {
        applySentryTelemetry(next.telemetryEnabled)
      }
      if (partial.mcpServers !== undefined || partial.marketplace !== undefined) {
        invalidateMcpResolveCache()
        await syncMcpServers(resolveMcpServersForSessionMap())
      }
      return ok(redactSettingsForIpc(next))
    } catch (err) {
      return failFrom(err, IPC.setSettings)
    }
  })

  ipcMain.handle(IPC.storageReport, async (event): Promise<IpcResult<StorageReportResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(await collectStorageReport())
    } catch (err) {
      return failFrom(err, IPC.storageReport)
    }
  })

  ipcMain.handle(
    IPC.storageCleanupPreview,
    async (event): Promise<IpcResult<StorageCleanupPreviewResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        StorageCleanupPreviewRequestSchema.parse({})
        return ok(await previewStorageCleanup())
      } catch (err) {
        return failFrom(err, IPC.storageCleanupPreview)
      }
    }
  )

  ipcMain.handle(
    IPC.storageCleanupRun,
    async (event, raw): Promise<IpcResult<StorageCleanupRunResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = StorageCleanupRunRequestSchema.parse(raw)
        return ok(await runStorageCleanup(req.confirmToken))
      } catch (err) {
        return failFrom(err, IPC.storageCleanupRun)
      }
    }
  )

  ipcMain.handle(IPC.storageAckSurface, async (event, raw): Promise<IpcResult<Settings>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = StorageSurfaceAckRequestSchema.parse(raw)
      const next = await enqueueSettingsMutation(() =>
        setSettings({ storageSurfaceAcked: req.acked })
      )
      return ok(redactSettingsForIpc(next))
    } catch (err) {
      return failFrom(err, IPC.storageAckSurface)
    }
  })

  ipcMain.handle(IPC.setSecret, async (event, raw): Promise<IpcResult<true>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { provider, key } = SetSecretRequestSchema.parse(raw)
      await enqueueSecretsMutation(() => setSecret(provider, key))
      clearModelCache()
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.setSecret)
    }
  })

  ipcMain.handle(IPC.clearSecret, async (event, raw): Promise<IpcResult<true>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { provider } = ClearSecretRequestSchema.parse(raw)
      await enqueueSecretsMutation(() => clearSecret(provider))
      clearModelCache()
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.clearSecret)
    }
  })

  ipcMain.handle(
    IPC.secretStatus,
    async (event): Promise<IpcResult<SecretsStatus>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        return ok(secretStatus())
      } catch (err) {
        return failFrom(err, IPC.secretStatus)
      }
    }
  )

  ipcMain.handle(
    IPC.listModels,
    async (event, raw): Promise<IpcResult<ListModelsResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = ListModelsRequestSchema.parse(raw ?? {})
        if (req.baseUrl && (req.provider === 'custom' || req.provider === 'ollama')) {
          // Gate direct catalog requests too: a bad base must error clearly
          // instead of silently falling back to the local default.
          const check =
            req.provider === 'custom'
              ? validateCustomOpenAiBaseUrl(req.baseUrl)
              : validateOllamaBaseUrl(req.baseUrl)
          if (!check.ok) return fail(check.error)
        }
        const settings = getSettings()
        const apiKey = getSecret(req.provider)
        const baseUrl = resolveProviderListBaseUrl(
          req.provider,
          req.baseUrl,
          settings,
          apiKey
        )
        const result = await listProviderModels({
          provider: req.provider,
          apiKey,
          baseUrl,
          forceRefresh: req.forceRefresh,
          model: req.model
        })
        return ok(result)
      } catch (err) {
        return failFrom(err, IPC.listModels)
      }
    }
  )

  ipcMain.handle(IPC.chatStart, async (event, raw): Promise<IpcResult<ChatStartResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = ChatStartRequestSchema.parse(raw)
      const workspaces = getWorkspaces()
      const open = workspaces.openPaths.some((p) => workspacePathsEqual(p, req.workspacePath))
      if (!open) {
        return failExpected('Workspace is not open', IPC.chatStart)
      }
      if (!existsSync(req.workspacePath)) {
        return failExpected('Workspace path does not exist', IPC.chatStart)
      }
      const wc = event.sender
      let runId: string
      let resume = false
      if (req.runId && runExists(req.workspacePath, req.runId)) {
        if (isActive(req.runId)) {
          // UI can show done while finally is still flushing; wait for unwind
          // instead of failing a quick next send with "Run is already active".
          if (isRunTurnComplete(req.runId)) {
            const cleared = await waitUntilRunInactive(req.runId)
            if (!cleared || isActive(req.runId)) {
              return failExpected('Run is already active', IPC.chatStart, req.runId)
            }
          } else {
            return failExpected('Run is already active', IPC.chatStart, req.runId)
          }
        }
        runId = req.runId
        resume = true
      } else {
        runId = createRunId()
      }
      // Atomic register BEFORE return so cancel works during startup and concurrent
      // chatStart cannot overlap the same runDir (check+set with no await gap).
      const registered = tryRegisterRunAbort(runId, req.workspacePath)
      if (!registered.ok) {
        return failExpected(registered.error, IPC.chatStart, runId, registered.code)
      }
      const { invokeId } = registered
      if (resume) {
        // Dedupe against the freshly sent messages: a crash between enqueue and
        // apply followed by a manual resend must not apply the text twice.
        hydrateRunFollowUps(req.workspacePath, runId, req.newMessages)
      }
      logger.info('Chat start', {
        scope: 'ipc',
        correlationId: runId,
        channel: IPC.chatStart,
        resume
      })

      const agentInput =
        req.incremental && req.runId && req.newMessages?.length
          ? {
              runId,
              workspacePath: req.workspacePath,
              resume,
              newMessages: req.newMessages,
              persistedMessageCount: req.persistedMessageCount,
              mode: req.mode,
              focusedFile: req.focusedFile,
              provider: req.provider,
              model: req.model
            }
          : {
              runId,
              messages: req.messages ?? [],
              workspacePath: req.workspacePath,
              resume,
              mode: req.mode,
              focusedFile: req.focusedFile,
              provider: req.provider,
              model: req.model
            }
      startAgentRunInBackground({
        runId,
        workspacePath: req.workspacePath,
        invokeId,
        controller: registered.controller,
        wc,
        agentInput
      })

      return ok({ runId, invokeId })
    } catch (err) {
      return failFrom(err, IPC.chatStart)
    }
  })

  ipcMain.handle(
    IPC.chatRewindAndStart,
    async (event, raw): Promise<IpcResult<ChatStartResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = ChatRewindAndStartRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) {
          return failExpected('Workspace is not open', IPC.chatRewindAndStart, req.runId)
        }
        if (!existsSync(req.workspacePath)) {
          return failExpected('Workspace path does not exist', IPC.chatRewindAndStart, req.runId)
        }
        if (!runExists(req.workspacePath, req.runId)) {
          return failExpected('Run not found', IPC.chatRewindAndStart, req.runId)
        }

        if (isActive(req.runId)) {
          const cancelled = chatCancelResult(req.runId)
          if (!cancelled.ok) {
            return failExpected(cancelled.error, IPC.chatRewindAndStart, req.runId)
          }
          const cleared = await waitUntilRunInactive(req.runId)
          if (!cleared || isActive(req.runId)) {
            return failExpected('Run is already active', IPC.chatRewindAndStart, req.runId)
          }
        }

        // Register before mutating disk so a failed register cannot leave a
        // rewound transcript without a new invoke (matches chatStart ordering).
        const runId = req.runId
        const registered = tryRegisterRunAbort(runId, req.workspacePath)
        if (!registered.ok) {
          return failExpected(registered.error, IPC.chatRewindAndStart, runId, registered.code)
        }
        const { invokeId } = registered

        let prepared: Awaited<ReturnType<typeof prepareRewindAndReplaceUserMessage>>
        try {
          prepared = await prepareRewindAndReplaceUserMessage({
            workspacePath: req.workspacePath,
            runId: req.runId,
            editMessageIndex: req.editMessageIndex,
            editedUserMessage: req.editedUserMessage
          })
        } catch (err) {
          clearRunAbort(runId, invokeId)
          throw err
        }
        if (prepared.writes.restored.length > 0) {
          invalidateGitStatusCache(req.workspacePath)
        }

        const wc = event.sender
        logger.info('Chat rewind and start', {
          scope: 'ipc',
          correlationId: runId,
          channel: IPC.chatRewindAndStart,
          editMessageIndex: req.editMessageIndex,
          restoredFiles: prepared.writes.restored.length
        })

        startAgentRunInBackground({
          runId,
          workspacePath: req.workspacePath,
          invokeId,
          controller: registered.controller,
          wc,
          agentInput: {
            runId,
            workspacePath: req.workspacePath,
            resume: true,
            mode: req.mode,
            provider: req.provider,
            model: req.model
          }
        })

        return ok({ runId, invokeId })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // prepareRewind user-state (index/role/missing run) — not IPC_HANDLER.
        if (/editMessageIndex|run not found/i.test(msg)) {
          return failExpected(msg, IPC.chatRewindAndStart)
        }
        return failFrom(err, IPC.chatRewindAndStart)
      }
    }
  )

  ipcMain.handle(IPC.chatRewind, async (event, raw): Promise<IpcResult<ChatRewindResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = ChatRewindRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) {
        return failExpected('Workspace is not open', IPC.chatRewind, req.runId)
      }
      if (!existsSync(req.workspacePath)) {
        return failExpected('Workspace path does not exist', IPC.chatRewind, req.runId)
      }
      if (!runExists(req.workspacePath, req.runId)) {
        return failExpected('Run not found', IPC.chatRewind, req.runId)
      }

      if (isActive(req.runId)) {
        const cancelled = chatCancelResult(req.runId)
        if (!cancelled.ok) {
          return failExpected(cancelled.error, IPC.chatRewind, req.runId)
        }
        const cleared = await waitUntilRunInactive(req.runId)
        if (!cleared || isActive(req.runId)) {
          return failExpected('Run is already active', IPC.chatRewind, req.runId)
        }
      }

      const prepared = await prepareRewindToUserMessage({
        workspacePath: req.workspacePath,
        runId: req.runId,
        userMessageIndex: req.userMessageIndex
      })
      if (prepared.writes.restored.length > 0) {
        invalidateGitStatusCache(req.workspacePath)
      }

      logger.info('Chat rewind', {
        scope: 'ipc',
        correlationId: req.runId,
        channel: IPC.chatRewind,
        userMessageIndex: req.userMessageIndex,
        restoredFiles: prepared.writes.restored.length
      })

      return ok({
        messages: prepared.messages,
        restored: prepared.writes.restored,
        skipped: prepared.writes.skipped
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/userMessageIndex|run not found/i.test(msg)) {
        return failExpected(msg, IPC.chatRewind)
      }
      return failFrom(err, IPC.chatRewind)
    }
  })

  ipcMain.handle(IPC.toolApprovalResponse, async (event, raw): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const response = ToolApprovalResponseSchema.parse(raw)
      if (!isActive(response.runId)) return fail('Run is not active')
      const workspace = getRunWorkspace(response.runId)
      if (!workspace || !isOpenWorkspace(workspace)) return fail('Workspace is not open')
      return ok(resolveToolApproval(response))
    } catch (err) {
      return failFrom(err, IPC.toolApprovalResponse)
    }
  })

  ipcMain.handle(
    IPC.toolApprovalListPending,
    async (event, raw): Promise<IpcResult<ToolApprovalRequest[]>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const { runId } = ListPendingToolApprovalsRequestSchema.parse(raw)
        const workspace = getRunWorkspace(runId)
        if (!workspace || !isOpenWorkspace(workspace)) return fail('Workspace is not open')
        return ok(listPendingToolApprovals(runId))
      } catch (err) {
        return failFrom(err, IPC.toolApprovalListPending)
      }
    }
  )

  ipcMain.handle(IPC.agentQuestionResponse, async (event, raw): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const response = AgentQuestionResponseSchema.parse(raw)
      if (!isActive(response.runId)) return fail('Run is not active')
      const workspace = getRunWorkspace(response.runId)
      if (!workspace || !isOpenWorkspace(workspace)) return fail('Workspace is not open')
      return ok(resolveAgentQuestion(response))
    } catch (err) {
      return failFrom(err, IPC.agentQuestionResponse)
    }
  })

  ipcMain.handle(IPC.agentQuestionReject, async (event, raw): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const payload = AgentQuestionRejectSchema.parse(raw)
      const runId =
        payload.runId ??
        (payload.requestId ? pendingQuestionRunId(payload.requestId) : undefined)
      if (!runId) return fail('No pending agent question for reject')
      if (!isActive(runId)) return fail('Run is not active')
      const workspace = getRunWorkspace(runId)
      if (!workspace || !isOpenWorkspace(workspace)) return fail('Workspace is not open')
      return ok(rejectAgentQuestion({ ...payload, runId }))
    } catch (err) {
      return failFrom(err, IPC.agentQuestionReject)
    }
  })

  ipcMain.handle(
    IPC.agentQuestionListPending,
    async (event, raw): Promise<IpcResult<AgentQuestionRequest[]>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const { runId } = ListPendingAgentQuestionsRequestSchema.parse(raw)
        const workspace = getRunWorkspace(runId)
        if (!workspace || !isOpenWorkspace(workspace)) return fail('Workspace is not open')
        return ok(listPendingAgentQuestions(runId))
      } catch (err) {
        return failFrom(err, IPC.agentQuestionListPending)
      }
    }
  )

  ipcMain.handle(
    IPC.composerAttachmentsGet,
    async (event, raw): Promise<IpcResult<ComposerAttachmentsGetResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = ComposerAttachmentsGetRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        return ok({ buckets: await listComposerAttachmentsForWorkspace(req.workspacePath) })
      } catch (err) {
        return failFrom(err, IPC.composerAttachmentsGet)
      }
    }
  )

  ipcMain.handle(IPC.composerAttachmentsSet, async (event, raw): Promise<IpcResult<true>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = ComposerAttachmentsSetRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      await setComposerAttachmentsForWorkspace(req.workspacePath, req.buckets)
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.composerAttachmentsSet)
    }
  })

  ipcMain.handle(IPC.composerAttachmentsClear, async (event, raw): Promise<IpcResult<true>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = ComposerAttachmentsClearRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      await clearComposerAttachmentsForWorkspace(req.workspacePath, req.key)
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.composerAttachmentsClear)
    }
  })

  ipcMain.handle(
    IPC.attachmentExtract,
    async (event, raw): Promise<IpcResult<ExtractAttachmentResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = ExtractAttachmentRequestSchema.parse(raw)
        return ok(await extractAttachment(req))
      } catch (err) {
        return failFrom(err, IPC.attachmentExtract)
      }
    }
  )

  ipcMain.handle(
    IPC.dictationTranscribe,
    async (event, raw): Promise<IpcResult<DictationTranscribeResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      let requestId: string | undefined
      let controller: AbortController | undefined
      try {
        const req = DictationTranscribeRequestSchema.parse(raw)
        requestId = req.requestId
        if (requestId) {
          dictationTranscriptions.get(requestId)?.abort()
          controller = new AbortController()
          dictationTranscriptions.set(requestId, controller)
        }
        return ok(await transcribeDictation(req, controller?.signal))
      } catch (err) {
        return failFrom(err, IPC.dictationTranscribe)
      } finally {
        if (requestId && dictationTranscriptions.get(requestId) === controller) {
          dictationTranscriptions.delete(requestId)
        }
      }
    }
  )

  ipcMain.handle(IPC.dictationCancel, async (event, raw): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { requestId } = DictationCancelRequestSchema.parse(raw)
      const controller = dictationTranscriptions.get(requestId)
      controller?.abort()
      return ok(Boolean(controller))
    } catch (err) {
      return failFrom(err, IPC.dictationCancel)
    }
  })

  ipcMain.handle(IPC.dictationStatus, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { readDictationRuntimeStatus } = await import('@main/dictation')
      return ok(readDictationRuntimeStatus())
    } catch (err) {
      return failFrom(err, IPC.dictationStatus)
    }
  })

  ipcMain.handle(IPC.dictationInstall, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = DictationInstallRequestSchema.parse(raw)
      const { installDictationModel } = await import('@main/dictation')
      return ok(await installDictationModel(req.modelId))
    } catch (err) {
      return failFrom(err, IPC.dictationInstall)
    }
  })

  ipcMain.handle(IPC.dictationUnload, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { unloadDictationModel } = await import('@main/dictation')
      return ok(await unloadDictationModel())
    } catch (err) {
      return failFrom(err, IPC.dictationUnload)
    }
  })

  ipcMain.handle(IPC.dictationDeleteCache, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = DictationDeleteCacheRequestSchema.parse(raw)
      const { deleteDictationModelCache } = await import('@main/dictation')
      return ok(await deleteDictationModelCache(req.modelId))
    } catch (err) {
      return failFrom(err, IPC.dictationDeleteCache)
    }
  })

  ipcMain.handle(IPC.chatCancel, async (event, raw): Promise<IpcResult<true>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { runId } = CancelRunRequestSchema.parse(raw)
      const workspace = getRunWorkspace(runId)
      if (!workspace || !isOpenWorkspace(workspace)) return fail('Run not found')
      logger.info('Chat cancel', { scope: 'ipc', correlationId: runId })
      // Stopping a run is independent of the goal: it must not pause the goal
      // or disarm the loop. Pause/Stop-loop are explicit, separate actions.
      const result = chatCancelResult(runId)
      if (result.ok && workspace) {
        clearFollowUpsOnDisk(resolveRunDir(workspace, runId))
      }
      return result
    } catch (err) {
      return failFrom(err, IPC.chatCancel)
    }
  })

  ipcMain.handle(IPC.chatUiSubscribe, async (event, raw): Promise<IpcResult<true>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = ChatUiSubscribeRequestSchema.parse(raw)
      setChatEventUiSubscriptions(req.runIds)
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.chatUiSubscribe)
    }
  })

  ipcMain.handle(IPC.chatUiSubscribeAdd, async (event, raw): Promise<IpcResult<true>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = ChatUiSubscribeAddRequestSchema.parse(raw)
      addChatEventUiSubscription(req.runId)
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.chatUiSubscribeAdd)
    }
  })

  ipcMain.handle(
    IPC.chatFollowUp,
    async (event, raw): Promise<IpcResult<ChatFollowUpResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = ChatFollowUpRequestSchema.parse(raw)
        if (!isActive(req.runId)) {
          return fail('Run is not active')
        }
        const workspace = getRunWorkspace(req.runId)
        if (!workspace || !isOpenWorkspace(workspace)) {
          return fail('Workspace is not open')
        }
        const result = enqueueFollowUp(req.runId, req.message)
        if (!result.ok) {
          if (result.error === 'Run is finishing') {
            await waitUntilRunInactive(req.runId)
            return fail('Run ended — send your message to continue.')
          }
          return fail(result.error)
        }
        syncFollowUpsToDisk(resolveRunDir(workspace, req.runId), req.runId)
        if (req.mode) {
          setPendingMode(req.runId, req.mode)
        }
        logger.info('Chat follow-up queued', {
          scope: 'ipc',
          correlationId: req.runId,
          channel: IPC.chatFollowUp,
          queueLength: result.queueLength
        })
        // Notify the renderer so queue chrome stays in sync across optimistic UI.
        // Flush pending stream deltas first so follow_up_queued is not reordered
        // ahead of text already batched for this run. Match stream/approval routing
        // via sendToCurrentRenderer (not event.sender alone).
        getChatEventDispatcher().flush(req.runId)
        const invokeId = getRunInvokeId(req.runId)
        sendToCurrentRenderer(
          IPC.chatEvent,
          {
            type: 'follow_up_queued',
            runId: req.runId,
            id: result.id,
            position: result.position,
            queueLength: result.queueLength,
            preview: followUpPreview(req.message),
            ...(invokeId != null ? { invokeId } : {})
          } satisfies AgentEvent,
          event.sender
        )
        return ok({
          id: result.id,
          position: result.position,
          queueLength: result.queueLength
        })
      } catch (err) {
        return failFrom(err, IPC.chatFollowUp)
      }
    }
  )

  ipcMain.handle(
    IPC.chatQueueMode,
    async (event, raw): Promise<IpcResult<ChatQueueModeResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = ChatQueueModeRequestSchema.parse(raw)
        if (!isActive(req.runId)) {
          return fail('Run is not active')
        }
        const workspace = getRunWorkspace(req.runId)
        if (!workspace || !isOpenWorkspace(workspace)) {
          return fail('Workspace is not open')
        }
        setPendingMode(req.runId, req.mode)
        return ok({ queued: true as const })
      } catch (err) {
        return failFrom(err, IPC.chatQueueMode)
      }
    }
  )

  ipcMain.handle(
    IPC.chatFollowUpRemove,
    async (event, raw): Promise<IpcResult<ChatFollowUpRemoveResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = ChatFollowUpRemoveRequestSchema.parse(raw)
        if (!isActive(req.runId)) {
          return fail('Run is not active')
        }
        const workspace = getRunWorkspace(req.runId)
        if (!workspace || !isOpenWorkspace(workspace)) {
          return fail('Workspace is not open')
        }
        const result = removeFollowUp(req.runId, req.id)
        if (!result.ok) return fail(result.error)
        syncFollowUpsToDisk(resolveRunDir(workspace, req.runId), req.runId)
        return ok({ removed: result.removed, queueLength: result.queueLength })
      } catch (err) {
        return failFrom(err, IPC.chatFollowUpRemove)
      }
    }
  )

  ipcMain.handle(
    IPC.chatFollowUpUpdate,
    async (event, raw): Promise<IpcResult<ChatFollowUpUpdateResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = ChatFollowUpUpdateRequestSchema.parse(raw)
        if (!isActive(req.runId)) {
          return fail('Run is not active')
        }
        const workspace = getRunWorkspace(req.runId)
        if (!workspace || !isOpenWorkspace(workspace)) {
          return fail('Workspace is not open')
        }
        const result = updateFollowUp(req.runId, req.id, req.message)
        if (!result.ok) return fail(result.error)
        syncFollowUpsToDisk(resolveRunDir(workspace, req.runId), req.runId)
        return ok({ preview: result.preview, queueLength: peekFollowUps(req.runId).length })
      } catch (err) {
        return failFrom(err, IPC.chatFollowUpUpdate)
      }
    }
  )

  ipcMain.handle(
    IPC.chatFollowUpPromote,
    async (event, raw): Promise<IpcResult<ChatFollowUpPromoteResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = ChatFollowUpPromoteRequestSchema.parse(raw)
        if (!isActive(req.runId)) {
          return fail('Run is not active')
        }
        const workspace = getRunWorkspace(req.runId)
        if (!workspace || !isOpenWorkspace(workspace)) {
          return fail('Workspace is not open')
        }
        const result = promoteFollowUp(req.runId, req.id)
        if (!result.ok) return fail(result.error)
        syncFollowUpsToDisk(resolveRunDir(workspace, req.runId), req.runId)
        return ok({ queueLength: result.queueLength })
      } catch (err) {
        return failFrom(err, IPC.chatFollowUpPromote)
      }
    }
  )

  ipcMain.handle(IPC.chatCompact, async (event, raw): Promise<IpcResult<CompactRunResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = CompactRunRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      if (isActive(req.runId)) {
        return fail('Stop the run before compacting its history.')
      }
      logger.info('Manual compaction requested', {
        scope: 'ipc',
        correlationId: req.runId,
        channel: IPC.chatCompact
      })
      return ok(
        await compactRunNow({
          ...req,
          onEvent: (ev) => sendToCurrentRenderer(IPC.chatEvent, ev, event.sender)
        })
      )
    } catch (err) {
      if (err instanceof CompactionUnavailableError) return fail(err.message)
      if (err instanceof CompactionVerifyFailedError) {
        return fail(err.message, 'COMPACTION_VERIFY')
      }
      return failFrom(err, IPC.chatCompact)
    }
  })

  ipcMain.handle(
    IPC.chatRewindPreview,
    async (event, raw): Promise<IpcResult<ChatRewindPreviewResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = ChatRewindRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) {
          return failExpected('Workspace is not open', IPC.chatRewindPreview, req.runId)
        }
        if (!existsSync(req.workspacePath)) {
          return failExpected('Workspace path does not exist', IPC.chatRewindPreview, req.runId)
        }
        if (!runExists(req.workspacePath, req.runId)) {
          return failExpected('Run not found', IPC.chatRewindPreview, req.runId)
        }
        if (isActive(req.runId)) {
          return failExpected('Stop the run before reverting.', IPC.chatRewindPreview, req.runId)
        }
        const runDir = resolveRunDir(req.workspacePath, req.runId)
        return ok(planRewindWrites(runDir, req.userMessageIndex))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/userMessageIndex|run not found/i.test(msg)) {
          return failExpected(msg, IPC.chatRewindPreview)
        }
        return failFrom(err, IPC.chatRewindPreview)
      }
    }
  )

  ipcMain.handle(
    IPC.runsResolveWrites,
    async (event, raw): Promise<IpcResult<ResolveWritesResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = ResolveWritesRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        if (isActive(req.runId)) {
          return fail('Stop the run before resolving agent writes.')
        }
        const runDir = resolveRunDir(req.workspacePath, req.runId)
        const result = resolveWrites(runDir, req.workspacePath, {
          checkpointId: req.checkpointId,
          action: req.action,
          paths: req.paths
        })
        persistWriteCheckpointEvent(runDir, req.runId, result.checkpointId)
        if (result.discarded.length > 0) {
          invalidateGitStatusCache(req.workspacePath)
        }
        logger.info('Resolved agent writes', {
          scope: 'ipc',
          correlationId: req.runId,
          channel: IPC.runsResolveWrites,
          checkpointId: result.checkpointId,
          action: req.action,
          kept: result.kept.length,
          discarded: result.discarded.length
        })
        return ok(result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/already resolved|checkpoint not found|invalid checkpoint/i.test(msg)) {
          return failExpected(msg, IPC.runsResolveWrites)
        }
        return failFrom(err, IPC.runsResolveWrites)
      }
    }
  )

  ipcMain.handle(
    IPC.runsReadArtifact,
    async (event, raw): Promise<IpcResult<ReadRunArtifactResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = ReadRunArtifactRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        if (!runExists(req.workspacePath, req.runId)) return fail('Run not found')
        const runDir = resolveRunDir(req.workspacePath, req.runId)
        const filePath = join(runDir, req.name)
        if (!existsSync(filePath)) {
          return ok({ name: req.name, exists: false, content: null })
        }
        if (/^browser\/snapshot(?:-[\w.-]+)?\.jpg$/.test(req.name)) {
          const jpeg = readFileSync(filePath)
          return ok({
            name: req.name,
            exists: true,
            content: `data:image/jpeg;base64,${jpeg.toString('base64')}`
          })
        }
        const content = readFileSync(filePath, 'utf8')
        return ok({ name: req.name, exists: true, content })
      } catch (err) {
        return failFrom(err, IPC.runsReadArtifact)
      }
    }
  )

  ipcMain.handle(
    IPC.runStats,
    async (event, raw): Promise<IpcResult<RunStatsResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = RunStatsRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        const stats = await collectRunStats(
          workspaceSessionsRoot(req.workspacePath),
          req.runIds
        )
        return ok({ stats })
      } catch (err) {
        return failFrom(err, IPC.runStats)
      }
    }
  )

  ipcMain.handle(
    IPC.harnessReview,
    async (event, raw): Promise<IpcResult<HarnessReviewResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = HarnessReviewRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        return ok(
          await runHarnessReviewWithSettings(req.workspacePath, { limit: req.limit })
        )
      } catch (err) {
        return failFrom(err, IPC.harnessReview)
      }
    }
  )

  ipcMain.handle(
    IPC.harnessPreviewApply,
    async (event, raw): Promise<IpcResult<HarnessPreviewApplyResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = HarnessPreviewApplyRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        if (!workspaceHasEditableHarness(req.workspacePath)) {
          return fail(
            `This workspace has no editable harness at ${WORKSPACE_HARNESS_REL}. Open the Agent V repo (or a fork) to apply harness changes.`
          )
        }
        return ok(previewHarnessApply(req.workspacePath, req.proposalPath))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (
          /no harness proposal found|missing a ## Proposed harness body|no editable harness/i.test(
            msg
          )
        ) {
          return fail(msg)
        }
        return failFrom(err, IPC.harnessPreviewApply)
      }
    }
  )

  ipcMain.handle(
    IPC.harnessApply,
    async (event, raw): Promise<IpcResult<HarnessApplyResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = HarnessApplyRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        if (!workspaceHasEditableHarness(req.workspacePath)) {
          return fail(
            `This workspace has no editable harness at ${WORKSPACE_HARNESS_REL}. Open the Agent V repo (or a fork) to apply harness changes.`
          )
        }
        return ok(
          await applyHarnessProposal(req.workspacePath, {
            proposalPath: req.proposalPath,
            confirm: req.confirm
          })
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (
          /no harness proposal found|missing a ## Proposed harness body|requires confirm|no editable harness/i.test(
            msg
          )
        ) {
          return fail(msg)
        }
        return failFrom(err, IPC.harnessApply)
      }
    }
  )

  ipcMain.handle(IPC.listRuns, async (event, raw): Promise<IpcResult<ListRunsResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const body = (raw ?? {}) as { workspacePath?: string }
      const workspacePath = body.workspacePath?.trim() ?? ''
      if (!workspacePath) {
        return ok({ runs: [], instanceRuns: [], capped: false })
      }
      const req = ListRunsRequestSchema.parse({ workspacePath })
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await listRuns(req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.listRuns)
    }
  })

  ipcMain.handle(
    IPC.listOlderRuns,
    async (event, raw): Promise<IpcResult<ListOlderRunsResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = ListOlderRunsRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        return ok(await listRunsOlder(req.workspacePath, req.olderThan, req.limit))
      } catch (err) {
        return failFrom(err, IPC.listOlderRuns)
      }
    }
  )

  ipcMain.handle(
    IPC.loadRun,
    async (event, raw): Promise<IpcResult<LoadRunResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = LoadRunRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        const runDir = resolveRunDir(req.workspacePath, req.runId)
        const messages = await loadMessagesAsync(req.workspacePath, req.runId)
        const status = loadStatus(runDir)
        return ok({
          runId: req.runId,
          messages: messages.map(toolMessageForIpc),
          pendingFollowUps: loadFollowUpPreviews(runDir),
          ...(status
            ? {
                status: status.status,
                ...(status.resumable ? { resumable: true as const } : {}),
                ...(status.error ? { error: status.error } : {})
              }
            : {})
        })
      } catch (err) {
        return failFrom(err, IPC.loadRun)
      }
    }
  )

  ipcMain.handle(
    IPC.loadRunEvents,
    async (event, raw): Promise<IpcResult<PersistedEvent[]>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = LoadRunEventsRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        return ok(
          await loadEventsForRunAsync(req.workspacePath, req.runId, {
            limit: LOAD_EVENTS_UI_LIMIT
          })
        )
      } catch (err) {
        return failFrom(err, IPC.loadRunEvents)
      }
    }
  )

  ipcMain.handle(IPC.loadToolResult, async (event, raw): Promise<IpcResult<{ content: string }>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = LoadToolResultRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const content = await loadToolResultContent(
        req.workspacePath,
        req.runId,
        req.toolCallId
      )
      if (content == null) return fail('Tool result not found')
      return ok({ content })
    } catch (err) {
      return failFrom(err, IPC.loadToolResult)
    }
  })

  ipcMain.handle(IPC.runsDelete, async (event, raw): Promise<IpcResult<true>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = DeleteRunRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const result = await deleteRun(req.workspacePath, req.runId)
      if (!result.ok) return fail(result.error)
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.runsDelete)
    }
  })

  ipcMain.handle(
    IPC.runsExport,
    async (event, raw): Promise<IpcResult<ExportRunResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = ExportRunRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        if (!runExists(req.workspacePath, req.runId)) return fail('Run not found')
        const { title, markdown } = await buildRunMarkdownExport(req.workspacePath, req.runId)
        const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
        // File-name sanitization: strip path/hostile chars, cap length.
        const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || req.runId
        const options: Electron.SaveDialogOptions = {
          title: 'Export chat as Markdown',
          defaultPath: `${safeTitle}.md`,
          filters: [{ name: 'Markdown', extensions: ['md'] }]
        }
        const dialogResult = parent
          ? await dialog.showSaveDialog(parent, options)
          : await dialog.showSaveDialog(options)
        if (dialogResult.canceled || !dialogResult.filePath) {
          return ok({ saved: false })
        }
        await writeFile(dialogResult.filePath, markdown, 'utf8')
        return ok({ saved: true, path: dialogResult.filePath })
      } catch (err) {
        return failFrom(err, IPC.runsExport)
      }
    }
  )

  ipcMain.handle(
    IPC.runsRename,
    async (event, raw): Promise<IpcResult<RunSummary>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = RenameRunRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        return ok(await renameRun(req.workspacePath, req.runId, req.goal))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Same user-state class as runsDelete result.error (active / missing / corrupt).
        if (/cancel run first|run not found|invalid run status/i.test(msg)) {
          return failExpected(msg, IPC.runsRename)
        }
        return failFrom(err, IPC.runsRename)
      }
    }
  )

  ipcMain.handle(
    IPC.runsSetGoalStatus,
    async (event, raw): Promise<IpcResult<{ goal: import('../../shared/ipc').RunGoal | null }>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = SetGoalStatusRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        if (!runExists(req.workspacePath, req.runId)) return fail('Run not found')
        const runDir = resolveRunDir(req.workspacePath, req.runId)
        if (loadStatus(runDir)?.inlineInstance) {
          return fail('Goals are only available on the root chat.')
        }
        const wc = event.sender
        if (req.action === 'pause') {
          const current = readGoal(runDir)
          if (!current) return fail('No goal on this run.')
          if (current.status === 'complete') return fail('Goal is already complete.')
          const goal = pauseGoalIfActive(runDir)
          // Emit only on a real active→paused transition; re-pausing is silent.
          if (goal?.status === 'paused' && current.status === 'active') {
            emitGoalUpdate({
              workspacePath: req.workspacePath,
              runId: req.runId,
              runDir,
              goal,
              notice: 'Goal paused',
              wc
            })
          }
          return ok({ goal })
        }
        if (req.action === 'resume') {
          const goal = updateGoalStatus(runDir, 'active')
          emitGoalUpdate({
            workspacePath: req.workspacePath,
            runId: req.runId,
            runDir,
            goal,
            wc
          })
          const loop = readLoop(runDir)
          // Don't spawn a one-off run when a loop is already armed to continue;
          // doing both would launch overlapping runs toward the same goal.
          if (!isActive(req.runId) && (!loop || loop.status !== 'armed')) {
            const launched = launchRunFollowUpOrStart({
              workspacePath: req.workspacePath,
              runId: req.runId,
              mode: 'agent',
              wc,
              message: {
                role: 'user',
                content: formatGoalContinueMessage(goal.objective),
                synthetic: true
              }
            })
            if (!launched.ok) return fail(launched.error)
          }
          return ok({ goal })
        }
        // Complete (updateGoalStatus is idempotent for an already-complete goal).
        const prior = readGoal(runDir)
        const goal = updateGoalStatus(runDir, 'complete')
        // Emit only on a real transition; a repeat Mark-complete stays silent.
        if (prior?.status !== 'complete') {
          emitGoalUpdate({
            workspacePath: req.workspacePath,
            runId: req.runId,
            runDir,
            goal,
            wc
          })
        }
        return ok({ goal })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/no goal|cannot resume|requires objective/i.test(msg)) return fail(msg)
        return failFrom(err, IPC.runsSetGoalStatus)
      }
    }
  )

  ipcMain.handle(
    IPC.runsSetLoop,
    async (event, raw): Promise<IpcResult<{ loop: import('../../shared/ipc').RunLoop | null }>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = SetLoopRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        if (!runExists(req.workspacePath, req.runId)) return fail('Run not found')
        const runDir = resolveRunDir(req.workspacePath, req.runId)
        if (loadStatus(runDir)?.inlineInstance) {
          return fail('Loops are only available on the root chat.')
        }
        const wc = event.sender
        if (req.action === 'stop') {
          const loop = disarmLoop(runDir, req.runId, {
            workspacePath: req.workspacePath,
            wc
          })
          return ok({ loop })
        }
        const loop = armLoop({
          workspacePath: req.workspacePath,
          runId: req.runId,
          runDir,
          prompt: req.prompt ?? '',
          intervalMs: req.intervalMs ?? 0,
          wc
        })
        return ok({ loop })
      } catch (err) {
        return failFrom(err, IPC.runsSetLoop)
      }
    }
  )

  ipcMain.handle(IPC.runsActive, async (event): Promise<IpcResult<ActiveRunsResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(listActiveRuns())
    } catch (err) {
      return failFrom(err, IPC.runsActive)
    }
  })

  ipcMain.handle(IPC.gitStatus, async (event, raw): Promise<IpcResult<GitStatusResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitStatusRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await readGitStatusCached(req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.gitStatus)
    }
  })

  ipcMain.handle(IPC.gitGenerateCommitMessage, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitGenerateCommitMessageRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await generateCommitMessage(req.workspacePath, req.mode))
    } catch (err) {
      return failFrom(err, IPC.gitGenerateCommitMessage)
    }
  })

  ipcMain.handle(IPC.gitCommit, async (event, raw): Promise<IpcResult<GitCommitResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitCommitRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      try {
        const result = await commitAll(
          req.workspacePath,
          req.message,
          req.push === true,
          req.mode ?? 'all'
        )
        return ok(result)
      } finally {
        invalidateGitStatusCache(req.workspacePath)
      }
    } catch (err) {
      return failFrom(err, IPC.gitCommit)
    }
  })

  ipcMain.handle(IPC.gitStageAll, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitStageAllRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      try {
        const result = await stageAll(req.workspacePath)
        return ok(result)
      } finally {
        invalidateGitStatusCache(req.workspacePath)
      }
    } catch (err) {
      return failFrom(err, IPC.gitStageAll)
    }
  })

  ipcMain.handle(IPC.gitStagePaths, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitStagePathsRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      try {
        const result = await stagePaths(req.workspacePath, req.paths)
        return ok(result)
      } finally {
        invalidateGitStatusCache(req.workspacePath)
      }
    } catch (err) {
      return failFrom(err, IPC.gitStagePaths)
    }
  })

  ipcMain.handle(IPC.gitUnstagePaths, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitUnstagePathsRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      try {
        const result = await unstagePaths(req.workspacePath, req.paths)
        return ok(result)
      } finally {
        invalidateGitStatusCache(req.workspacePath)
      }
    } catch (err) {
      return failFrom(err, IPC.gitUnstagePaths)
    }
  })

  ipcMain.handle(IPC.gitBranches, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitBranchesRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await listLocalBranches(req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.gitBranches)
    }
  })

  ipcMain.handle(IPC.gitCheckout, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitCheckoutRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      try {
        const result = await checkoutBranch(req.workspacePath, req.branch)
        return ok(result)
      } finally {
        invalidateGitStatusCache(req.workspacePath)
      }
    } catch (err) {
      return failFrom(err, IPC.gitCheckout)
    }
  })

  ipcMain.handle(IPC.gitLog, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitLogRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await readGitLog(req.workspacePath, req.limit))
    } catch (err) {
      return failFrom(err, IPC.gitLog)
    }
  })

  ipcMain.handle(IPC.gitCommitFiles, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitCommitFilesRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok({ files: await readGitCommitFiles(req.workspacePath, req.sha) })
    } catch (err) {
      return failFrom(err, IPC.gitCommitFiles)
    }
  })

  ipcMain.handle(IPC.gitDiff, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitDiffRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const result = await readGitDiff(req.workspacePath, {
        path: req.path,
        staged: req.staged,
        ignoreWhitespace: req.ignoreWhitespace,
        sha: req.sha,
        vsHead: req.vsHead
      })
      if (!result.ok) return fail(result.error)
      return ok({ content: result.content })
    } catch (err) {
      return failFrom(err, IPC.gitDiff)
    }
  })

  ipcMain.handle(IPC.gitBlame, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitBlameRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await readGitBlame(req.workspacePath, req.path))
    } catch (err) {
      return failFrom(err, IPC.gitBlame)
    }
  })

  ipcMain.handle(IPC.prView, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrViewRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prView(req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.prView)
    }
  })

  ipcMain.handle(IPC.prCreate, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    let workspacePath: string | null = null
    try {
      const req = PrCreateRequestSchema.parse(raw)
      workspacePath = req.workspacePath
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(
        req.message
          ? await prCreateFromChanges(req.workspacePath, req.message, req.mode, {
              draft: req.draft
            })
          : await prCreate(req.workspacePath, { draft: req.draft })
      )
    } catch (err) {
      return failFrom(err, IPC.prCreate)
    } finally {
      if (workspacePath) invalidateGitStatusCache(workspacePath)
    }
  })

  ipcMain.handle(IPC.prMerge, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrMergeRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prMerge(req.workspacePath, req.method, req.number))
    } catch (err) {
      return failFrom(err, IPC.prMerge)
    }
  })

  ipcMain.handle(IPC.prDiff, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrDiffRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(
        await prDiff(req.workspacePath, {
          path: req.path,
          ignoreWhitespace: req.ignoreWhitespace,
          number: req.number
        })
      )
    } catch (err) {
      return failFrom(err, IPC.prDiff)
    }
  })

  ipcMain.handle(IPC.prClose, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrCloseRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prClose(req.workspacePath, req.number))
    } catch (err) {
      return failFrom(err, IPC.prClose)
    }
  })

  ipcMain.handle(IPC.prEditTitle, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrEditTitleRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await prEditTitle(req.workspacePath, req.title, req.number))
    } catch (err) {
      return failFrom(err, IPC.prEditTitle)
    }
  })

  ipcMain.handle(IPC.githubAuthStatus, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(await githubAuthStatus())
    } catch (err) {
      return failFrom(err, IPC.githubAuthStatus)
    }
  })

  ipcMain.handle(IPC.githubAuthStart, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(await startGithubAuth())
    } catch (err) {
      return failFrom(err, IPC.githubAuthStart)
    }
  })

  ipcMain.handle(IPC.githubAuthCancel, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      cancelGithubAuth()
      return ok(await githubAuthStatus())
    } catch (err) {
      return failFrom(err, IPC.githubAuthCancel)
    }
  })

  ipcMain.handle(IPC.githubAuthLogout, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(await logoutGithubAuth())
    } catch (err) {
      return failFrom(err, IPC.githubAuthLogout)
    }
  })

  ipcMain.handle(IPC.githubCliInstall, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(await installGithubCli())
    } catch (err) {
      return failFrom(err, IPC.githubCliInstall)
    }
  })

  ipcMain.handle(IPC.shellOpenExternal, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = ShellOpenExternalRequestSchema.parse(raw)
      let parsed: URL
      try {
        parsed = new URL(req.url)
      } catch {
        return fail('Invalid URL')
      }
      if (parsed.protocol !== 'https:') {
        return fail('Only https URLs can be opened')
      }
      if (parsed.username || parsed.password) {
        return fail('Invalid URL')
      }
      await shell.openExternal(parsed.toString())
      return ok(true as const)
    } catch (err) {
      return failFrom(err, IPC.shellOpenExternal)
    }
  })

  ipcMain.handle(IPC.ptyCreate, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PtyCreateRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return fail('No window')
      return ok(
        createPtySession({
          cwd: req.workspacePath,
          cols: req.cols,
          rows: req.rows,
          sendTo: win
        })
      )
    } catch (err) {
      return failFrom(err, IPC.ptyCreate)
    }
  })

  ipcMain.handle(IPC.ptyList, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PtyListRequestSchema.parse(raw ?? {})
      if (req.workspacePath && !isOpenWorkspace(req.workspacePath)) {
        return fail('Workspace is not open')
      }
      // Never disclose sessions (cwd paths) of workspaces that are not open.
      return ok(listPtySessions(req.workspacePath, (path) => isOpenWorkspace(path)))
    } catch (err) {
      return failFrom(err, IPC.ptyList)
    }
  })

  ipcMain.handle(IPC.ptyWrite, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PtyWriteRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(writePty(req.id, req.data, req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.ptyWrite)
    }
  })

  ipcMain.handle(IPC.ptyResize, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PtyResizeRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(resizePty(req.id, req.cols, req.rows, req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.ptyResize)
    }
  })

  ipcMain.handle(IPC.ptyKill, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PtyIdRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(killPty(req.id, req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.ptyKill)
    }
  })

  ipcMain.handle(IPC.logsGetPath, async (event): Promise<IpcResult<string>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(logsDirectory())
    } catch (err) {
      return failFrom(err, IPC.logsGetPath)
    }
  })

  ipcMain.handle(IPC.logsOpenDir, async (event): Promise<IpcResult<true>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const dir = logsDirectory()
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const result = await shell.openPath(dir)
      if (result) {
        logger.warn('Failed to open logs directory', {
          scope: 'ipc',
          code: 'IPC_HANDLER',
          channel: IPC.logsOpenDir,
          err: scrubString(result)
        })
        return fail('Could not open the logs folder', 'IPC_HANDLER')
      }
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.logsOpenDir)
    }
  })

  ipcMain.handle(IPC.traceStart, async (event): Promise<IpcResult<TraceStartResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      // Idempotent: the flight recorder is already running; this re-asserts it.
      return ok(await getTraceCapture().ensureRecording())
    } catch (err) {
      return failFrom(err, IPC.traceStart)
    }
  })

  ipcMain.handle(IPC.traceStatus, async (event): Promise<IpcResult<TraceStatusResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(await getTraceCapture().status())
    } catch (err) {
      return failFrom(err, IPC.traceStatus)
    }
  })

  ipcMain.handle(IPC.traceStop, async (event): Promise<IpcResult<TraceStopResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      // Manual dump always forces through and resumes recording — "no trace
      // recording in progress" is structurally impossible now.
      return ok(await getTraceCapture().dumpNow('manual'))
    } catch (err) {
      return failFrom(err, IPC.traceStop)
    }
  })

  ipcMain.handle(
    IPC.crashDiagnosticsGet,
    async (event): Promise<IpcResult<CrashDiagnosticsSnapshot>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        return ok(getCrashDiagnosticsSnapshot())
      } catch (err) {
        return failFrom(err, IPC.crashDiagnosticsGet)
      }
    }
  )

  ipcMain.handle(
    IPC.crashRecoveryConsume,
    async (event): Promise<IpcResult<CrashRecoveryPending | null>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        return ok(consumeRendererRecoveryPending())
      } catch (err) {
        return failFrom(err, IPC.crashRecoveryConsume)
      }
    }
  )

  ipcMain.handle(IPC.notificationsList, async (event): Promise<IpcResult<NotificationList>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(listNotifications())
    } catch (err) {
      return failFrom(err, IPC.notificationsList)
    }
  })

  ipcMain.handle(
    IPC.notificationsMarkRead,
    async (event, raw): Promise<IpcResult<NotificationList>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = NotificationMutateRequestSchema.parse(raw)
        return ok(markNotificationsRead(req))
      } catch (err) {
        return failFrom(err, IPC.notificationsMarkRead)
      }
    }
  )

  ipcMain.handle(
    IPC.notificationsDismiss,
    async (event, raw): Promise<IpcResult<NotificationList>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = NotificationMutateRequestSchema.parse(raw)
        return ok(dismissNotifications(req))
      } catch (err) {
        return failFrom(err, IPC.notificationsDismiss)
      }
    }
  )

  ipcMain.handle(IPC.telemetryStatus, async (event): Promise<IpcResult<TelemetryStatus>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok({
        dsnConfigured: isSentryBuildConfigured(),
        telemetryEnabled: getSettings().telemetryEnabled
      })
    } catch (err) {
      return failFrom(err, IPC.telemetryStatus)
    }
  })

  ipcMain.handle(IPC.accessibilitySupportState, async (event): Promise<IpcResult<{ enabled: boolean }>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    return ok({ enabled: app.accessibilitySupportEnabled })
  })

  ipcMain.handle(IPC.appInfo, async (event): Promise<IpcResult<AppInfo>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const electron = process.versions.electron
      const chrome = process.versions.chrome
      const node = process.versions.node
      if (!electron || !chrome || !node) {
        throw new Error('Runtime versions unavailable')
      }
      return ok({
        name: 'Vyotiq',
        version: app.getVersion(),
        homepage: 'https://vyotiq.com',
        electron,
        chrome,
        node,
        platform: process.platform,
        arch: process.arch,
        osVersion: osRelease()
      })
    } catch (err) {
      return failFrom(err, IPC.appInfo)
    }
  })

  ipcMain.handle(
    IPC.updaterCheck,
    async (event, raw): Promise<IpcResult<UpdateInfo | null>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        UpdaterCheckRequestSchema.parse(raw ?? {})
        return ok(await checkForAppUpdates())
      } catch (err) {
        return failFrom(err, IPC.updaterCheck)
      }
    }
  )

  ipcMain.handle(IPC.updaterDownload, async (event, raw): Promise<IpcResult<undefined>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      UpdaterDownloadRequestSchema.parse(raw ?? {})
      await downloadAppUpdate()
      return ok(undefined)
    } catch (err) {
      return failFrom(err, IPC.updaterDownload)
    }
  })

  ipcMain.handle(IPC.updaterInstall, async (event, raw): Promise<IpcResult<undefined>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      UpdaterInstallRequestSchema.parse(raw ?? {})
      installAppUpdate()
      return ok(undefined)
    } catch (err) {
      return failFrom(err, IPC.updaterInstall)
    }
  })

  ipcMain.handle(
    IPC.feedbackCompose,
    async (event, raw): Promise<IpcResult<FeedbackComposeResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = FeedbackComposeRequestSchema.parse(raw)
        const mailto = await composeFeedback(req)
        return ok({ ok: true, mailto })
      } catch (err) {
        return failFrom(err, IPC.feedbackCompose)
      }
    }
  )

  ipcMain.handle(IPC.workspaceGrep, async (event, raw): Promise<IpcResult<WorkspaceGrepResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceGrepRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(
        await grepWorkspaceHits(req.workspacePath, req.query, {
          include: req.include,
          maxResults: req.maxResults
        })
      )
    } catch (err) {
      return failFrom(err, IPC.workspaceGrep)
    }
  })

  ipcMain.handle(
    IPC.gitConflictFile,
    async (event, raw): Promise<IpcResult<GitConflictFileResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = GitConflictFileRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        return ok(await readConflictFile(req.workspacePath, req.path))
      } catch (err) {
        return failFrom(err, IPC.gitConflictFile)
      }
    }
  )

  ipcMain.handle(IPC.gitResolveConflict, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = GitResolveConflictRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const result = await resolveConflict(req.workspacePath, req.path, req.content)
      invalidateGitStatusCache(req.workspacePath)
      return ok(result)
    } catch (err) {
      return failFrom(err, IPC.gitResolveConflict)
    }
  })

  ipcMain.handle(IPC.prReview, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PrReviewRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(
        await reviewPullRequest(req.workspacePath, req.event, req.body, req.number)
      )
    } catch (err) {
      return failFrom(err, IPC.prReview)
    }
  })

  ipcMain.handle(
    IPC.githubIssuesList,
    async (event, raw): Promise<IpcResult<GithubIssuesListResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = GithubIssuesListRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        return ok(await listGithubIssues(req.workspacePath))
      } catch (err) {
        return failFrom(err, IPC.githubIssuesList)
      }
    }
  )

  ipcMain.handle(
    IPC.githubIssueCreate,
    async (event, raw): Promise<IpcResult<GithubIssueCreateResult>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = GithubIssueCreateRequestSchema.parse(raw)
        if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        return ok(await createGithubIssue(req.workspacePath, req.title, req.body))
      } catch (err) {
        return failFrom(err, IPC.githubIssueCreate)
      }
    }
  )

  ipcMain.handle(IPC.mcpStatus, async (event, raw): Promise<IpcResult<McpStatusResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = McpStatusRequestSchema.parse(raw ?? {})
      const workspaces = getWorkspaces()
      const requestedPath =
        typeof req.workspacePath === 'string' ? req.workspacePath.trim() || null : undefined
      if (requestedPath && !isOpenWorkspace(requestedPath)) {
        return fail('Workspace is not open')
      }
      const workspacePath = requestedPath !== undefined ? requestedPath : workspaces.activePath
      const overrides = workspacePath
        ? findWorkspaceSettingsOverride(workspaces, workspacePath)?.marketplaceOverrides ?? null
        : null
      const servers = resolveEffectiveMcpServers(overrides)
      return ok({ servers: getMcpServerStatus(servers, workspacePath), ...mcpStatusExtras() })
    } catch (err) {
      return failFrom(err, IPC.mcpStatus)
    }
  })

  ipcMain.handle(IPC.mcpRefresh, async (event, raw): Promise<IpcResult<McpStatusResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = McpRefreshRequestSchema.parse(raw ?? {})
      const workspaces = getWorkspaces()
      const requestedPath =
        typeof req.workspacePath === 'string' ? req.workspacePath.trim() || null : undefined
      if (requestedPath && !isOpenWorkspace(requestedPath)) {
        return fail('Workspace is not open')
      }
      const workspacePath = requestedPath !== undefined ? requestedPath : workspaces.activePath
      const overrides = workspacePath
        ? findWorkspaceSettingsOverride(workspaces, workspacePath)?.marketplaceOverrides ?? null
        : null
      await refreshMcpServers(resolveMcpServersForSessionMap())
      return ok({
        servers: getMcpServerStatus(resolveEffectiveMcpServers(overrides), workspacePath),
        ...mcpStatusExtras()
      })
    } catch (err) {
      return failFrom(err, IPC.mcpRefresh)
    }
  })

  ipcMain.handle(IPC.mcpSetAuthToken, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { serverId, token } = McpSetAuthTokenRequestSchema.parse(raw)
      await enqueueSecretsMutation(() => setMcpAuthToken(serverId, token))
      await enqueueSettingsMutation(() => {
        invalidateMcpResolveCache()
        const settings = getSettings()
        const nextServers = (settings.mcpServers ?? []).map((s) =>
          s.id === serverId
            ? { ...s, headers: headersWithoutAuthorization(s.headers) }
            : s
        )
        setSettings({ mcpServers: nextServers })
      })
      await syncMcpServers(resolveMcpServersForSessionMap())
      if (isGithubMcpId(serverId)) {
        try {
          await linkNativeGithubFromMcpToken(token)
        } catch (err) {
          logger.warn('Could not link native GitHub after MCP PAT', {
            scope: 'mcp',
            serverId,
            err
          })
        }
      }
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.mcpSetAuthToken)
    }
  })

  ipcMain.handle(IPC.mcpClearAuthToken, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { serverId } = McpClearAuthTokenRequestSchema.parse(raw)
      await enqueueSecretsMutation(() => {
        clearMcpAuthToken(serverId)
        clearMcpOAuthState(serverId)
      })
      await enqueueSettingsMutation(() => {
        invalidateMcpResolveCache()
        const settings = getSettings()
        const nextServers = (settings.mcpServers ?? []).map((s) =>
          s.id === serverId
            ? { ...s, headers: headersWithoutAuthorization(s.headers) }
            : s
        )
        setSettings({ mcpServers: nextServers })
      })
      await syncMcpServers(resolveMcpServersForSessionMap())
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.mcpClearAuthToken)
    }
  })

  ipcMain.handle(IPC.mcpSetOAuthClientSecret, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { serverId, secret } = McpSetOAuthClientSecretRequestSchema.parse(raw)
      await enqueueSecretsMutation(() => {
        setMcpOAuthClientSecret(serverId, secret)
        clearMcpOAuthState(serverId)
      })
      invalidateMcpResolveCache()
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.mcpSetOAuthClientSecret)
    }
  })

  ipcMain.handle(IPC.mcpClearOAuthClientSecret, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { serverId } = McpClearOAuthClientSecretRequestSchema.parse(raw)
      await enqueueSecretsMutation(() => {
        clearMcpOAuthClientSecret(serverId)
        clearMcpOAuthState(serverId)
      })
      invalidateMcpResolveCache()
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.mcpClearOAuthClientSecret)
    }
  })

  ipcMain.handle(IPC.mcpSetGoogleClientSecret, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { secret } = McpSetGoogleClientSecretRequestSchema.parse(raw)
      await enqueueSecretsMutation(() => {
        setGoogleMcpClientSecret(secret)
        const settings = getSettings()
        for (const server of settings.mcpServers ?? []) {
          if (isGoogleMcpId(server.id)) clearMcpOAuthState(server.id)
        }
      })
      invalidateMcpResolveCache()
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.mcpSetGoogleClientSecret)
    }
  })

  ipcMain.handle(IPC.mcpClearGoogleClientSecret, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      McpClearGoogleClientSecretRequestSchema.parse(raw ?? {})
      await enqueueSecretsMutation(() => {
        clearGoogleMcpClientSecret()
        const settings = getSettings()
        for (const server of settings.mcpServers ?? []) {
          if (isGoogleMcpId(server.id)) clearMcpOAuthState(server.id)
        }
      })
      invalidateMcpResolveCache()
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.mcpClearGoogleClientSecret)
    }
  })

  ipcMain.handle(IPC.mcpStartOAuth, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const parsed = McpStartOAuthRequestSchema.parse(raw)
      await startMcpOAuth(parsed.serverId, {
        authScope: parsed.authScope,
        workspacePath: parsed.workspacePath,
        googleAccess: parsed.googleAccess
      })
      invalidateMcpResolveCache()
      await syncMcpServers(resolveMcpServersForSessionMap())
      return ok({
        servers: getMcpServerStatus(resolveEffectiveMcpServers()),
        ...mcpStatusExtras()
      })
    } catch (err) {
      return failFrom(err, IPC.mcpStartOAuth)
    }
  })

  ipcMain.handle(IPC.marketplaceListInstalled, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(readMarketplaceIndex())
    } catch (err) {
      return failFrom(err, IPC.marketplaceListInstalled)
    }
  })

  ipcMain.handle(IPC.marketplaceBrowse, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = MarketplaceBrowseRequestSchema.parse(raw ?? {})
      const packages = await browseCatalog(req)
      return ok({ packages })
    } catch (err) {
      return failFrom(err, IPC.marketplaceBrowse)
    }
  })

  ipcMain.handle(IPC.marketplaceRefreshCatalog, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const remote = await refreshRemoteCatalog()
      const packages = await browseCatalog()
      return ok({ packages, remoteCount: remote.packages.length })
    } catch (err) {
      return failFrom(err, IPC.marketplaceRefreshCatalog)
    }
  })

  ipcMain.handle(IPC.marketplaceInstall, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = MarketplaceInstallRequestSchema.parse(raw)
      const result = await installMarketplacePackage(req)
      invalidateMcpResolveCache()
      await syncMcpServers(resolveMcpServersForSessionMap())
      return ok(result)
    } catch (err) {
      return failFrom(err, IPC.marketplaceInstall)
    }
  })

  ipcMain.handle(IPC.marketplaceDetectMcp, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = McpDetectRequestSchema.parse(raw)
      const result = await detectMcpInput(req)
      return ok(result)
    } catch (err) {
      return failFrom(err, IPC.marketplaceDetectMcp)
    }
  })

  ipcMain.handle(IPC.marketplaceApplyDetectedMcp, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = McpApplyDetectedRequestSchema.parse(raw)
      if (req.install) {
        const result = await installMarketplacePackage(req.install)
        invalidateMcpResolveCache()
        await syncMcpServers(resolveMcpServersForSessionMap())
        return ok({
          applied: 'marketplace' as const,
          serverId: result.item.id,
          installResult: result
        })
      }
      const applied = applyDetectedManualMcp(req)
      invalidateMcpResolveCache()
      await syncMcpServers(resolveMcpServersForSessionMap())
      return ok(applied)
    } catch (err) {
      return failFrom(err, IPC.marketplaceApplyDetectedMcp)
    }
  })

  ipcMain.handle(IPC.marketplaceScanExternalMcp, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = McpScanExternalRequestSchema.parse(raw ?? {})
      return ok(scanExternalMcpConfigs(req))
    } catch (err) {
      return failFrom(err, IPC.marketplaceScanExternalMcp)
    }
  })

  ipcMain.handle(IPC.marketplaceImportExternalMcp, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = McpImportExternalRequestSchema.parse(raw)
      const result = await importExternalMcpServers(req)
      invalidateMcpResolveCache()
      await syncMcpServers(resolveMcpServersForSessionMap())
      return ok(result)
    } catch (err) {
      return failFrom(err, IPC.marketplaceImportExternalMcp)
    }
  })

  ipcMain.handle(IPC.marketplaceUninstall, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { id, signOutGithub } = MarketplaceUninstallRequestSchema.parse(raw)
      const index = removeInstalledItem(id)
      await syncMarketplaceMcpIntoSettings()
      invalidateMcpResolveCache()
      await syncMcpServers(resolveMcpServersForSessionMap())
      if (signOutGithub && isGithubMcpId(id)) {
        try {
          await logoutGithubAuth()
        } catch (err) {
          logger.warn('GitHub logout after MCP uninstall failed', { scope: 'marketplace', id, err })
        }
      }
      return ok(index)
    } catch (err) {
      return failFrom(err, IPC.marketplaceUninstall)
    }
  })

  ipcMain.handle(IPC.marketplaceSetEnabled, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { id, enabled } = MarketplaceSetEnabledRequestSchema.parse(raw)
      const index = setInstalledEnabled(id, enabled)
      invalidateMcpResolveCache()
      const item = index.items.find((i) => i.id === id)
      if (item?.kind === 'mcp' || item?.kind === 'plugin') {
        if (item.kind === 'mcp') await syncMarketplaceMcpIntoSettings()
        await syncMcpServers(resolveMcpServersForSessionMap())
      }
      return ok(index)
    } catch (err) {
      return failFrom(err, IPC.marketplaceSetEnabled)
    }
  })

  ipcMain.handle(IPC.marketplacePickLocal, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions = {
        title: 'Add marketplace package',
        properties: ['openFile', 'openDirectory'],
        filters: [
          { name: 'Packages', extensions: ['zip', 'tgz', 'json', 'md'] },
          { name: 'All', extensions: ['*'] }
        ]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return ok(null)
      return ok(result.filePaths[0])
    } catch (err) {
      return failFrom(err, IPC.marketplacePickLocal)
    }
  })

  ipcMain.handle(IPC.appearancePickCustomCss, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions = {
        title: 'Choose custom CSS file',
        properties: ['openFile'],
        filters: [{ name: 'CSS', extensions: ['css'] }, { name: 'All', extensions: ['*'] }]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return ok(null)
      return ok(result.filePaths[0])
    } catch (err) {
      return failFrom(err, IPC.appearancePickCustomCss)
    }
  })

  ipcMain.handle(IPC.appearanceReadCustomCss, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const read = readCustomCssForSettings()
      if (!read.ok) return fail(read.error)
      return ok({ css: read.css })
    } catch (err) {
      return failFrom(err, IPC.appearanceReadCustomCss)
    }
  })

  ipcMain.handle(IPC.marketplaceGetContents, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = MarketplaceGetContentsRequestSchema.parse(raw)
      const contents = getPackageContents(req.id)
      if (!contents) return fail('Package not found')
      return ok(contents)
    } catch (err) {
      return failFrom(err, IPC.marketplaceGetContents)
    }
  })

  ipcMain.handle(IPC.marketplaceAckRemoteInstall, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = MarketplaceRemoteInstallAckRequestSchema.parse(raw ?? { acked: true })
      if (req.acked) {
        const win = BrowserWindow.fromWebContents(event.sender)
        const message =
          'Marketplace packages (remote catalogs, git/npm/zip, local path folders) and MCP endpoints are unsigned. Install only from sources you trust.'
        const result = win
          ? await dialog.showMessageBox(win, {
              type: 'warning',
              buttons: ['Cancel', 'Continue'],
              defaultId: 1,
              cancelId: 0,
              title: 'Acknowledge marketplace risk',
              message
            })
          : await dialog.showMessageBox({
              type: 'warning',
              buttons: ['Cancel', 'Continue'],
              defaultId: 1,
              cancelId: 0,
              title: 'Acknowledge marketplace risk',
              message
            })
        if (result.response !== 1) {
          return ok(redactSettingsForIpc(getSettings()))
        }
      }
      const next = await enqueueSettingsMutation(() =>
        setMarketplaceRemoteInstallAcked(req.acked)
      )
      return ok(redactSettingsForIpc(next))
    } catch (err) {
      return failFrom(err, IPC.marketplaceAckRemoteInstall)
    }
  })

  ipcMain.handle(IPC.slashCommandsList, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = SlashCommandsListRequestSchema.parse(raw ?? {})
      const workspacePath = req.workspacePath?.trim() || null
      if (workspacePath && !isOpenWorkspace(workspacePath)) {
        return fail('Workspace is not open')
      }
      const commands = await listSlashCommands(workspacePath)
      return ok({ commands })
    } catch (err) {
      return failFrom(err, IPC.slashCommandsList)
    }
  })

  ipcMain.handle(IPC.slashCommandsResolve, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = SlashCommandsResolveRequestSchema.parse(raw)
      const workspacePath = req.workspacePath?.trim() || null
      if (workspacePath && !isOpenWorkspace(workspacePath)) {
        return fail('Workspace is not open')
      }
      const result = await resolveSlashCommand(req.id, {
        workspacePath,
        trailingText: req.trailingText
      })
      return ok(result)
    } catch (err) {
      return failFrom(err, IPC.slashCommandsResolve)
    }
  })

  ipcMain.handle(IPC.slashCommandsCreateRule, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = SlashCommandsCreateRuleRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) {
        return fail('Workspace is not open')
      }
      const result = await createWorkspaceRule(req.workspacePath, req.title)
      return ok(result)
    } catch (err) {
      return failFrom(err, IPC.slashCommandsCreateRule)
    }
  })

  ipcMain.handle(IPC.slashCommandsCreateSkill, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = SlashCommandsCreateSkillRequestSchema.parse(raw ?? {})
      const scope = req.scope === 'personal' ? 'personal' : 'project'
      const workspacePath = req.workspacePath?.trim() || null
      if (scope === 'project') {
        if (!workspacePath) return fail('Open a workspace to create a project skill')
        if (!isOpenWorkspace(workspacePath)) return fail('Workspace is not open')
      } else if (workspacePath && !isOpenWorkspace(workspacePath)) {
        return fail('Workspace is not open')
      }
      const result = await createWorkspaceSkill(workspacePath, req.title, scope)
      return ok(result)
    } catch (err) {
      return failFrom(err, IPC.slashCommandsCreateSkill)
    }
  })

  ipcMain.handle(IPC.skillsListLocal, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = SkillsListLocalRequestSchema.parse(raw ?? {})
      const workspacePath = req.workspacePath?.trim() || null
      if (workspacePath && !isOpenWorkspace(workspacePath)) {
        return fail('Workspace is not open')
      }
      return ok({ skills: listLocalSkillItems(workspacePath) })
    } catch (err) {
      return failFrom(err, IPC.skillsListLocal)
    }
  })

  ipcMain.handle(IPC.skillsOpenLocal, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = SkillsOpenLocalRequestSchema.parse(raw)
      const workspacePath = req.workspacePath?.trim() || null
      if (workspacePath && !isOpenWorkspace(workspacePath)) {
        return fail('Workspace is not open')
      }
      if (!isAllowedLocalSkillPath(req.skillPath, workspacePath)) {
        return fail('Path is not a local skill file')
      }
      await openSlashFile(req.skillPath)
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.skillsOpenLocal)
    }
  })

  ipcMain.handle(IPC.skillsReadLocal, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = SkillsReadLocalRequestSchema.parse(raw)
      const workspacePath = req.workspacePath?.trim() || null
      if (workspacePath && !isOpenWorkspace(workspacePath)) {
        return fail('Workspace is not open')
      }
      return ok(readLocalSkillFile(req.skillPath, workspacePath))
    } catch (err) {
      return failFrom(err, IPC.skillsReadLocal)
    }
  })

  ipcMain.handle(IPC.skillsWriteLocal, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = SkillsWriteLocalRequestSchema.parse(raw)
      const workspacePath = req.workspacePath?.trim() || null
      if (workspacePath && !isOpenWorkspace(workspacePath)) {
        return fail('Workspace is not open')
      }
      const result = writeLocalSkillFile({
        skillPath: req.skillPath,
        content: req.content,
        workspacePath
      })
      notifySkillsChanged(workspacePath)
      return ok(result)
    } catch (err) {
      return failFrom(err, IPC.skillsWriteLocal)
    }
  })

  ipcMain.handle(IPC.skillsDeleteLocal, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = SkillsDeleteLocalRequestSchema.parse(raw)
      const workspacePath = req.workspacePath?.trim() || null
      if (workspacePath && !isOpenWorkspace(workspacePath)) {
        return fail('Workspace is not open')
      }
      deleteLocalSkillFile(req.skillPath, workspacePath)
      notifySkillsChanged(workspacePath)
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.skillsDeleteLocal)
    }
  })

  ipcMain.handle(IPC.slashCommandsOpenFile, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = SlashCommandsOpenFileRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) {
        return fail('Workspace is not open')
      }
      const root = canonicalizeWorkspacePath(req.workspacePath)
      const trimmed = req.path.trim()
      let rel = trimmed.replace(/\\/g, '/')
      if (!isSafeWorkspaceRelPath(rel)) {
        // Absolute path under the workspace — convert to a safe relative path.
        const target = canonicalizeWorkspacePath(trimmed)
        rel = relative(root, target).replace(/\\/g, '/')
        if (!rel || rel.startsWith('..') || isAbsolute(rel) || !isSafeWorkspaceRelPath(rel)) {
          return fail('Path is outside the workspace')
        }
      }
      const abs = resolveInsideWorkspace(req.workspacePath, rel)
      await openSlashFile(abs)
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.slashCommandsOpenFile)
    }
  })

  ipcMain.handle(IPC.workspaceSuggestPaths, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceSuggestPathsRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) {
        return fail('Workspace is not open')
      }
      const maxResults = req.maxResults ?? 24
      const query = (req.query ?? '').trim().toLowerCase().replace(/\\/g, '/')
      const files = await collectWorkspaceFiles(req.workspacePath, 8_000)
      const matched = files
        .map((f) => f.rel.replace(/\\/g, '/'))
        .filter((rel) => {
          if (!isSafeWorkspaceRelPath(rel)) return false
          return query ? rel.toLowerCase().includes(query) : true
        })
        .sort((a, b) => {
          if (!query) return a.localeCompare(b)
          const aBase = a.toLowerCase().includes(`/${query}`) || a.toLowerCase().startsWith(query)
          const bBase = b.toLowerCase().includes(`/${query}`) || b.toLowerCase().startsWith(query)
          if (aBase !== bBase) return aBase ? -1 : 1
          return a.localeCompare(b)
        })
      return ok({ paths: matched.slice(0, maxResults), total: matched.length })
    } catch (err) {
      return failFrom(err, IPC.workspaceSuggestPaths)
    }
  })

  ipcMain.handle(IPC.workspaceReadText, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceReadTextRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const rel = String(req.path ?? '').trim().replace(/\\/g, '/')
      if (!isSafeWorkspaceRelPath(rel)) {
        return fail('Path is outside the workspace')
      }
      const bytes = await readWorkspaceAttachmentBytes(
        req.workspacePath,
        rel,
        MAX_ATTACHMENT_BYTES
      )
      const data = bytes.toString('base64')
      const result = await extractAttachment({
        name: rel,
        mime: '',
        data
      })
      return ok(result)
    } catch (err) {
      return failWorkspaceFile(err, IPC.workspaceReadText)
    }
  })

  ipcMain.handle(IPC.workspaceReadImage, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceReadImageRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const rel = String(req.path ?? '').trim().replace(/\\/g, '/')
      if (!isSafeWorkspaceRelPath(rel)) {
        return fail('Path is outside the workspace')
      }
      const bytes = await readWorkspaceAttachmentBytes(
        req.workspacePath,
        rel,
        WORKSPACE_FILE_BINARY_MAX_BYTES
      )
      const dot = rel.lastIndexOf('.')
      const mime = dot >= 0 ? EXT_MIME[rel.slice(dot + 1).toLowerCase()] : undefined
      if (!mime) return fail('Not an image')
      return ok({ mime, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` })
    } catch (err) {
      return failWorkspaceFile(err, IPC.workspaceReadImage)
    }
  })

  ipcMain.handle(IPC.workspaceFileList, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceFileListRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await listWorkspaceDirectory(req))
    } catch (err) {
      return failWorkspaceFile(err, IPC.workspaceFileList)
    }
  })

  ipcMain.handle(IPC.workspaceFileRead, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceFileReadRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await readWorkspaceFile(req.workspacePath, req.path))
    } catch (err) {
      return failWorkspaceFile(err, IPC.workspaceFileRead)
    }
  })

  ipcMain.handle(IPC.workspaceFileStat, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceFileStatRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await statWorkspaceFile(req.workspacePath, req.path))
    } catch (err) {
      return failWorkspaceFile(err, IPC.workspaceFileStat)
    }
  })

  ipcMain.handle(IPC.workspaceFileSave, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceFileSaveRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const result = await saveWorkspaceFile(req)
      if (isSkillRelatedRelPath(req.path) || isRuleRelatedRelPath(req.path)) {
        if (isRuleRelatedRelPath(req.path)) clearRulesCache(req.workspacePath)
        notifySkillsChanged(req.workspacePath)
      }
      return ok(result)
    } catch (err) {
      return failWorkspaceFile(err, IPC.workspaceFileSave)
    }
  })

  ipcMain.handle(IPC.workspaceFileCreate, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceFileCreateRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const result = await createWorkspaceFile(req)
      const createdRel = [req.parentPath, req.name].filter(Boolean).join('/')
      if (isSkillRelatedRelPath(createdRel) || isRuleRelatedRelPath(createdRel)) {
        if (isRuleRelatedRelPath(createdRel)) clearRulesCache(req.workspacePath)
        notifySkillsChanged(req.workspacePath)
      }
      return ok(result)
    } catch (err) {
      return failWorkspaceFile(err, IPC.workspaceFileCreate)
    }
  })

  ipcMain.handle(IPC.workspaceFileMove, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceFileMoveRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const result = await moveWorkspaceFile(req)
      if (
        isSkillRelatedRelPath(req.fromPath) ||
        isSkillRelatedRelPath(req.toPath) ||
        isRuleRelatedRelPath(req.fromPath) ||
        isRuleRelatedRelPath(req.toPath)
      ) {
        if (isRuleRelatedRelPath(req.fromPath) || isRuleRelatedRelPath(req.toPath)) {
          clearRulesCache(req.workspacePath)
        }
        notifySkillsChanged(req.workspacePath)
      }
      return ok(result)
    } catch (err) {
      return failWorkspaceFile(err, IPC.workspaceFileMove)
    }
  })

  ipcMain.handle(IPC.workspaceFileDelete, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceFileDeleteRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const result = await deleteWorkspaceFile(req)
      if (isSkillRelatedRelPath(req.path) || isRuleRelatedRelPath(req.path)) {
        if (isRuleRelatedRelPath(req.path)) clearRulesCache(req.workspacePath)
        notifySkillsChanged(req.workspacePath)
      }
      return ok(result)
    } catch (err) {
      return failWorkspaceFile(err, IPC.workspaceFileDelete)
    }
  })

  ipcMain.handle(IPC.workspaceFileReveal, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceFileRevealRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const path = req.path.replace(/\\/g, '/')
      if (!isSafeWorkspaceRelPath(path)) return fail('Path is outside the workspace')
      shell.showItemInFolder(resolveInsideWorkspace(req.workspacePath, path))
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.workspaceFileReveal)
    }
  })

  ipcMain.handle(IPC.workspaceFormatterStatus, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceFormatterStatusRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await workspaceFormatterStatus(req.workspacePath, req.path))
    } catch (err) {
      return failFrom(err, IPC.workspaceFormatterStatus)
    }
  })

  ipcMain.handle(IPC.workspaceFormatFile, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceFormatFileRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await formatWorkspaceFile(req.workspacePath, req.path, req.content))
    } catch (err) {
      return failFrom(err, IPC.workspaceFormatFile)
    }
  })

  ipcMain.handle(IPC.workspaceLspStatus, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceLspStatusRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await workspaceLspStatus(req.workspacePath, req.path))
    } catch (err) {
      return failFrom(err, IPC.workspaceLspStatus)
    }
  })

  ipcMain.handle(IPC.workspaceLspRequest, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceLspRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await workspaceLspRequest(req))
    } catch (err) {
      return failFrom(err, IPC.workspaceLspRequest)
    }
  })

  ipcMain.handle(IPC.workspaceInlineComplete, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceInlineCompleteRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await completeInline(event.sender.id, req))
    } catch (err) {
      return failFrom(err, IPC.workspaceInlineComplete)
    }
  })

  ipcMain.handle(IPC.workspaceInlineCompleteAbort, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceInlineCompleteAbortRequestSchema.parse(raw ?? {})
      abortInlineComplete(req.requestId)
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.workspaceInlineCompleteAbort)
    }
  })

  ipcMain.handle(IPC.workspaceEditorRecoverySave, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceEditorRecoverySaveRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(
        await saveEditorRecovery(req.workspacePath, req.snapshot, req.sessionToken, req.generation)
      )
    } catch (err) {
      return failWorkspaceFile(err, IPC.workspaceEditorRecoverySave)
    }
  })

  ipcMain.handle(IPC.workspaceEditorRecoveryLoad, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceEditorRecoveryLoadRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await loadEditorRecovery(req.workspacePath))
    } catch (err) {
      return failWorkspaceFile(err, IPC.workspaceEditorRecoveryLoad)
    }
  })

  ipcMain.handle(IPC.workspaceEditorRecoveryClear, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceEditorRecoveryClearRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(
        await clearEditorRecovery(req.workspacePath, req.sessionToken, req.generation)
      )
    } catch (err) {
      return failWorkspaceFile(err, IPC.workspaceEditorRecoveryClear)
    }
  })

  ipcMain.handle(IPC.workspaceListDocs, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceListDocsRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const maxResults = req.maxResults ?? 40
      const query = (req.query ?? '').trim().toLowerCase().replace(/\\/g, '/')
      const files = await collectWorkspaceFiles(req.workspacePath, 8_000)
      const matched = files
        .map((f) => f.rel.replace(/\\/g, '/'))
        .filter((rel) => isSafeWorkspaceRelPath(rel) && isCuratedDocPath(rel))
        .filter((rel) => (query ? rel.toLowerCase().includes(query) : true))
        .sort((a, b) => a.localeCompare(b))
      return ok({ paths: matched.slice(0, maxResults) })
    } catch (err) {
      return failFrom(err, IPC.workspaceListDocs)
    }
  })

  ipcMain.handle(IPC.workspaceListRules, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceListRulesRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const rules = await listWorkspaceRulesForMention(req.workspacePath)
      return ok({
        rules: rules.filter((r) => isSafeWorkspaceRelPath(r.path))
      })
    } catch (err) {
      return failFrom(err, IPC.workspaceListRules)
    }
  })

  ipcMain.handle(IPC.agentContext, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceAgentContextRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(
        await buildWorkspaceAgentContext(req.workspacePath, {
          enabled: getSettings().codeIndex?.enabled !== false,
          phase: getCodeIndexRuntimeStatus().phase
        })
      )
    } catch (err) {
      return failFrom(err, IPC.agentContext)
    }
  })

  ipcMain.handle(IPC.workspaceDiagnostics, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = WorkspaceDiagnosticsRequestSchema.parse(raw ?? {})
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const kind = req.kind ?? 'typecheck'
      const ac = new AbortController()
      const result = await toolDiagnosticsAsync(req.workspacePath, kind, ac.signal)
      return ok({ ok: result.ok, content: result.content, kind })
    } catch (err) {
      return failFrom(err, IPC.workspaceDiagnostics)
    }
  })

  ipcMain.handle(IPC.windowMinimize, async (event): Promise<IpcResult<true>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) return fail('No window')
      win.minimize()
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.windowMinimize)
    }
  })

  ipcMain.handle(IPC.windowMaximize, async (event): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) return fail('No window')
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
      return ok(win.isMaximized())
    } catch (err) {
      return failFrom(err, IPC.windowMaximize)
    }
  })

  ipcMain.handle(IPC.windowClose, async (event): Promise<IpcResult<true>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) return fail('No window')
      win.close()
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.windowClose)
    }
  })

  ipcMain.handle(IPC.windowIsMaximized, async (event): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) return fail('No window')
      return ok(win.isMaximized())
    } catch (err) {
      return failFrom(err, IPC.windowIsMaximized)
    }
  })

  ipcMain.handle(IPC.browserGetState, async (event): Promise<IpcResult<AgentBrowserState>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(getAgentBrowserState())
    } catch (err) {
      return failFrom(err, IPC.browserGetState)
    }
  })

  ipcMain.handle(IPC.browserFocus, async (event): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(focusAgentBrowser())
    } catch (err) {
      return failFrom(err, IPC.browserFocus)
    }
  })

  ipcMain.handle(IPC.browserClose, async (event): Promise<IpcResult<true>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      closeAgentBrowser()
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.browserClose)
    }
  })

  ipcMain.handle(IPC.browserSelectTab, async (event, raw): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = BrowserSelectTabRequestSchema.parse(raw)
      const tabId = req.tabId.trim()
      if (!tabId) return fail('tabId is required')
      if (req.workspacePath && !isOpenWorkspace(req.workspacePath)) {
        return fail('Workspace is not open')
      }
      return ok(selectBrowserTab(tabId, req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.browserSelectTab)
    }
  })

  ipcMain.handle(IPC.browserOpenTab, async (event, raw): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = BrowserOpenTabRequestSchema.parse(raw ?? {})
      if (req.workspacePath && !isOpenWorkspace(req.workspacePath)) {
        return fail('Workspace is not open')
      }
      await manageTabs('open', {
        url: req.url,
        workspacePath: req.workspacePath,
        allowLocal: true
      })
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.browserOpenTab)
    }
  })

  ipcMain.handle(IPC.browserCloseTab, async (event, raw): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = BrowserCloseTabRequestSchema.parse(raw ?? {})
      if (req.workspacePath && !isOpenWorkspace(req.workspacePath)) {
        return fail('Workspace is not open')
      }
      await manageTabs('close', { tabId: req.tabId, workspacePath: req.workspacePath })
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.browserCloseTab)
    }
  })

  ipcMain.handle(IPC.browserTakeControl, async (event): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(takeBrowserControl())
    } catch (err) {
      return failFrom(err, IPC.browserTakeControl)
    }
  })

  ipcMain.handle(IPC.browserReleaseControl, async (event): Promise<IpcResult<true>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      releaseBrowserControl()
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.browserReleaseControl)
    }
  })

  ipcMain.handle(IPC.browserBack, async (event, raw): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const scope = BrowserWorkspaceScopeSchema.optional().parse(raw)
      if (scope?.workspacePath && !isOpenWorkspace(scope.workspacePath)) return fail('Workspace is not open')
      return ok(await browserGoBack(scope?.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.browserBack)
    }
  })

  ipcMain.handle(IPC.browserForward, async (event, raw): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const scope = BrowserWorkspaceScopeSchema.optional().parse(raw)
      if (scope?.workspacePath && !isOpenWorkspace(scope.workspacePath)) return fail('Workspace is not open')
      return ok(await browserGoForward(scope?.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.browserForward)
    }
  })

  ipcMain.handle(IPC.browserNavigate, async (event, raw): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const payload = BrowserNavigateRequestSchema.parse(raw)
      // User browser panel may pass workspacePath for cookie/scope — require open workspace.
      // allowLocal stays default true (intentional local/dev browsing); Ask/Plan agent tools pass false.
      if (payload.workspacePath && !isOpenWorkspace(payload.workspacePath)) {
        return fail('Workspace is not open')
      }
      await navigateUrl(payload.url, {
        workspacePath: payload.workspacePath,
        agentControl: false
      })
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.browserNavigate)
    }
  })

  ipcMain.handle(IPC.browserReload, async (event, raw): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const scope = BrowserWorkspaceScopeSchema.optional().parse(raw)
      if (scope?.workspacePath && !isOpenWorkspace(scope.workspacePath)) return fail('Workspace is not open')
      const state = getAgentBrowserState()
      if (!state.url) return fail('No active page')
      await navigateUrl(state.url, {
        workspacePath: scope?.workspacePath,
        agentControl: false
      })
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.browserReload)
    }
  })

  ipcMain.handle(
    IPC.browserTakeScreenshot,
    async (event, raw): Promise<IpcResult<{ path: string }>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const payload = BrowserTakeScreenshotRequestSchema.parse(raw)
        if (!isOpenWorkspace(payload.workspacePath)) return fail('Workspace is not open')
        let runDir: string
        if (payload.runId) {
          if (!runExists(payload.workspacePath, payload.runId)) return fail('Run not found')
          runDir = resolveRunDir(payload.workspacePath, payload.runId)
        } else {
          runDir = workspaceBrowserArtifactsDir(payload.workspacePath)
        }
        const result = await takeBrowserScreenshot({
          runDir,
          tabId: payload.tabId,
          workspacePath: payload.workspacePath
        })
        return ok(result)
      } catch (err) {
        return failFrom(err, IPC.browserTakeScreenshot)
      }
    }
  )

  ipcMain.handle(
    IPC.browserClearBrowsingData,
    async (
      event,
      raw
    ): Promise<IpcResult<{ cleared: 'history' | 'cookies' | 'cache' | 'all' }>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        const req = BrowserClearBrowsingDataRequestSchema.parse(raw)
        if (req.workspacePath && !isOpenWorkspace(req.workspacePath)) {
          return fail('Workspace is not open')
        }
        return ok(await clearAgentBrowserData(req.kind, req.workspacePath))
      } catch (err) {
        return failFrom(err, IPC.browserClearBrowsingData)
      }
    }
  )

  ipcMain.handle(
    IPC.browserSetBounds,
    async (
      event,
      raw
    ): Promise<IpcResult<true>> => {
      if (!senderOk(event)) return fail('Invalid sender')
      try {
        if (raw == null) {
          setAgentBrowserBounds(null)
          return ok(true)
        }
        const bounds = BrowserSetBoundsRequestSchema.parse(raw)
        setAgentBrowserBounds(bounds)
        return ok(true)
      } catch (err) {
        return failFrom(err, IPC.browserSetBounds)
      }
    }
  )

  ipcMain.handle(IPC.getSystemTheme, async (event): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(nativeTheme.shouldUseDarkColors)
    } catch (err) {
      return failFrom(err, IPC.getSystemTheme)
    }
  })

  ipcMain.handle(IPC.networkProbe, async (event): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(await probeNetworkOnline())
    } catch (err) {
      return failFrom(err, IPC.networkProbe)
    }
  })

  ipcMain.handle(IPC.codeIndexStatus, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const settings = getSettings()
      return ok({
        ...getCodeIndexRuntimeStatus(),
        settings: settings.codeIndex
      })
    } catch (err) {
      return failFrom(err, IPC.codeIndexStatus)
    }
  })

  ipcMain.handle(IPC.codeIndexReindex, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = CodeIndexReindexRequestSchema.parse(raw ?? {})
      const workspacePath = req.workspacePath?.trim() || getWorkspaces().activePath || ''
      if (!workspacePath) return fail('No active workspace')
      if (!isOpenWorkspace(workspacePath)) return fail('Workspace is not open')
      if (getSettings().codeIndex?.enabled === false) {
        return fail('Codebase index is disabled')
      }
      const sync = await reindexCodeIndex(workspacePath, {
        signal: workspaceIndexAbortSignal(workspacePath)
      })
      if (!sync) return fail('Reindex produced no sync result')
      return ok({
        scanned: sync.scanned,
        indexed: sync.indexed,
        skipped: sync.skipped,
        removed: sync.removed
      })
    } catch (err) {
      return failFrom(err, IPC.codeIndexReindex)
    }
  })

  ipcMain.handle(IPC.processMetrics, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(collectProcessMetrics())
    } catch (err) {
      return failFrom(err, IPC.processMetrics)
    }
  })

}
