import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import type { ChatMessage } from '@shared/ipc'
import type { UiAgentQuestionAnswer } from '@shared/transcript'
import type { AgentInstanceUiState } from '@shared/utils/agentInstance'
import { formatAgentInstanceShortId } from '@shared/utils/agentInstance'
import { instanceDisplayTitle, stripGoalMarkdown } from '@renderer/app/sidebar/runTitle'
import { MessageList } from '../components/MessageList'
import { InlineInstanceGateBanner } from './InlineInstanceGateBanner'
import type { InlineInstanceGate } from '../hooks/useInlineInstanceUi'
import { RunSessionProvider } from '../RunSessionContext'
import type { WorkspaceFileOpenOptions } from './FilesPanel'
import {
  createChatStreamController,
  type ChatStreamController
} from '@renderer/lib/hooks/createChatStreamController'
import { useEscapeToClose } from '@renderer/lib/hooks/useEscapeToClose'
import { cn } from '@renderer/lib/ui'
import { CHAT_COLUMN, CHAT_GUTTER, CHAT_STAGE_INSET } from '@renderer/lib/utils/layout'

const HEADER_ACTION =
  'shrink-0 rounded px-1.5 py-0.5 text-xs text-muted vy-transition hover:bg-surface/70 hover:text-fg'

