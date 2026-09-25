import type { Ref } from 'react'
import { memo, useCallback, useMemo } from 'react'
import type { AgentInstanceUiState } from '@shared/utils/agentInstance'
import type { UiAgentQuestionAnswer, UiItem } from '@shared/transcript'
import type {
  AgentInteractionMode,
  AttachedFile,
  ChatMessage,
  ProviderId,
  RunSummary,
  SecretProvider,
  ToolApprovalDecision
} from '@shared/ipc'
import type { ChatSettingsPatch, EffectiveChatSettings } from '@shared/effectiveSettings'
import type { ChatStreamController } from '@renderer/lib/hooks/createChatStreamController'
import { PaneHeaderActions, TaskPane, type TaskPaneRunActions } from '@renderer/features/task/TaskPane'
import type { NewTaskTargets } from '@renderer/features/task/NewTaskBrief'
import { runTitle } from '@renderer/app/navigator/runTitle'
import { useTaskRecentFiles } from '@renderer/features/inspector/agentFileMarks'
import { Composer } from './components/composer'
import { useHasChatItems } from './components/ChatStreamLeaves'
import { RunSessionProvider } from './RunSessionContext'
import { AgentInstancePane } from './components/AgentInstancePane'
import { useRunGoal } from './hooks/useRunGoal'
import { useRunFeedback } from './hooks/useRunFeedback'
import { useInlineInstanceUi } from './hooks/useInlineInstanceUi'
import {
  buildComposerSendProps,
  lastUserMessageIndex,
  useChatErrorSurfaces,
  useComposerEditState
} from './hooks/composerShared'
import type { ChatItemsStore, ChatMetaStore } from './chatStores'
import type { WorkspaceFileOpenOptions } from './components/FilesPanel'

const MemoComposer = memo(Composer)

