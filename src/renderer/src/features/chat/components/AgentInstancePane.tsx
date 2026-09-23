import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChatMessage, RunSummary } from '@shared/ipc'
import type { UiAgentQuestionAnswer } from '@shared/transcript'
import type { AgentInstanceUiState } from '@shared/utils/agentInstance'
import { formatAgentInstanceShortId } from '@shared/utils/agentInstance'
import { instanceDisplayTitle, stripGoalMarkdown } from '@renderer/app/navigator/runTitle'
import type { InlineInstanceGate } from '../hooks/useInlineInstanceUi'
import { RunSessionProvider } from '../RunSessionContext'
import type { WorkspaceFileOpenOptions } from './FilesPanel'
import {
  createChatStreamController,
  type ChatStreamController
} from '@renderer/lib/hooks/createChatStreamController'
import { useEscapeToClose } from '@renderer/lib/hooks/useEscapeToClose'
import { Icon } from '@renderer/lib/icons'
import { AgentVSpinner } from '@renderer/lib/brand'
import { Button, IconButton, MarkdownContent, StatusGlyph, cn, type TaskState } from '@renderer/lib/ui'
import { focusComposerMessage, shortcutLabel } from '@renderer/lib/shortcuts'
import type { ContextUsageState } from '@shared/utils/contextUsage'
import { ContextMeter } from './composer/ContextMeter'
import { useResolvedTurnUsage } from './ChatStreamLeaves'
import { buildRecordModel, type BuildOptions } from '@renderer/features/task/recordModel'
import { RecordBody, RecordRow } from '@renderer/features/task/record/RecordLayout'
import { RecordActionsContext } from '@renderer/features/task/record/WorkItems'
import { TaskRecord } from '@renderer/features/task/TaskRecord'
import { useRecordScroll } from '@renderer/features/task/useRecordScroll'

/** An instance's phase, as the parent's stream reports it, in the glyph vocabulary. */
export function instancePhaseState(phase: AgentInstanceUiState['phase'] | undefined, waiting: boolean): TaskState {
  if (waiting) return 'needs'
  switch (phase) {
    case 'done':
      return 'done'
    case 'error':
      return 'failed'
    case 'cancelled':
      return 'stopped'
    case 'started':
    default:
      return 'running'
  }
}

