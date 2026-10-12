import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChatMessage, RunSummary } from '@shared/ipc'
import type { UiAgentQuestionAnswer } from '@shared/transcript'
import type { AgentInstanceUiState } from '@shared/utils/agentInstance'
import { briefOutcome, formatAgentInstanceShortId } from '@shared/utils/agentInstance'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { instanceDisplayTitle, stripGoalMarkdown } from '@renderer/app/navigator/runTitle'
import type { InlineInstanceGate } from '../hooks/useInlineInstanceUi'
import { RunSessionProvider, useRunSession } from '../RunSessionContext'
import type { WorkspaceFileOpenOptions } from './FilesPanel'
import {
  createChatStreamController,
  type ChatStreamController
} from '@renderer/lib/hooks/createChatStreamController'
import { useEscapeToClose } from '@renderer/lib/hooks/useEscapeToClose'
import { stripEdgeMask, useStripEdges } from '@renderer/lib/hooks/useStripEdges'
import { Icon } from '@renderer/lib/icons'
import { AgentVSpinner } from '@renderer/lib/brand'
import { Button, IconButton, StatusGlyph, cn, type TaskState } from '@renderer/lib/ui'
import { focusComposerMessage, shortcutLabel } from '@renderer/lib/shortcuts'
import { draftIntoComposer } from './composer/composerMentionEvent'
import { openInEditor } from '@renderer/lib/openInEditor'
import type { InspectorToggle } from '@renderer/features/inspector/inspectorToggle'
import type { ContextUsageState } from '@shared/utils/contextUsage'
import { ContextMeter } from './composer/ContextMeter'
import { useResolvedTurnUsage } from './ChatStreamLeaves'
import { buildRecordModel, type BuildOptions } from '@renderer/features/task/recordModel'
import { RecordBody, RecordRow } from '@renderer/features/task/record/RecordLayout'
import { RecordProse } from '@renderer/features/task/record/RecordProse'
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
    decision: Parameters<ChatStreamController['respondToApproval']>[1],
    extras?: Parameters<ChatStreamController['respondToApproval']>[2]
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
  const turnUsage = useResolvedTurnUsage(metaStore, controller.turnUsage)
  const liveItems = controller.items
  const liveNow = running || pendingRun
  const failedNow = controller.turnStatus === 'error'
  const stoppedNow = controller.turnStatus === 'cancelled' || controller.turnStatus === 'interrupted'
  // Items render deferred; the run's liveness defers with them so no frame
  // pairs new items with the old run state (see TaskPane).
  const recordInput = useMemo(
    () => ({ items: liveItems, live: liveNow, failed: failedNow, stopped: stoppedNow }),
    [liveItems, liveNow, failedNow, stoppedNow]
  )
  const deferred = useDeferredValue(recordInput)
  const items = deferred.items
  const live = deferred.live
  const options: BuildOptions = useMemo(
    () => ({ running: deferred.live, failed: deferred.failed, stopped: deferred.stopped, showThinking }),
    [deferred, showThinking]
  )
  const model = useMemo(() => buildRecordModel(items, options), [items, options])
  const scroll = useRecordScroll({
    ready: !(transcriptLoading && items.length === 0),
    live
  })
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
  /** Set on the rightmost pane: its header toggles the inspector. */
  inspectorToggle?: InspectorToggle
  /** Parent-tracked approval/question gates (visible while nested in this pane). */
  pendingGates?: InlineInstanceGate[]
  onOpenInstance?: (runId: string) => void
  /** Leave the sub-session and return to the parent chat. */
  onClose: () => void
  /** Close this pane — only when it is one of several side by side. */
  onClosePane?: () => void
  showThinking?: boolean
  onOpenWorkspaceFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
  approvalAutoFocus?: boolean
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
  inspectorToggle,
  pendingGates = [],
  onOpenInstance,
  onClose,
  onClosePane,
  showThinking = true,
  onOpenWorkspaceFile,
  approvalAutoFocus = true,
  instanceRun = null,
  parentTitle,
  siblings
}: AgentInstancePaneProps) {
  // Controller resolution must be identity-stable across renders. The WM map can
  // re-key/evict/forget entries mid-run (forgetRunRouting even disposes), and
  // adopting every identity flip re-fired the catch-up IPC effects below — the
  // churn behind React #185 storms.
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
      // re-fire the catch-up effects per event — the engine of the React #185
      // cascade this guard exists to break.
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
    const unsubscribe = window.vyotiq.onAgentQuestionRequest((request) => {
      if (request.runId !== instanceRunId) return
      controller.handleQuestionRequest(request)
    })
    // A question pushed between the initial list and this subscription would
    // otherwise be missed; re-read now that the listener is live.
    void controller.refreshPendingQuestions(instanceRunId)
    return unsubscribe
  }, [controller, instanceRunId, liveReady, ownsIpc])

  useEffect(() => {
    if (!ownsIpc) return
    return () => {
      controller.dispose()
    }
  }, [controller, ownsIpc])

  useEscapeToClose(onClose, true, { deferToMenus: true })

  const onApprovalDecision = useCallback(
    (
      requestId: string,
      decision: Parameters<typeof controller.respondToApproval>[1],
      extras?: Parameters<typeof controller.respondToApproval>[2]
    ) => controller.respondToApproval(requestId, decision, extras),
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

  // A child's commands land in the same workspace mirror as its parent's; the
  // Terminal tab lists the inspector's workspace, so only offer it for that one.
  const inspector = useRunSession()
  const onOpenAgentTerminal =
    inspector.workspacePath != null && workspacePathsEqual(inspector.workspacePath, workspacePath)
      ? inspector.onOpenAgentTerminal
      : undefined
  const runSession = useMemo(
    () => ({
      workspacePath,
      runId: instanceRunId,
      onOpenWorkspaceFile,
      onOpenAgentTerminal
    }),
    [workspacePath, instanceRunId, onOpenWorkspaceFile, onOpenAgentTerminal]
  )

  const shortId = formatAgentInstanceShortId(instanceRunId)
  // The brief it was given. A child started before its start event carried
  // the brief has only its background there; its first message has the brief.
  const fullGoal =
    briefOutcome(goalFromDisk) && !briefOutcome(instanceMeta?.goal) ? goalFromDisk : (instanceMeta?.goal ?? goalFromDisk)
  // Named as the navigator names it: by its step, as the parent's plan titles it now.
  const title = instanceDisplayTitle(
    fullGoal,
    instanceRunId,
    instanceMeta?.pathScope,
    instanceRun?.stepTitle ?? instanceMeta?.stepTitle
  )
  const tooltip = fullGoal ? stripGoalMarkdown(fullGoal) || fullGoal : instanceRunId
  const waitingIds = new Set(pendingGates.map((g) => g.runId))
  const state: TaskState = running || pendingRun
    ? instancePhaseState('started', waitingIds.has(instanceRunId))
    : instancePhaseState(instanceMeta?.phase ?? (controller.turnStatus === 'error' ? 'error' : controller.turnStatus === 'cancelled' ? 'cancelled' : 'done'), false)
  /** Still working: the parent can still redirect it. */
  const childRunning = Boolean(running || pendingRun)
  const siblingIds = siblings ? Object.keys(siblings) : []
  const showSiblings = siblingIds.length > 1 && Boolean(onOpenInstance)
  const siblingStripRef = useRef<HTMLDivElement>(null)
  const siblingEdges = useStripEdges(siblingStripRef, `${instanceRunId}:${siblingIds.length}`, { current: '[aria-current="page"]' })
  const pathScope = instanceMeta?.pathScope ?? instanceRun?.pathScope
  const branch = instanceRun?.worktreeBranch

  const lead = (
    <>
      {fullGoal ? (
        <RecordRow label="Goal">
          {/* The parent agent wrote it: read as its other words are, paths open. */}
          <RecordProse text={fullGoal} size="md" tone="strong" />
        </RecordRow>
      ) : null}
      <RecordRow label="Scope">
        {branch ? (
          <p className="flex items-center gap-2 text-xs text-secondary">
            <Icon name="branch" size={13} className="shrink-0 text-muted" />
            Works in its own worktree
            <span className="font-mono text-caption text-muted">{branch}</span>
            {instanceRun?.worktreePath ? (
              <Button
                size="xs"
                variant="ghost"
                icon="code"
                onClick={() =>
                  void openInEditor({ workspacePath, worktreePath: instanceRun.worktreePath })
                }
              >
                Open in editor
              </Button>
            ) : null}
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
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4 text-xs" data-instance-header="">
        <IconButton
          icon="arrowLeft"
          label={parentTitle ? `Back to ${parentTitle}` : 'Back to the parent task'}
          size="xs"
          onClick={onClose}
        />
        {parentTitle ? (
          <>
            <span className="min-w-0 max-w-[220px] shrink-[4] truncate text-muted" title={parentTitle}>
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
        {/* With siblings, the current chip says the id (and is kept in view). */}
        {showSiblings ? null : (
          <span className="shrink-0 font-mono text-caption text-tertiary" title="Instance id">
            {shortId}
          </span>
        )}
        {/* The siblings take what the title leaves (it is what the pane is):
            past that they scroll, an edge with more past it fades, and the
            one you're on stays in view. */}
        <div
          ref={siblingStripRef}
          className={cn(
            'flex flex-1 basis-0 self-stretch overflow-x-auto [scrollbar-width:none]',
            showSiblings ? 'min-w-14' : 'min-w-0',
            stripEdgeMask(siblingEdges)
          )}
          data-instance-siblings=""
        >
          {showSiblings && onOpenInstance ? (
            <div className="ml-auto flex w-max items-center gap-0.5 px-0.5" role="group" aria-label="Instances of this task">
              {siblingIds.map((id) => {
                const key = formatAgentInstanceShortId(id)
                const current = id === instanceRunId
                const sibling = siblings![id]!
                return (
                  <button
                    key={id}
                    type="button"
                    title={`Instance ${key} · ${instanceDisplayTitle(sibling.goal, id, sibling.pathScope, sibling.stepTitle)}`}
                    aria-current={current ? 'page' : undefined}
                    onClick={() => {
                      if (!current) onOpenInstance(id)
                    }}
                    className={cn(
                      'inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 font-mono text-caption vy-transition focus-visible:vy-focus-ring',
                      current ? 'bg-surface-2 text-fg-strong' : 'text-muted hover:bg-surface'
                    )}
                  >
                    <StatusGlyph state={instancePhaseState(sibling.phase, waitingIds.has(id))} size={10} />
                    {key}
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>
        <ContextMeter usage={contextUsage} />
        {running || pendingRun ? (
          <Button size="xs" variant="ghost" icon="stop" aria-label="Stop instance" onClick={onStopInstance}>
            Stop
          </Button>
        ) : null}
        {inspectorToggle ? (
          <IconButton
            icon="inspector"
            label={`${inspectorToggle.open ? 'Hide' : 'Show'} inspector (${shortcutLabel('inspector')})`}
            size="xs"
            tone="muted"
            active={inspectorToggle.open}
            aria-expanded={inspectorToggle.open}
            // Its words and aria-expanded say the state; pressed would say it a third time.
            aria-pressed={undefined}
            onClick={inspectorToggle.onToggle}
            data-inspector-toggle
          />
        ) : null}
        {onClosePane ? <IconButton icon="close" label={`Close ${title}`} size="xs" tone="muted" onClick={onClosePane} /> : null}
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
        <span className="min-w-0 truncate">
          {childRunning
            ? 'Instances take instructions from their parent task, which can redirect this one.'
            : 'Instances take instructions from their parent task.'}
        </span>
        <Button
          size="xs"
          variant="ghost"
          onClick={(event) => {
            // This pane goes back to the parent task: focus its instruction
            // line, not the first one on the page (the leftmost of a split).
            const pane = event.currentTarget.closest('[data-chat-pane]')
            const parentRunId = instanceRun?.parentRunId ?? null
            onClose()
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                // A running child: start the instruction for the parent, which
                // passes it on with message_agent_instance and keeps the work.
                if (childRunning && parentRunId) {
                  draftIntoComposer({
                    workspacePath,
                    runId: parentRunId,
                    text: `Tell instance ${formatAgentInstanceShortId(instanceRunId)} (run_id ${instanceRunId}) to `
                  })
                }
                if (!(pane?.isConnected && focusComposerMessage(pane))) focusComposerMessage()
              })
            )
          }}
        >
          {childRunning ? 'Redirect it from the parent' : 'Add an instruction to the parent'}
        </Button>
      </div>
    </div>
  )
}