export function SessionChatColumn({
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
  onDismissRunError,
  onApprovalDecision,
  onQuestionSubmit,
  showThinking = true,
  chatSurfaceEpoch = 0,
  mcpServerNames,
  slashHandlers,
  onShowInspector,
  showPageHeading = true,
  onActivate,
  approvalAutoFocus = true,
  onOpenChanges,
  onOpenWorkspaceFile,
  agentInstances,
  openInstanceRunId: openInstanceRunIdProp = null,
  onOpenInstanceRunIdChange,
  getInstanceController,
  run = null,
  runActions = {},
  instanceRuns,
  newTaskTargets
}: {
  items: UiItem[]
  itemsStore?: ChatItemsStore
  metaStore?: ChatMetaStore
  running: boolean
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
  turnUsage?: readonly import('@shared/utils/runTelemetry').StepUsageTotals[]
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
  secrets: Record<SecretProvider, boolean>
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
    files?: AttachedFile[],
    extras?: import('@shared/ipc').ComposerSendExtras
  ) => boolean | void | Promise<boolean | void>
  onStop: () => void
  onEditAndResend?: (
    editMessageIndex: number,
    text: string,
    images?: string[],
    files?: AttachedFile[],
    extras?: import('@shared/ipc').ComposerSendExtras
  ) => boolean | void | Promise<boolean | void>
  onRevertToUserMessage?: (userMessageIndex: number, runN?: number) => boolean | Promise<boolean>
  messages?: ChatMessage[]
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
  /** Hide one error row in the record for good. */
  onDismissRunError?: (itemId: string) => void
  onApprovalDecision?: (requestId: string, decision: ToolApprovalDecision) => void | Promise<void>
  onQuestionSubmit?: (requestId: string, answers: UiAgentQuestionAnswer[]) => void | Promise<void>
  showThinking?: boolean
  chatSurfaceEpoch?: number
  mcpServerNames?: ReadonlyMap<string, string>
  slashHandlers?: import('./components/composer/slashCommandExecute').SlashClientHandlers
  /** Set on the rightmost pane while the inspector is hidden. */
  onShowInspector?: () => void
  showPageHeading?: boolean
  onActivate?: () => void
  approvalAutoFocus?: boolean
  onOpenChanges?: (path?: string) => void
  onOpenWorkspaceFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
  agentInstances?: Record<string, AgentInstanceUiState>
  openInstanceRunId?: string | null
  onOpenInstanceRunIdChange?: (runId: string | null) => void
  getInstanceController?: (runId: string, workspacePath: string) => ChatStreamController | null
  /** The run as the workspace's run list has it, for the task header. */
  run?: RunSummary | null
  /** Rename, export, copy link, delete, split, close — the header's menu. */
  runActions?: TaskPaneRunActions
  /** This workspace's instance runs, for an open instance's worktree branch. */
  instanceRuns?: readonly RunSummary[]
  /** The workspaces a new task can move to from its brief. */
  newTaskTargets?: NewTaskTargets
}) {
  const instanceOpenControlled =
    onOpenInstanceRunIdChange != null
      ? {
          openInstanceRunId: openInstanceRunIdProp ?? null,
          setOpenInstanceRunId: onOpenInstanceRunIdChange
        }
      : undefined
  const {
    openInstanceRunId,
    openInstancePane,
    closeInstancePane,
    pendingGates
  } = useInlineInstanceUi(agentInstances, activeRunId, instanceOpenControlled)

  const hasItems = useHasChatItems(itemsStore, items)
  /** The @ menu's recent files: what this task read or edited last. */
  const taskFiles = useTaskRecentFiles(items, itemsStore, workspacePath ?? null)
  // Nothing sent and no run behind it: the pane is a new task's brief.
  const newTask = !activeRunId && !hasItems && !pendingRun && !running
  const { chatBannerError, turnFailed } = useChatErrorSurfaces({
    itemsStore,
    items,
    error,
    errorCode,
    incomplete,
    turnStatus
  })
  const operationalBannerError = operationalError ?? null
  // Match ChatView: remount on workspace/epoch only — not draft→run (avoids composer wipe).
  const surfaceKey = `${workspacePath ?? 'none'}:${chatSurfaceEpoch}`

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
    onRevertToUserMessage
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
        slashHandlers={slashHandlers}
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
        taskFiles={taskFiles}
      />
    ) : null

  const runFeedback = useRunFeedback(workspacePath, activeRunId, !running)
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
    slashHandlers,
    onFocus: onActivate,
    onEditLastUserMessage
  })

  const runSession = useMemo(
    () => ({
      workspacePath: workspacePath ?? null,
      runId: activeRunId ?? null,
      agentMode,
      agentInstances,
      onOpenAgentInstance:
        workspacePath != null ? (instanceRunId: string) => openInstancePane(instanceRunId) : undefined,
      onOpenWorkspaceFile
    }),
    [workspacePath, activeRunId, agentMode, agentInstances, openInstancePane, onOpenWorkspaceFile]
  )

  const runGoal = useRunGoal({
    workspacePath: workspacePath ?? null,
    runId: activeRunId ?? null,
    running,
    active: true
  })

  // Runs so far, as the record numbers them: one per instruction you sent.
  const runCount = useMemo(() => messages.filter((m) => m.role === 'user').length, [messages])

  return (
    <>
      {openInstanceRunId && workspacePath ? (
        <AgentInstancePane
          key={openInstanceRunId}
          workspacePath={workspacePath}
          instanceRunId={openInstanceRunId}
          instanceMeta={agentInstances?.[openInstanceRunId]}
          getController={getInstanceController}
          onShowInspector={onShowInspector}
          pendingGates={pendingGates}
          onOpenInstance={openInstancePane}
          onClose={closeInstancePane}
          showThinking={showThinking}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
          approvalAutoFocus={approvalAutoFocus}
          instanceRun={instanceRuns?.find((r) => r.runId === openInstanceRunId) ?? null}
          parentTitle={run ? runTitle(run) : undefined}
          siblings={agentInstances}
        />
      ) : (
        <RunSessionProvider value={runSession}>
          <TaskPane
            key={`record:${surfaceKey}`}
            workspacePath={workspacePath}
            runId={activeRunId}
            items={items}
            itemsStore={itemsStore}
            metaStore={metaStore}
            running={running}
            pendingRun={pendingRun}
            turnFailed={turnFailed || turnStatus === 'error'}
            turnStatus={turnStatus}
            networkWait={networkWait}
            compacting={compacting}
            showThinking={showThinking}
            run={run}
            transcriptLoading={transcriptLoading}
            transcriptHasEarlier={transcriptHasEarlier}
            transcriptLoadingEarlier={transcriptLoadingEarlier}
            onLoadEarlier={onLoadEarlierMessages}
            restoreScrollTop={restoreScrollTop}
            scrollRestoreToken={scrollRestoreToken}
            onScrollTopChange={onScrollTopChange}
            onActivate={onActivate}
            headingRef={showPageHeading ? headingRef : undefined}
            onStop={onStop}
            actions={runActions}
            turnUsage={turnUsage}
            runFeedback={runFeedback}
            onApprovalDecision={onApprovalDecision}
            onQuestionSubmit={onQuestionSubmit}
            approvalAutoFocus={approvalAutoFocus}
            instanceGates={pendingGates}
            onOpenInstance={openInstancePane}
            editingUserMessageIndex={editingUserMessageIndex}
            editComposer={editComposer}
            onBeginEdit={onEditAndResend ? beginPromptEdit : undefined}
            onRevert={onRevertToUserMessage ? beginPromptRevert : undefined}
            messageCount={messages.length}
            onOpenChanges={onOpenChanges}
            onLoadToolContent={onLoadToolContent}
            onRetry={onContinue}
            onDismissRunError={onDismissRunError}
            mcpServerNames={mcpServerNames}
            goal={runGoal.goal}
            loop={runGoal.loop}
            onGoalPause={runGoal.pause}
            onGoalResume={runGoal.resume}
            onGoalComplete={runGoal.complete}
            onGoalActivate={runGoal.activate}
            onGoalDismiss={runGoal.dismiss}
            onStopLoop={runGoal.stopLoop}
            onShowInspector={onShowInspector}
            newTask={newTask}
            composer={
              <div
                className={editing ? 'hidden' : newTask ? 'flex min-h-0 flex-1 flex-col' : undefined}
                inert={editing ? true : undefined}
                aria-hidden={editing || undefined}
              >
                <MemoComposer
                  key={`composer:${surfaceKey}`}
                  {...composerProps}
                  variant={newTask ? 'brief' : 'line'}
                  runCount={runCount}
                  onDismissError={onDismissError}
                  newTaskTargets={newTaskTargets}
                  taskFiles={taskFiles}
                  briefHeaderActions={
                    newTask ? (
                      <PaneHeaderActions
                        title="New task"
                        onShowInspector={onShowInspector}
                        onClosePane={runActions.onClosePane}
                      />
                    ) : undefined
                  }
                />
              </div>
            }
          />
        </RunSessionProvider>
      )}
    </>
  )
}