/** Matches spawn note in agentInstances + runTitle.PATH_SCOPE_FOOTER. */
const PATH_SCOPE_FOOTER_SPLIT = /\n\nPath scope \(writes must stay within/i

function useControllerRunningMeta(controller: ChatStreamController): {
  running: boolean
  pendingRun: boolean
  transcriptLoading: boolean
  transcriptHasEarlier: boolean
  transcriptLoadingEarlier: boolean
} {
  const [, bump] = useState(0)
  useEffect(() => controller.subscribeMeta(() => bump((n) => n + 1)), [controller])
  return {
    running: controller.running,
    pendingRun: controller.pendingRun,
    transcriptLoading: controller.transcriptLoading,
    transcriptHasEarlier: controller.transcriptHasEarlier,
    transcriptLoadingEarlier: controller.transcriptLoadingEarlier
  }
}

function useControllerContextUsage(controller: ChatStreamController): ContextUsageState | null {
  const [, bump] = useState(0)
  useEffect(() => controller.subscribeMeta(() => bump((n) => n + 1)), [controller])
  return controller.getContextUsage()
}

const InstanceRecord = memo(function InstanceRecord({
  controller,
  running,
  pendingRun,
  transcriptLoading,
  transcriptHasEarlier,
  transcriptLoadingEarlier,
  onLoadEarlierMessages,
  showThinking,
  onLoadToolContent,
  onApprovalDecision,
  onQuestionSubmit,
  approvalAutoFocus,
  lead
}: {
  controller: ChatStreamController
  running: boolean
  pendingRun: boolean
  transcriptLoading: boolean
  transcriptHasEarlier: boolean
  transcriptLoadingEarlier: boolean
  onLoadEarlierMessages: () => void | Promise<void>
  showThinking: boolean
  onLoadToolContent: (id: string) => Promise<string | null>
  onApprovalDecision: (
    requestId: string,
    decision: Parameters<ChatStreamController['respondToApproval']>[1]
  ) => void
  onQuestionSubmit: (requestId: string, answers: UiAgentQuestionAnswer[]) => void
  approvalAutoFocus: boolean
  /** Goal and Scope — what the instance was asked and what it may touch. */
  lead: ReactNode
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
  const items = useDeferredValue(controller.items)
  const turnUsage = useResolvedTurnUsage(metaStore, controller.turnUsage)
  const live = running || pendingRun
  const turnStatus = controller.turnStatus
  const options: BuildOptions = useMemo(
    () => ({ running: live, failed: turnStatus === 'error', showThinking }),
    [live, turnStatus, showThinking]
  )
  const model = useMemo(() => buildRecordModel(items, options), [items, options])
  const scroll = useRecordScroll({ ready: !(transcriptLoading && items.length === 0), live })
  const recordActions = useMemo(() => ({ onLoadToolContent }), [onLoadToolContent])
  const lastNeeds = live ? (model.runs[model.runs.length - 1]?.needs.length ?? 0) : 0
  return (
    <RecordActionsContext.Provider value={recordActions}>
      <RecordBody scrollRef={scroll.scrollRef} contentRef={scroll.contentRef} onScroll={scroll.onScroll}>
        {transcriptHasEarlier && items.length > 0 ? (
          <div className="flex justify-center pb-1" data-load-earlier>
            <Button
              size="xs"
              variant="ghost"
              disabled={transcriptLoadingEarlier}
              pending={transcriptLoadingEarlier}
              onClick={() => void onLoadEarlierMessages()}
            >
              {transcriptLoadingEarlier ? 'Loading earlier work…' : 'Load earlier work'}
            </Button>
          </div>
        ) : null}
        {transcriptLoading && items.length === 0 ? (
          <>
            {lead}
            <p className="flex items-center gap-2 py-3 text-sm text-muted" role="status" aria-busy="true">
              <AgentVSpinner size={13} />
              Loading the record…
            </p>
          </>
        ) : model.runs.length === 0 ? (
          lead
        ) : (
          <TaskRecord
            model={model}
            options={options}
            activity={live && lastNeeds === 0 ? (pendingRun && !running ? 'Starting' : 'Working') : null}
            turnUsage={turnUsage}
            onApprovalDecision={onApprovalDecision}
            onQuestionSubmit={onQuestionSubmit}
            approvalAutoFocus={approvalAutoFocus}
            lead={lead}
            omitFirstBrief
            workLabel="Work"
            messageCount={0}
          />
        )}
      </RecordBody>
    </RecordActionsContext.Provider>
  )
})

type AgentInstancePaneProps = {
  workspacePath: string
  instanceRunId: string
  instanceMeta?: AgentInstanceUiState
  /** Prefer workspace-manager controller so IPC is not dual-subscribed. */
  getController?: (runId: string, workspacePath: string) => ChatStreamController | null
  /** Set on the rightmost pane while the inspector is hidden: offer it back. */
  onShowInspector?: () => void
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
  /** The instance as the run list has it — its worktree branch, when isolated. */
  instanceRun?: RunSummary | null
  /** The parent task's title, for the way back. */
  parentTitle?: string
  /** The parent's instances (this one included), one click apart. */
  siblings?: Record<string, AgentInstanceUiState>
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
  onShowInspector,
  pendingGates = [],
  onOpenInstance,
  onClose,
  showThinking = true,
  onOpenWorkspaceFile,
  approvalAutoFocus = true,
  onControllerChange,
  instanceRun = null,
  parentTitle,
  siblings
}: AgentInstancePaneProps) {
  // Controller resolution must be identity-stable across renders. The WM map can
  // re-key/evict/forget entries mid-run (forgetRunRouting even disposes), and
  // adopting every identity flip re-fired onControllerChange (parent setState)
  // plus the catch-up IPC effects below — the churn behind React #185 storms.
  // Adopt a shared controller only when it is a genuinely different, live object;
  // otherwise keep the current one and create the pane-owned controller once.
  const sharedRef = useRef<{ key: string; controller: ChatStreamController | null }>({
    key: '',
    controller: null
  })
  const ownedRef = useRef<ChatStreamController | null>(null)
  const resolutionKey = `${workspacePath}\u0000${instanceRunId}`
  const sharedNow = getController?.(instanceRunId, workspacePath) ?? null
  if (sharedRef.current.key !== resolutionKey) {
    sharedRef.current = { key: resolutionKey, controller: sharedNow }
    // The prior run's pane-owned controller is disposed by the ownsIpc effect
    // cleanup when the controller identity changes below.
    ownedRef.current = null
  } else {
    const held = sharedRef.current.controller
    if (sharedNow != null && sharedNow !== held) {
      // Adopt the WM-shared controller only over nothing held or a disposed
      // one (WM always disposes before replacing — forgetRunRouting, re-key).
      // Never swap between two live shared controllers: map churn would
      // re-fire onControllerChange plus the catch-up effects per event — the
      // engine of the React #185 cascade this guard exists to break.
      if (held == null || held.disposed) {
        sharedRef.current.controller = sharedNow
      }
    } else if (held?.disposed) {
      // WM forgot the run (forgetRunRouting disposes) — fall back to owned.
      sharedRef.current.controller = null
    }
  }
  const shared = sharedRef.current.controller
  const controller = useMemo(
    () =>
      shared ??
      (ownedRef.current ??= createChatStreamController({
        workspacePath,
        runId: instanceRunId
      })),
    [shared, instanceRunId, workspacePath]
  )
  if (ownedRef.current && ownedRef.current !== controller) ownedRef.current = null
  const ownsIpc = shared == null

  // Dock surfaces (Changes panel) subscribe to the same run via this — fires on
  // mount and controller swap, reports null on unmount. Guarded so parent
  // setState can never fire from a mere re-render.
  const reportedControllerRef = useRef<ChatStreamController | null>(null)
  useEffect(() => {
    if (reportedControllerRef.current === controller) return
    reportedControllerRef.current = controller
    onControllerChange?.(controller)
    return () => {
      if (reportedControllerRef.current === controller) {
        reportedControllerRef.current = null
        onControllerChange?.(null)
      }
    }
  }, [controller, onControllerChange])

  const { running, pendingRun, transcriptLoading, transcriptHasEarlier, transcriptLoadingEarlier } =
    useControllerRunningMeta(controller)
  const contextUsage = useControllerContextUsage(controller)
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
  const waitingIds = new Set(pendingGates.map((g) => g.runId))
  const state: TaskState = running || pendingRun
    ? instancePhaseState('started', waitingIds.has(instanceRunId))
    : instancePhaseState(instanceMeta?.phase ?? (controller.turnStatus === 'error' ? 'error' : controller.turnStatus === 'cancelled' ? 'cancelled' : 'done'), false)
  const siblingIds = siblings ? Object.keys(siblings) : []
  const pathScope = instanceMeta?.pathScope ?? instanceRun?.pathScope
  const branch = instanceRun?.worktreeBranch

  const lead = (
    <>
      {fullGoal ? (
        <RecordRow label="Goal">
          <div className="text-md leading-[22px] text-fg-strong">
            <MarkdownContent content={fullGoal} />
          </div>
        </RecordRow>
      ) : null}
      <RecordRow label="Scope">
        {branch ? (
          <p className="flex items-center gap-2 text-xs text-secondary">
            <Icon name="branch" size={13} className="shrink-0 text-muted" />
            Works in its own worktree
            <span className="font-mono text-caption text-muted">{branch}</span>
          </p>
        ) : null}
        {pathScope?.length ? (
          <ul className="space-y-1">
            {pathScope.map((p) => (
              <li key={p} className="flex items-center gap-2 text-xs">
                <Icon name="folder" size={13} className="shrink-0 text-muted" />
                <span className="font-mono text-caption text-secondary">{p}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className={cn('text-xs text-tertiary', Boolean(branch || pathScope?.length) && 'mt-2')}>
          {pathScope?.length ? 'Writes only under these paths · ' : ''}Reports back to its parent · cannot start
          instances of its own
        </p>
      </RecordRow>
    </>
  )

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-bg text-fg"
      role="region"
      aria-label={`Instance ${shortId}: ${title}`}
      data-agent-instance-session={instanceRunId}
      data-chat-stage
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2 text-xs" data-instance-header="">
        <IconButton
          icon="arrowLeft"
          label={parentTitle ? `Back to ${parentTitle}` : 'Back to the parent task'}
          size="sm"
          onClick={onClose}
        />
        {parentTitle ? (
          <>
            <span className="min-w-0 max-w-[220px] truncate text-muted" title={parentTitle}>
              {parentTitle}
            </span>
            <Icon name="chevronRight" size={11} className="shrink-0 text-tertiary" />
          </>
        ) : null}
        <span className="shrink-0">
          <StatusGlyph state={state} size={14} label />
        </span>
        <h1 className="min-w-0 truncate text-sm font-semibold text-fg-strong" title={tooltip}>
          {title}
        </h1>
        <span className="shrink-0 font-mono text-caption text-tertiary" title="Instance id">
          {shortId}
        </span>
        <span className="flex-1" />
        {siblingIds.length > 1 && onOpenInstance
          ? siblingIds.map((id) => {
              const key = formatAgentInstanceShortId(id)
              const current = id === instanceRunId
              const sibling = siblings![id]!
              return (
                <button
                  key={id}
                  type="button"
                  title={`Instance ${key} · ${instanceDisplayTitle(sibling.goal, id, sibling.pathScope)}`}
                  aria-current={current ? 'page' : undefined}
                  onClick={() => {
                    if (!current) onOpenInstance(id)
                  }}
                  className={cn(
                    'inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 font-mono text-2xs vy-transition focus-visible:vy-focus-ring',
                    current ? 'bg-surface-2 text-fg-strong' : 'text-muted hover:bg-surface'
                  )}
                >
                  <StatusGlyph state={instancePhaseState(sibling.phase, waitingIds.has(id))} size={10} />
                  {key}
                </button>
              )
            })
          : null}
        <ContextMeter usage={contextUsage} />
        {running ? (
          <Button size="xs" variant="ghost" icon="stop" aria-label="Stop instance" onClick={onStopInstance}>
            Stop
          </Button>
        ) : null}
        {onShowInspector ? (
          <IconButton
            icon="inspector"
            label={`Show inspector (${shortcutLabel('inspector')})`}
            size="sm"
            tone="muted"
            onClick={onShowInspector}
          />
        ) : null}
      </header>
      {loadError ? (
        <div className="shrink-0 border-b border-border px-4 py-2 text-xs text-danger" role="alert">
          {loadError}
        </div>
      ) : null}
      <RunSessionProvider value={runSession}>
        <InstanceRecord
          controller={controller}
          running={running}
          pendingRun={pendingRun}
          transcriptLoading={transcriptLoading}
          transcriptHasEarlier={transcriptHasEarlier}
          transcriptLoadingEarlier={transcriptLoadingEarlier}
          onLoadEarlierMessages={() => {
            void controller.loadEarlierMessages()
          }}
          showThinking={showThinking}
          onLoadToolContent={onLoadToolContent}
          onApprovalDecision={onApprovalDecision}
          onQuestionSubmit={onQuestionSubmit}
          approvalAutoFocus={approvalAutoFocus}
          lead={lead}
        />
      </RunSessionProvider>
      <div className="flex h-11 shrink-0 items-center gap-2 border-t border-border px-4 text-xs text-muted">
        <Icon name="lock" size={13} className="shrink-0" />
        <span className="min-w-0 truncate">Instances take instructions from their parent task.</span>
        <button
          type="button"
          onClick={() => {
            onClose()
            requestAnimationFrame(() => requestAnimationFrame(() => focusComposerMessage()))
          }}
          className="shrink-0 rounded-sm font-medium text-accent hover:underline focus-visible:vy-focus-ring"
        >
          Add an instruction to the parent
        </button>
      </div>
    </div>
  )
}
