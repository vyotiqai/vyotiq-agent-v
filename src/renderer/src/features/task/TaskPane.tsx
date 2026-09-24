import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref
} from 'react'
import type { RunFeedbackRating, RunGoal, RunLoop, RunSummary, ToolApprovalDecision } from '@shared/ipc'
import type { TurnOutcome, UiAgentQuestionAnswer, UiItem } from '@shared/transcript'
import type { StepUsageTotals } from '@shared/utils/runTelemetry'
import { Icon } from '@renderer/lib/icons'
import { AgentVSpinner } from '@renderer/lib/brand'
import { ActionMenu, Button, IconButton, ImageLightbox, cn } from '@renderer/lib/ui'
import { isEditableShortcutTarget, isMainComposerTarget, matchShortcut, shortcutLabel } from '@renderer/lib/shortcuts'
import { isChangesOrPrDockClaimingFind } from '@renderer/lib/chat/transcriptFind'
import { useChatLiveItems, useResolvedTurnUsage } from '@renderer/features/chat/components/ChatStreamLeaves'
import { AgentContextCard } from '@renderer/features/chat/components/AgentContextCard'
import { GoalRunBanner } from '@renderer/features/chat/components/GoalRunBanner'
import { useGitStatus } from '@renderer/features/chat/components/useGitStatus'
import { useRunTodos } from '@renderer/features/chat/hooks/useRunTodos'
import type { InlineInstanceGate } from '@renderer/features/chat/hooks/useInlineInstanceUi'
import { formatRunActivityLabel } from '@renderer/features/chat/utils/runActivity'
import type { ChatItemsStore, ChatMetaStore } from '@renderer/features/chat/chatStores'
import { taskHeaderState } from '@renderer/app/navigator/navigatorModel'
import { runTitle } from '@renderer/app/navigator/runTitle'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { buildRecordModel, type BuildOptions } from './recordModel'
import { RecordBody, TaskHeader } from './record/RecordLayout'
import { RecordActionsContext } from './record/WorkItems'
import { TaskRecord } from './TaskRecord'
import { clearMatches, findRanges, foldsToOpen, paintMatches, RecordOpenContext } from './recordFind'
import { useRecordScroll } from './useRecordScroll'
import { useRunChecks } from './useRunChecks'

export type TaskPaneRunActions = {
  onRename?: (title: string) => void | Promise<void>
  onExport?: () => void
  onCopyLink?: () => void
  onDelete?: () => void
  /** Open another task beside this one. */
  onSplit?: () => void
  /** Close this pane (only when there is more than one). */
  onClosePane?: () => void
}

export type TaskPaneProps = {
  workspacePath: string | null
  runId: string | null
  items: UiItem[]
  itemsStore?: ChatItemsStore
  metaStore?: ChatMetaStore
  running: boolean
  pendingRun: boolean
  turnFailed: boolean
  turnStatus: TurnOutcome | null
  networkWait?: { attempt: number; maxAttempts: number; retryInMs: number; code?: string; message?: string } | null
  compacting: boolean
  showThinking: boolean
  /** The run as the workspace's run list has it; null until it is listed. */
  run: RunSummary | null
  transcriptLoading?: boolean
  transcriptHasEarlier?: boolean
  transcriptLoadingEarlier?: boolean
  onLoadEarlier?: () => void | Promise<void>
  restoreScrollTop?: number
  scrollRestoreToken?: number
  onScrollTopChange?: (scrollTop: number) => void
  onActivate?: () => void
  headingRef?: Ref<HTMLHeadingElement>
  onStop: () => void
  actions: TaskPaneRunActions
  turnUsage?: readonly StepUsageTotals[]
  runFeedback?: { value: RunFeedbackRating | null; onRate: (rating: RunFeedbackRating | null) => void }
  onApprovalDecision?: (requestId: string, decision: ToolApprovalDecision) => void | Promise<void>
  onQuestionSubmit?: (requestId: string, answers: UiAgentQuestionAnswer[]) => void | Promise<void>
  approvalAutoFocus?: boolean
  instanceGates?: readonly InlineInstanceGate[]
  onOpenInstance?: (instanceRunId: string) => void
  editingUserMessageIndex?: number | null
  editComposer?: ReactNode
  onBeginEdit?: (messageIndex: number) => void
  onRevert?: (messageIndex: number) => void
  messageCount: number
  onOpenChanges?: (path?: string) => void
  onLoadToolContent?: (toolCallId: string) => Promise<string | null>
  mcpServerNames?: ReadonlyMap<string, string>
  goal?: RunGoal | null
  loop?: RunLoop | null
  onGoalPause?: () => void | Promise<boolean>
  onGoalResume?: () => void | Promise<boolean>
  onGoalComplete?: () => void | Promise<boolean>
  onGoalActivate?: () => void | Promise<boolean>
  onGoalDismiss?: () => void | Promise<boolean>
  onStopLoop?: () => void | Promise<boolean>
  /** The instruction line. */
  composer: ReactNode
  /** Set on the rightmost pane while the inspector is hidden: offer it back. */
  onShowInspector?: () => void
  /** Not started yet: the composer (its brief variant) is the whole pane. */
  newTask?: boolean
}

