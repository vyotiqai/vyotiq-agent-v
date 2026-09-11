import type { Ref } from 'react'
import { memo, useCallback, useMemo } from 'react'
import type { AgentInstanceUiState } from '@shared/utils/agentInstance'
import type { UiAgentQuestionAnswer, UiItem } from '@shared/transcript'
import type {
  AgentInteractionMode,
  AttachedFile,
  ChatMessage,
  ProviderId,
  SecretProvider,
  ToolApprovalDecision
} from '@shared/ipc'
import type { ChatSettingsPatch, EffectiveChatSettings } from '@shared/effectiveSettings'
import type { ChatStreamController } from '@renderer/lib/hooks/createChatStreamController'
import { Composer } from './components/composer'
import { useHasChatItems } from './components/ChatStreamLeaves'
import { RunSessionProvider } from './RunSessionContext'
import { MessageList } from './components/MessageList'
import { AgentInstancePane } from './components/AgentInstancePane'
import { ChatTranscriptStage } from './components/ChatTranscriptStage'
import { useRunGoal } from './hooks/useRunGoal'
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
  onApprovalDecision,
  onQuestionSubmit,
  collapsedTurns,
  showThinking = true,
  chatSurfaceEpoch = 0,
  mcpServerNames,
  slashHandlers,
  sideRailPad = false,
  showPageHeading = true,
  onActivate,
  approvalAutoFocus = true,
  onOpenChanges,
  onOpenWorkspaceFile,
  agentInstances,
  openInstanceRunId: openInstanceRunIdProp = null,
  onOpenInstanceRunIdChange,
  getInstanceController
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
  onRevertToUserMessage?: (userMessageIndex: number) => boolean | Promise<boolean>
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
  onThinkingToggle?: (messageId: string, expanded: boolean) => void
  onToolToggle?: (toolCallId: string, expanded: boolean) => void
  onGroupToggle?: (anchorToolCallId: string, expanded: boolean) => void
  onTurnToggle?: (turnIndex: number) => void
  onApprovalDecision?: (requestId: string, decision: ToolApprovalDecision) => void | Promise<void>
  onQuestionSubmit?: (requestId: string, answers: UiAgentQuestionAnswer[]) => void | Promise<void>
  collapsedTurns?: ReadonlySet<number>
  showThinking?: boolean
  chatSurfaceEpoch?: number
  mcpServerNames?: ReadonlyMap<string, string>
  slashHandlers?: import('./components/composer/slashCommandExecute').SlashClientHandlers
  sideRailPad?: boolean
  showPageHeading?: boolean
  onActivate?: () => void
  approvalAutoFocus?: boolean
  onOpenChanges?: (path?: string) => void
  onOpenWorkspaceFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
  agentInstances?: Record<string, AgentInstanceUiState>
  openInstanceRunId?: string | null
  onOpenInstanceRunIdChange?: (runId: string | null) => void
  getInstanceController?: (runId: string, workspacePath: string) => ChatStreamController | null
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
  const { chatBannerError, turnFailed, turnFailureLabel } = useChatErrorSurfaces({
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
    slashHandlers,
    sideRailPad,
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

  return (
    <>
      {showPageHeading ? (
        <h1 ref={headingRef} tabIndex={-1} className="sr-only">
          Agent V chat
        </h1>
      ) : null}
      {openInstanceRunId && workspacePath ? (
        <AgentInstancePane
          key={openInstanceRunId}
          workspacePath={workspacePath}
          instanceRunId={openInstanceRunId}
          instanceMeta={agentInstances?.[openInstanceRunId]}
          getController={getInstanceController}
          sideRailPad={sideRailPad}
          pendingGates={pendingGates}
          onOpenInstance={openInstancePane}
          onClose={closeInstancePane}
          showThinking={showThinking}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
          approvalAutoFocus={approvalAutoFocus}
        />
      ) : (
        <RunSessionProvider value={runSession}>
            <ChatTranscriptStage
              sideRailPad={sideRailPad}
              pendingGates={pendingGates}
              onOpenInstance={openInstancePane}
              goal={runGoal.goal}
              loop={runGoal.loop}
              running={running}
              onGoalPause={runGoal.pause}
              onGoalResume={runGoal.resume}
              onGoalComplete={runGoal.complete}
              onStopLoop={runGoal.stopLoop}
              onStopRun={onStop}
              transcript={
                <MessageList
                  key={`transcript:${surfaceKey}`}
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
                  restoreScrollTop={restoreScrollTop}
                  scrollRestoreToken={scrollRestoreToken}
                  onScrollTopChange={onScrollTopChange}
                  onActivate={onActivate}
                  onLoadToolContent={onLoadToolContent}
                  onThinkingToggle={onThinkingToggle}
                  onToolToggle={onToolToggle}
                  onGroupToggle={onGroupToggle}
                  onTurnToggle={onTurnToggle}
                  onApprovalDecision={onApprovalDecision}
                  onQuestionSubmit={onQuestionSubmit}
                  onRetryNetwork={onContinue}
                  approvalAutoFocus={approvalAutoFocus}
                  collapsedTurns={collapsedTurns}
                  showThinking={showThinking}
                  mcpServerNames={mcpServerNames}
                  onOpenChanges={onOpenChanges}
                  sideRailPad={sideRailPad}
                  editingUserMessageIndex={editingUserMessageIndex}
                  editComposer={editComposer}
                  onBeginEditUserMessage={onEditAndResend ? beginPromptEdit : undefined}
                  onRevertUserMessage={onRevertToUserMessage ? beginPromptRevert : undefined}
                  messageCount={messages.length}
                  turnUsage={turnUsage}
                  metaStore={metaStore}
                />
              }
              composer={
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
              }
            />
        </RunSessionProvider>
      )}
    </>
  )
}