/** Matches spawn note in agentInstances + runTitle.PATH_SCOPE_FOOTER. */
const PATH_SCOPE_FOOTER_SPLIT = /\n\nPath scope \(writes must stay within/i

function useControllerRunningMeta(controller: ChatStreamController): {
  running: boolean
  pendingRun: boolean
  transcriptLoading: boolean
} {
  const [, bump] = useState(0)
  useEffect(() => controller.subscribeMeta(() => bump((n) => n + 1)), [controller])
  return {
    running: controller.running,
    pendingRun: controller.pendingRun,
    transcriptLoading: controller.transcriptLoading
  }
}

const AgentInstanceTranscript = memo(function AgentInstanceTranscript({
  controller,
  running,
  pendingRun,
  transcriptLoading,
  sideRailPad,
  showThinking,
  collapsedTurns,
  onTurnToggle,
  onLoadToolContent,
  onApprovalDecision,
  onQuestionSubmit,
  approvalAutoFocus
}: {
  controller: ChatStreamController
  running: boolean
  pendingRun: boolean
  transcriptLoading: boolean
  sideRailPad: boolean
  showThinking: boolean
  collapsedTurns: ReadonlySet<number>
  onTurnToggle: (turnIndex: number) => void
  onLoadToolContent: (id: string) => Promise<string | null>
  onApprovalDecision: (
    requestId: string,
    decision: Parameters<ChatStreamController['respondToApproval']>[1]
  ) => void
  onQuestionSubmit: (requestId: string, answers: UiAgentQuestionAnswer[]) => void
  approvalAutoFocus: boolean
}) {
  const [, bump] = useState(0)
  const metaStore = useMemo(
    () => ({
      subscribeMeta: controller.subscribeMeta.bind(controller),
      getMetaRevision: controller.getMetaRevision.bind(controller),
      getContextUsage: controller.getContextUsage.bind(controller),
      getTurnUsage: controller.getTurnUsage.bind(controller),
      getCostHint: controller.getCostHint.bind(controller)
    }),
    [controller]
  )
  useEffect(() => controller.subscribeItems(() => bump((n) => n + 1)), [controller])
  return (
    <MessageList
      items={controller.items}
      running={running}
       pendingRun={pendingRun}
       turnStatus={controller.turnStatus}
       transcriptLoading={transcriptLoading}
      sideRailPad={sideRailPad}
      showThinking={showThinking}
      collapsedTurns={collapsedTurns}
      onTurnToggle={onTurnToggle}
      onLoadToolContent={onLoadToolContent}
      onApprovalDecision={onApprovalDecision}
      onQuestionSubmit={onQuestionSubmit}
      approvalAutoFocus={approvalAutoFocus}
      virtualizeLiveEarly
      turnUsage={controller.turnUsage}
      metaStore={metaStore}
    />
  )
})

type AgentInstancePaneProps = {
  workspacePath: string
  instanceRunId: string
  instanceMeta?: AgentInstanceUiState
  /** Prefer workspace-manager controller so IPC is not dual-subscribed. */
  getController?: (runId: string, workspacePath: string) => ChatStreamController | null
  /** Match parent chat stage inset when the floating side rail is visible. */
  sideRailPad?: boolean
  /** Parent-tracked approval/question gates (visible while nested in this pane). */
  pendingGates?: InlineInstanceGate[]
  onOpenInstance?: (runId: string) => void
  /** Leave the sub-session and return to the parent chat. */
  onClose: () => void
  showThinking?: boolean
  onOpenWorkspaceFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
  approvalAutoFocus?: boolean
  /** Report the controller backing this pane (WM-shared or pane-owned) so parents
   * (e.g. the dock Changes panel) can subscribe to the same run's items. */
  onControllerChange?: (controller: ChatStreamController | null) => void
}

function goalFromMessages(messages: ChatMessage[]): string | undefined {
  if (!messages.length) return undefined
  for (const message of messages) {
    if (message.role !== 'user') continue
    const content = message.content
    if (typeof content !== 'string' || !content.trim()) continue
    const withoutScope = content.split(PATH_SCOPE_FOOTER_SPLIT)[0]?.trim()
    return withoutScope || content.trim()
  }
  return undefined
}

/**
 * Inline sub-session view for an agent instance under its parent chat.
 * Same transcript column as a normal chat (not a drawer / overlay / tab strip).
 * Inspect + stop only — follow-ups stay on the parent / normal run surface.
 */
export function AgentInstancePane({
  workspacePath,
  instanceRunId,
  instanceMeta,
  getController,
  sideRailPad = false,
  pendingGates = [],
  onOpenInstance,
  onClose,
  showThinking = true,
  onOpenWorkspaceFile,
  approvalAutoFocus = true,
  onControllerChange
}: AgentInstancePaneProps) {
  const shared = getController?.(instanceRunId, workspacePath) ?? null
  const controller = useMemo(
    () =>
      shared ??
      createChatStreamController({
        workspacePath,
        runId: instanceRunId
      }),
    [shared, instanceRunId, workspacePath]
  )
  const ownsIpc = shared == null

  // Dock surfaces (Changes panel) subscribe to the same run via this — fires on
  // mount and controller swap, reports null on unmount.
  useEffect(() => {
    onControllerChange?.(controller)
    return () => onControllerChange?.(null)
  }, [controller, onControllerChange])

  const { running, pendingRun, transcriptLoading } = useControllerRunningMeta(controller)
  const [goalFromDisk, setGoalFromDisk] = useState<string | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [liveReady, setLiveReady] = useState(false)

  useEffect(() => {
    setGoalFromDisk(undefined)
    setLoadError(null)
    setLiveReady(false)
  }, [instanceRunId])

  // Catch-up stays suspended until disk hydrate finishes so WM-routed live
  // events cannot paint and then be wiped by a lagging snapshot.
  useEffect(() => {
    if (!window.vyotiq?.loadRun) {
      setLiveReady(true)
      return
    }
    const loadRun = window.vyotiq.loadRun
    let cancelled = false
    void (async () => {
      const res = await loadRun(workspacePath, instanceRunId)
      if (cancelled) return
      if (!res.ok) {
        setLoadError(res.error || 'Failed to load instance run')
        setLiveReady(true)
        return
      }
      setGoalFromDisk(goalFromMessages(res.data.messages))
      controller.setUiSuspended(true)
      controller.markUiCatchUpNeeded()
      await controller.resumeUiIfNeeded()
      if (cancelled) return
      if (window.vyotiq?.listPendingToolApprovals) {
        const pending = await window.vyotiq.listPendingToolApprovals(instanceRunId)
        if (!cancelled && pending.ok) {
          for (const request of pending.data) controller.handleApprovalRequest(request)
        }
      }
      if (window.vyotiq?.listPendingAgentQuestions) {
        const pending = await window.vyotiq.listPendingAgentQuestions(instanceRunId)
        if (!cancelled && pending.ok) {
          for (const request of pending.data) controller.handleQuestionRequest(request)
        }
      }
      if (!cancelled) setLiveReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [controller, workspacePath, instanceRunId])

  // Only own IPC when we created the controller — WM already routes shared controllers.
  useEffect(() => {
    if (!ownsIpc || !liveReady || !window.vyotiq?.onChatEvent) return
    return window.vyotiq.onChatEvent((event) => {
      if (event.runId !== instanceRunId) return
      controller.handleEvent(event)
    })
  }, [controller, instanceRunId, liveReady, ownsIpc])

  useEffect(() => {
    if (!ownsIpc || !liveReady || !window.vyotiq?.onToolApprovalRequest) return
    return window.vyotiq.onToolApprovalRequest((request) => {
      if (request.runId !== instanceRunId) return
      controller.handleApprovalRequest(request)
    })
  }, [controller, instanceRunId, liveReady, ownsIpc])

  useEffect(() => {
    if (!ownsIpc || !liveReady || !window.vyotiq?.onAgentQuestionRequest) return
    return window.vyotiq.onAgentQuestionRequest((request) => {
      if (request.runId !== instanceRunId) return
      controller.handleQuestionRequest(request)
    })
  }, [controller, instanceRunId, liveReady, ownsIpc])

  useEffect(() => {
    if (!ownsIpc) return
    return () => {
      controller.dispose()
    }
  }, [controller, ownsIpc])

  useEscapeToClose(onClose, true, { deferToMenus: true })

  const onApprovalDecision = useCallback(
    (requestId: string, decision: Parameters<typeof controller.respondToApproval>[1]) =>
      controller.respondToApproval(requestId, decision),
    [controller]
  )

  const onQuestionSubmit = useCallback(
    (requestId: string, answers: UiAgentQuestionAnswer[]) =>
      controller.respondToQuestion(requestId, answers),
    [controller]
  )

  const onLoadToolContent = useCallback(
    (id: string) => controller.loadToolContent(id),
    [controller]
  )

  const onStopInstance = useCallback(() => {
    void controller.stop()
  }, [controller])

  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(() => new Set())
  const onTurnToggle = useCallback((turnIndex: number) => {
    setCollapsedTurns((prev) => {
      const next = new Set(prev)
      if (next.has(turnIndex)) next.delete(turnIndex)
      else next.add(turnIndex)
      return next
    })
  }, [])

  const runSession = useMemo(
    () => ({
      workspacePath,
      runId: instanceRunId,
      onOpenWorkspaceFile
    }),
    [workspacePath, instanceRunId, onOpenWorkspaceFile]
  )

  const shortId = formatAgentInstanceShortId(instanceRunId)
  const fullGoal = instanceMeta?.goal ?? goalFromDisk
  const title = instanceDisplayTitle(fullGoal, instanceRunId, instanceMeta?.pathScope)
  const tooltip = fullGoal ? stripGoalMarkdown(fullGoal) || fullGoal : instanceRunId
  const gutter = sideRailPad ? CHAT_STAGE_INSET : CHAT_GUTTER

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-bg text-fg"
      role="region"
      aria-label={`Agent V instance ${shortId}: ${title}`}
      data-agent-instance-session={instanceRunId}
      data-chat-stage
    >
      <header
        className={cn(
          'flex h-7 shrink-0 items-center gap-2 border-b border-border/40 bg-bg/90',
          gutter
        )}
      >
        <button
          type="button"
          className={HEADER_ACTION}
          aria-label="Back to parent chat"
          onClick={onClose}
        >
          Back
        </button>
        <div
          className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-xs"
          title={tooltip}
        >
          {title !== shortId ? (
            <>
              <span className="min-w-0 truncate text-fg/80">{title}</span>
              <span className="shrink-0 text-muted/70" aria-hidden>
                ·
              </span>
            </>
          ) : null}
          <span className="shrink-0 text-muted">Instance</span>
          <span className="shrink-0 font-mono text-muted">{shortId}</span>
        </div>
        {running ? (
          <button
            type="button"
            className={HEADER_ACTION}
            aria-label="Stop instance"
            onClick={onStopInstance}
          >
            Stop
          </button>
        ) : null}
      </header>
      {loadError ? (
        <div className={cn('shrink-0 pt-2 text-xs text-danger', gutter)} role="alert">
          {loadError}
        </div>
      ) : null}
      {pendingGates.length > 0 && onOpenInstance ? (
        <div className={cn('shrink-0 pt-2', gutter)}>
          <div className={CHAT_COLUMN}>
            <InlineInstanceGateBanner gates={pendingGates} onOpenInstance={onOpenInstance} />
          </div>
        </div>
      ) : null}
      <RunSessionProvider value={runSession}>
        <AgentInstanceTranscript
          controller={controller}
          running={running}
          pendingRun={pendingRun}
          transcriptLoading={transcriptLoading}
          sideRailPad={sideRailPad}
          showThinking={showThinking}
          collapsedTurns={collapsedTurns}
          onTurnToggle={onTurnToggle}
          onLoadToolContent={onLoadToolContent}
          onApprovalDecision={onApprovalDecision}
          onQuestionSubmit={onQuestionSubmit}
          approvalAutoFocus={approvalAutoFocus}
        />
      </RunSessionProvider>
    </div>
  )
}