const NO_FOLDS: ReadonlySet<string> = new Set()

/** Bumps each time a run ends, so git state is re-read at the moments it changes. */
function useRunEndRevision(live: boolean): number {
  const [revision, setRevision] = useState(0)
  const wasLive = useRef(live)
  useEffect(() => {
    if (wasLive.current && !live) setRevision((r) => r + 1)
    wasLive.current = live
  }, [live])
  return revision
}

/**
 * A task: the 40px header, the record, and the instruction line — the whole
 * pane. Everything shown is read from the run's own stream, its files on disk
 * and the run list; nothing is kept here that those do not say.
 */
/**
 * The pane's own controls at the end of its header: the inspector, when it is
 * hidden, and closing this pane of a split — named for the task, so each pane
 * says which one closes.
 */
export function PaneHeaderActions({
  title,
  onShowInspector,
  onClosePane
}: {
  title: string
  onShowInspector?: () => void
  onClosePane?: () => void
}) {
  return (
    <>
      {onShowInspector ? (
        <IconButton
          icon="inspector"
          label={`Show inspector (${shortcutLabel('inspector')})`}
          size="sm"
          tone="muted"
          onClick={onShowInspector}
        />
      ) : null}
      {onClosePane ? <IconButton icon="close" label={`Close ${title}`} size="sm" tone="muted" onClick={onClosePane} /> : null}
    </>
  )
}

export function TaskPane(props: TaskPaneProps) {
  const { workspacePath, runId, running, pendingRun, showThinking } = props
  const live = running || pendingRun
  const liveItems = useChatLiveItems(props.itemsStore, props.items)
  const items = useDeferredValue(liveItems)
  const turnUsage = useResolvedTurnUsage(props.metaStore, props.turnUsage)
  const todos = useRunTodos({ workspacePath, runId, running: live, active: true })
  const liveTodos = live ? (todos.data?.items ?? null) : null

  const options: BuildOptions = useMemo(
    () => ({ running: live, failed: props.turnFailed, showThinking, liveTodos }),
    [live, props.turnFailed, showThinking, liveTodos]
  )
  const model = useMemo(() => buildRecordModel(items, options), [items, options])
  const last = model.runs[model.runs.length - 1] ?? null

  // checks.json changes only when create_plan or check_done_when finishes (or
  // a rewind drops one): re-read it then, never on a timer.
  const checksRevision = useMemo(() => {
    let n = 0
    let lastId = ''
    for (const item of items) {
      if (item.kind !== 'tool' || item.tool.status === 'running') continue
      if (item.tool.name !== 'create_plan' && item.tool.name !== 'check_done_when') continue
      n += 1
      lastId = item.id
    }
    return `${n}:${lastId}:${live ? 1 : 0}`
  }, [items, live])
  const checks = useRunChecks(workspacePath, runId, checksRevision)

  // ── Header ────────────────────────────────────────────────────────────
  const firstNeed = live ? (last?.needs[0] ?? null) : null
  const liveSteps = last?.steps ?? []
  const liveStepAt = liveSteps.findIndex((s) => s.state === 'running' || s.state === 'needs')
  const doneSteps = liveSteps.filter((s) => s.state === 'done').length
  const header = taskHeaderState({
    run: props.run,
    streaming: live,
    // Its own request first; else a sub-agent of this task waiting on you.
    needs: firstNeed
      ? { kind: firstNeed.kind, since: firstNeed.at }
      : live && props.instanceGates?.[0]
        ? { kind: props.instanceGates[0].kind, since: null }
        : null,
    steps:
      live && liveSteps.length > 0
        ? { current: liveStepAt >= 0 ? liveStepAt + 1 : Math.min(doneSteps + 1, liveSteps.length), total: liveSteps.length }
        : null,
    turnStatus: props.turnStatus,
    started: model.runs.length > 0
  })
  const title = props.run ? runTitle(props.run) : last?.text.split('\n')[0]?.trim() || (runId ? 'Task' : 'New task')

  // A task not started yet says where it will run; the context card below
  // reads its branch, so the header does not repeat it.
  const draft = !runId && model.runs.length === 0

  const gitRevision = useRunEndRevision(live)
  const git = useGitStatus(workspacePath, gitRevision, Boolean(workspacePath) && !draft && !props.run?.worktreeBranch)
  const branch = props.run?.worktreeBranch ?? git.status?.branch ?? null
  const facts = draft
    ? workspacePath
      ? [{ text: `in ${formatWorkspaceName(workspacePath)}`, title: workspacePath }]
      : []
    : branch
      ? [{ text: branch, mono: true, title: props.run?.worktreeBranch ? 'Worktree branch' : 'Branch' }]
      : []

  const [renaming, setRenaming] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuItems = [
    ...(props.actions.onRename && runId ? [{ id: 'rename', label: 'Rename', icon: 'edit' as const, onSelect: () => setRenaming(true) }] : []),
    ...(props.actions.onExport && runId
      ? [{ id: 'export', label: 'Export as Markdown', icon: 'download' as const, onSelect: props.actions.onExport }]
      : []),
    ...(props.actions.onCopyLink && runId
      ? [{ id: 'link', label: 'Copy link', icon: 'link' as const, onSelect: props.actions.onCopyLink }]
      : []),
    ...(props.actions.onSplit && runId
      ? [{ id: 'split', label: 'Open a task beside', icon: 'columns' as const, onSelect: props.actions.onSplit }]
      : []),
    // A live run cannot be deleted (main refuses: "Cancel run first") — stop it first.
    ...(props.actions.onDelete && runId && !live
      ? [{ id: 'delete', label: 'Delete', icon: 'trash' as const, danger: true, separatorBefore: true, onSelect: props.actions.onDelete }]
      : [])
  ]

  // ── Find in record ────────────────────────────────────────────────────
  const findId = useId()
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIndex, setFindIndex] = useState(0)
  const [findCount, setFindCount] = useState(0)
  const findInputRef = useRef<HTMLInputElement>(null)
  const scrolledToRef = useRef<string | null>(null)
  // Stable unless find is open, and unchanged while its contents are: every
  // step reads it through context, so a new Set per streamed token would
  // re-render them all.
  const runsForFind = findOpen ? model.runs : null
  const foldsRef = useRef<ReadonlySet<string>>(NO_FOLDS)
  const folds = useMemo(() => {
    const next = runsForFind && findQuery.trim() ? foldsToOpen(runsForFind, findQuery) : NO_FOLDS
    const prev = foldsRef.current
    if (next.size === prev.size && [...next].every((k) => prev.has(k))) return prev
    foldsRef.current = next
    return next
  }, [runsForFind, findQuery])

  const scroll = useRecordScroll({
    restoreScrollTop: props.restoreScrollTop,
    restoreToken: props.scrollRestoreToken,
    onScrollTopChange: props.onScrollTopChange,
    ready: !(props.transcriptLoading && items.length === 0),
    live
  })

  const closeFind = useCallback(() => {
    setFindOpen(false)
    setFindQuery('')
    scrolledToRef.current = null
    clearMatches(findId)
  }, [findId])

  // Mark matches after the folds they need have opened.
  useLayoutEffect(() => {
    const root = scroll.contentRef.current
    if (!findOpen || !root) {
      clearMatches(findId)
      setFindCount(0)
      return
    }
    const ranges = findRanges(root, findQuery)
    setFindCount(ranges.length)
    const at = ranges.length > 0 ? ((findIndex % ranges.length) + ranges.length) % ranges.length : 0
    paintMatches(findId, ranges, at)
    // Move to the match only when the query or the step through matches
    // changed — a live run repainting the marks must not pull the view along.
    const where = `${findQuery}\u0000${findIndex}`
    if (scrolledToRef.current === where) return
    scrolledToRef.current = where
    ranges[at]?.startContainer.parentElement?.scrollIntoView({ block: 'center' })
  }, [findOpen, findQuery, findIndex, folds, items, findId, scroll.contentRef])

  useEffect(() => () => clearMatches(findId), [findId])

  useEffect(() => {
    if (findOpen) {
      findInputRef.current?.focus()
      findInputRef.current?.select()
    }
  }, [findOpen])

  // Ctrl F in this pane opens find; F3 / Shift F3 step through matches.
  useEffect(() => {
    const paneOwns = (target: EventTarget | null): boolean => {
      const el = scroll.scrollRef.current
      if (!el) return false
      const pane = el.closest('[data-chat-pane]')
      if (pane?.getAttribute('data-chat-pane-focused') === '0') return false
      const t = target instanceof Element ? target : null
      const other = t?.closest('[data-transcript-scroll]')
      return !other || other === el
    }
    const onKey = (e: KeyboardEvent): void => {
      if (matchShortcut(e, 'find')) {
        const t = e.target instanceof Element ? e.target : null
        if (t?.closest('[data-record-find]')) {
          e.preventDefault()
          findInputRef.current?.select()
          return
        }
        if (isEditableShortcutTarget(e.target) && !isMainComposerTarget(e.target)) return
        if (isChangesOrPrDockClaimingFind() && !isMainComposerTarget(e.target)) return
        if (!paneOwns(e.target)) return
        e.preventDefault()
        setFindOpen(true)
        findInputRef.current?.select()
        return
      }
      if (findOpen && e.key === 'F3' && paneOwns(e.target)) {
        e.preventDefault()
        setFindIndex((i) => i + (e.shiftKey ? -1 : 1))
      }
    }
    const onCommand = (event: Event): void => {
      if ((event as CustomEvent<{ id?: string }>).detail?.id === 'find' && paneOwns(null)) setFindOpen(true)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('vyotiq:command', onCommand)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('vyotiq:command', onCommand)
    }
  }, [findOpen, scroll.scrollRef])

  // ── A new request for you comes into view in the focused pane ─────────
  const { jumpTop } = scroll
  const needsKey = firstNeed ? (firstNeed.kind === 'approval' ? firstNeed.approval.requestId : firstNeed.question.requestId) : null
  const gateKey = props.instanceGates?.[0]?.runId ?? null
  const shownNeedRef = useRef<string | null>(null)
  useEffect(() => {
    const key = needsKey ?? gateKey
    if (!key || key === shownNeedRef.current || !props.approvalAutoFocus) return
    shownNeedRef.current = key
    jumpTop()
  }, [needsKey, gateKey, props.approvalAutoFocus, jumpTop])

  // ── What the live run is doing when its work does not say ─────────────
  const activity = !live
    ? null
    : props.compacting
      ? formatRunActivityLabel({ kind: 'compacting' })
      : props.networkWait
        ? formatRunActivityLabel({
            kind: 'reconnecting',
            attempt: props.networkWait.attempt,
            maxAttempts: props.networkWait.maxAttempts,
            ...(props.networkWait.message ? { reason: props.networkWait.message } : {})
          })
        : firstNeed
          ? null
          : pendingRun && !running
            ? 'Starting'
            : formatRunActivityLabel({ kind: 'working' })

  const [lightbox, setLightbox] = useState<string | null>(null)
  const recordActions = useMemo(
    () => ({
      onOpenChanges: props.onOpenChanges,
      onLoadToolContent: props.onLoadToolContent,
      mcpServerNames: props.mcpServerNames
    }),
    [props.onOpenChanges, props.onLoadToolContent, props.mcpServerNames]
  )

  const showGoal = Boolean(
    props.goal && props.goal.status !== 'complete' && props.onGoalPause && props.onGoalResume && props.onGoalComplete
  )
  const empty = items.length === 0
  const loading = Boolean(props.transcriptLoading) && empty

  // A task not started yet is its brief; the composer draws the whole page.
  if (props.newTask) {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col bg-bg" data-chat-stage data-task-pane>
        {props.composer}
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-bg" data-chat-stage data-task-pane>
      <TaskHeader
        state={header?.state ?? null}
        stateLabel={header?.label}
        title={title}
        headingRef={props.headingRef}
        editor={
          renaming ? (
            <RenameField
              initial={title}
              onDone={(next) => {
                setRenaming(false)
                if (next && next !== title) void props.actions.onRename?.(next)
              }}
            />
          ) : undefined
        }
        facts={facts}
        actions={
          <>
            {live ? (
              <Button size="xs" variant="ghost" icon="stop" title="Stop the run (Esc)" onClick={props.onStop}>
                Stop
              </Button>
            ) : null}
            {menuItems.length > 0 ? (
              <ActionMenu
                open={menuOpen}
                onOpenChange={setMenuOpen}
                placement="down"
                align="end"
                aria-label="Task actions"
                items={menuItems}
                trigger={(t) => (
                  <IconButton
                    ref={t.ref}
                    icon="more"
                    label="More — rename, export, copy link, delete"
                    size="sm"
                    aria-expanded={t['aria-expanded']}
                    aria-controls={t['aria-controls']}
                    aria-haspopup={t['aria-haspopup']}
                    onClick={t.onClick}
                  />
                )}
              />
            ) : null}
            <PaneHeaderActions title={title} onShowInspector={props.onShowInspector} onClosePane={props.actions.onClosePane} />
          </>
        }
      />
      {findOpen ? (
        <div
          className="flex h-9 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2 text-xs"
          data-record-find
        >
          <Icon name="search" size={13} className="shrink-0 text-muted" />
          <input
            ref={findInputRef}
            type="text"
            role="searchbox"
            value={findQuery}
            onChange={(e) => {
              setFindQuery(e.target.value)
              setFindIndex(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                closeFind()
              } else if (e.key === 'Enter') {
                e.preventDefault()
                setFindIndex((i) => i + (e.shiftKey ? -1 : 1))
              }
            }}
            placeholder="Find in record"
            aria-label="Find in record"
            className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-tertiary"
          />
          {findQuery.trim() ? (
            <span className="shrink-0 font-mono text-caption text-muted tnum" role="status">
              {findCount === 0
                ? 'No matches'
                : `${(((findIndex % findCount) + findCount) % findCount) + 1} of ${findCount}`}
            </span>
          ) : null}
          <IconButton
            icon="arrowUp"
            label="Previous match (Shift+Enter)"
            size="sm"
            tone="muted"
            disabled={findCount === 0}
            onClick={() => setFindIndex((i) => i - 1)}
          />
          <IconButton
            icon="arrowDown"
            label="Next match (Enter)"
            size="sm"
            tone="muted"
            disabled={findCount === 0}
            onClick={() => setFindIndex((i) => i + 1)}
          />
          <IconButton icon="close" label="Close find (Esc)" size="sm" tone="muted" onClick={closeFind} />
        </div>
      ) : null}
      <RecordActionsContext.Provider value={recordActions}>
        <RecordOpenContext.Provider value={folds}>
          <RecordBody
            scrollRef={scroll.scrollRef}
            contentRef={scroll.contentRef}
            onScroll={scroll.onScroll}
            onActivate={props.onActivate}
          >
            {props.transcriptHasEarlier && !empty ? (
              <div className="flex justify-center pb-1" data-load-earlier>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={props.transcriptLoadingEarlier || !props.onLoadEarlier}
                  pending={props.transcriptLoadingEarlier}
                  onClick={() => void props.onLoadEarlier?.()}
                >
                  {props.transcriptLoadingEarlier ? 'Loading earlier runs…' : 'Load earlier runs'}
                </Button>
              </div>
            ) : null}
            {loading ? (
              <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted" role="status" aria-busy="true">
                <AgentVSpinner size={14} />
                Loading the record…
              </div>
            ) : empty && !live ? (
              <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-sm text-muted" data-chat-empty-state>
                {workspacePath ? <AgentContextCard workspacePath={workspacePath} /> : null}
              </div>
            ) : (
              <TaskRecord
                model={model}
                options={options}
                activity={activity}
                checks={checks}
                turnUsage={turnUsage}
                runFeedback={props.runFeedback}
                onApprovalDecision={props.onApprovalDecision}
                onQuestionSubmit={props.onQuestionSubmit}
                approvalAutoFocus={props.approvalAutoFocus}
                instanceGates={props.instanceGates}
                onOpenInstance={props.onOpenInstance}
                editingUserMessageIndex={props.editingUserMessageIndex}
                editComposer={props.editComposer}
                onBeginEdit={props.onBeginEdit}
                onRevert={props.onRevert}
                messageCount={props.messageCount}
                onImageClick={setLightbox}
              />
            )}
            {props.transcriptLoading && !empty ? (
              <p className="flex items-center gap-2 py-2 text-xs text-muted" role="status" aria-busy="true">
                <AgentVSpinner size={11} />
                Loading the record…
              </p>
            ) : null}
          </RecordBody>
        </RecordOpenContext.Provider>
      </RecordActionsContext.Provider>
      {showGoal && props.goal ? (
        <GoalRunBanner
          goal={props.goal}
          loop={props.loop ?? null}
          running={running}
          onPause={props.onGoalPause!}
          onResume={props.onGoalResume!}
          onComplete={props.onGoalComplete!}
          onActivate={props.onGoalActivate}
          onDismiss={props.onGoalDismiss}
          onStopLoop={props.onStopLoop ?? (async () => false)}
          onStopRun={props.onStop}
        />
      ) : null}
      {props.composer}
      {lightbox ? <ImageLightbox url={lightbox} label="Attached image" onClose={() => setLightbox(null)} /> : null}
    </div>
  )
}

/** The title as an input: Enter keeps it, Esc or leaving without a change drops it. */
function RenameField({ initial, onDone }: { initial: string; onDone: (next: string | null) => void }) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  // Enter then the blur of unmounting must not rename twice.
  const doneRef = useRef(false)
  const finish = (next: string | null): void => {
    if (doneRef.current) return
    doneRef.current = true
    onDone(next)
  }
  useLayoutEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      value={value}
      aria-label="Task title"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(value.trim() || null)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          finish(null)
        }
      }}
      onBlur={() => finish(value.trim() || null)}
      className="h-7 min-w-0 flex-1 rounded-md bg-surface px-2 text-sm font-semibold text-fg-strong outline-none focus-visible:vy-focus-ring"
    />
  )
}

