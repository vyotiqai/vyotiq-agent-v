import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { RunFeedbackRating, RunGoal, RunLoop, RunSummary, ToolApprovalDecision } from '@shared/ipc'
import type { TurnOutcome, UiAgentQuestionAnswer, UiItem } from '@shared/transcript'
import type { StepUsageTotals } from '@shared/utils/runTelemetry'
import { unreachableServiceInTurn } from '@shared/utils/unreachableService'
import { isRetryableTurnFailure } from '@shared/errors'
import { MAX_EXTRA_ROOTS, extraRootLabel } from '@shared/extraRoots'
import { Icon } from '@renderer/lib/icons'
import { AgentVSpinner } from '@renderer/lib/brand'
import { ActionMenu, Button, IconButton, ImageLightbox, Tooltip, pushToast, type ActionMenuItem } from '@renderer/lib/ui'
import {
  isCodeEditorTarget,
  isEditableShortcutTarget,
  isMainComposerTarget,
  matchShortcut,
  shortcutLabel
} from '@renderer/lib/shortcuts'
import type { InspectorToggle } from '@renderer/features/inspector/inspectorToggle'
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
import { useRunSession } from '@renderer/features/chat/RunSessionContext'
import { buildRecordModel, runStateOf, type BuildOptions, type InstanceFacts } from './recordModel'
import { RecordBody, TaskHeader } from './record/RecordLayout'
import { useRewindRedo } from './rewindRedo'
import { addTaskFolder, removeTaskFolder } from './taskFolders'
import { TaskWorktreeStrip, useTaskWorktree } from './taskWorktree'
import { RecordActionsContext, latestRetryableErrorId } from './record/WorkItems'
import { TaskRecord } from './TaskRecord'
import {
  clearMatches,
  findRanges,
  foldsToOpen,
  paintMatches,
  RecordOpenContext,
  StepRevealContext,
  type StepReveal
} from './recordFind'
import { useRecordScroll } from './useRecordScroll'
import { checksRevisionOf, useRunChecks } from './useRunChecks'

/** Palette commands that run one of the task header menu's items. */
const TASK_COMMAND_MENU_ITEMS: Record<string, string> = {
  renameTask: 'rename',
  archiveTask: 'archive',
  forkTask: 'fork',
  deleteTask: 'delete',
  toggleReasoning: 'reasoning'
}

export type TaskPaneRunActions = {
  onRename?: (title: string) => void | Promise<void>
  onExport?: () => void
  /** The task as a JSON bundle that Import task… reads back. */
  onExportJson?: () => void
  onCopyLink?: () => void
  onDelete?: () => void
  /** A copy of the task's conversation as a new task, to take another way. */
  onFork?: () => void
  /** Pin or unpin: a pinned task keeps its own navigator group. Read when the menu draws. */
  onTogglePin?: () => void
  isPinned?: () => boolean
  /** Archive or unarchive: an archived task leaves the navigator until its View shows archived ones. */
  onToggleArchive?: () => void
  isArchived?: () => boolean
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
  /** The latest run ended at the task's spend limit, as the person chose. */
  stoppedAtSpendLimit?: boolean
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
  onRevert?: (messageIndex: number, runN?: number) => void
  messageCount: number
  onOpenChanges?: (path?: string) => void
  onLoadToolContent?: (toolCallId: string) => Promise<string | null>
  mcpServerNames?: ReadonlyMap<string, string>
  /** Continue the run from its failed latest turn. */
  onRetry?: () => void
  /** Send an instruction to the task, as the line would ("Ask it to mock Redis"). */
  onFollowUp?: (instruction: string) => void
  /** Hide one error row for good. */
  onDismissRunError?: (itemId: string) => void
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
  /** Set on the rightmost pane: the inspector's toggle, there whether it is open or not. */
  inspectorToggle?: InspectorToggle
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
 * The pane's own controls at the end of its header: the inspector's toggle,
 * lit while it is open, and closing this pane of a split — named for the task,
 * so each pane says which one closes.
 */
export function PaneHeaderActions({
  title,
  inspectorToggle,
  onClosePane
}: {
  title: string
  inspectorToggle?: InspectorToggle
  onClosePane?: () => void
}) {
  return (
    <>
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
    </>
  )
}

/**
 * The run's children as the record needs them — phase and times. A running
 * child reports its step and activity every second; the record is rebuilt
 * only when one of these changes, and the rows read the rest themselves.
 */
function useInstanceFacts(): Readonly<Record<string, InstanceFacts>> | undefined {
  const { agentInstances } = useRunSession()
  const key = agentInstances
    ? Object.values(agentInstances)
        .map((i) => `${i.instanceRunId}:${i.phase}:${i.startedAt ?? ''}:${i.endedAt ?? ''}`)
        .join('|')
    : ''
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the facts' identity
  return useMemo(() => (agentInstances ? { ...agentInstances } : undefined), [key])
}

export function TaskPane(props: TaskPaneProps) {
  const { workspacePath, runId, running, pendingRun, showThinking } = props
  const liveNow = running || pendingRun
  const liveItems = useChatLiveItems(props.itemsStore, props.items)
  const todos = useRunTodos({ workspacePath, runId, running: liveNow, active: true })
  const todosData = liveNow ? todos.data : null
  // Items render deferred; whether the run is live must defer with them, or a
  // frame shows the old items as the new run (a finished run's result drops
  // back into its work list when a follow-up is sent).
  const recordInput = useMemo(
    () => ({
      items: liveItems,
      live: liveNow,
      turnFailed: props.turnFailed,
      turnStopped:
        props.turnStatus === 'cancelled' || props.turnStatus === 'interrupted' || props.stoppedAtSpendLimit === true,
      todos: todosData
    }),
    [liveItems, liveNow, props.turnFailed, props.turnStatus, props.stoppedAtSpendLimit, todosData]
  )
  const deferred = useDeferredValue(recordInput)
  const items = deferred.items
  const live = deferred.live
  const turnUsage = useResolvedTurnUsage(props.metaStore, props.turnUsage)
  const instances = useInstanceFacts()
  // The last rewind, while it can still be redone.
  const { redo, busy: redoing, onRedo } = useRewindRedo(workspacePath, runId, items.length, live)
  // Reasoning in this pane: the "Show thinking" setting until the task menu
  // says otherwise. Thought lines are as many as the calls they lead to; a
  // reader after the work alone hides them here without changing the setting.
  const [reasoningChoice, setReasoningChoice] = useState<boolean | null>(null)
  const showReasoning = reasoningChoice ?? showThinking

  const options: BuildOptions = useMemo(
    () => ({
      running: deferred.live,
      failed: deferred.turnFailed,
      stopped: deferred.turnStopped,
      showThinking: showReasoning,
      liveTodos: deferred.todos?.items ?? null,
      liveTodosUpdatedAt: deferred.todos?.updatedAt ?? null,
      instances
    }),
    [deferred, showReasoning, instances]
  )
  const model = useMemo(() => buildRecordModel(items, options), [items, options])
  const last = model.runs[model.runs.length - 1] ?? null

  // checks.json changes only when create_plan or check_done_when finishes (or
  // a rewind drops one): re-read it then, never on a timer.
  const checksRevision = useMemo(() => checksRevisionOf(items, live), [items, live])
  const checks = useRunChecks(workspacePath, runId, checksRevision)

  // ── Header ────────────────────────────────────────────────────────────
  const firstNeed = live ? (last?.needs[0] ?? null) : null
  const liveSteps = last?.steps ?? []
  // Steps a later plan dropped stay in the record for their work, not in the plan.
  const planSteps = useMemo(() => (last?.steps ?? []).filter((s) => s.n > 0), [last])
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
  // A task started in a new worktree: its workspace is that worktree.
  const worktree = useTaskWorktree(draft ? null : workspacePath, gitRevision)
  const baseFacts = draft
    ? workspacePath
      ? [{ text: `in ${formatWorkspaceName(workspacePath)}`, title: workspacePath }]
      : []
    : branch
      ? [{ text: branch, mono: true, title: props.run?.worktreeBranch || worktree.info ? 'Worktree branch' : 'Branch' }]
      : []
  // Folders outside the workspace the task may also work in: muted, after where it runs.
  const extraRoots = props.run?.extraRoots ?? []
  const facts =
    extraRoots.length > 0
      ? [
          ...baseFacts,
          {
            text: (
              <span className="inline-flex items-center gap-1" data-task-extra-roots>
                <Icon name="folder" size={12} className="shrink-0" />
                {extraRoots.map(extraRootLabel).join(', ')}
              </span>
            ),
            title: `Also works in\n${extraRoots.join('\n')}`
          }
        ]
      : baseFacts

  const [renaming, setRenaming] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const archived = props.actions.isArchived?.() ?? false
  const retryableErrorId = useMemo(() => latestRetryableErrorId(items, live), [items, live])
  // The record's own way on, offered here too: Retry where its error row
  // offers Retry (a failure Retry can get past), Resume where its receipt
  // offers Resume (stopped, with no error row saying how to carry on).
  const retryError = retryableErrorId ? items.find((item) => item.id === retryableErrorId) : undefined
  const retryable = retryError?.kind === 'run_error' && isRetryableTurnFailure({ errorCode: retryError.code })
  const onRetry = props.onRetry
  const runAction =
    onRetry && runId && !liveNow && last
      ? retryable
        ? { id: 'retry', label: 'Retry', icon: 'retry' as const, onSelect: onRetry }
        : !retryableErrorId && runStateOf(last, true, options) === 'stopped'
          ? { id: 'resume', label: 'Resume', icon: 'play' as const, onSelect: onRetry }
          : null
      : null
  // A helper works in its parent's folders, so only a task of its own offers these.
  const foldersEditable =
    Boolean(workspacePath && runId && !props.run?.inlineInstance) && typeof window.vyotiq?.setRunExtraRoots === 'function'
  const folderItems: ActionMenuItem[] =
    foldersEditable && workspacePath && runId
      ? [
          {
            id: 'add-folder',
            label: 'Add folder…',
            icon: 'folderPlus' as const,
            separatorBefore: true,
            disabled: extraRoots.length >= MAX_EXTRA_ROOTS,
            disabledReason: `A task can add at most ${MAX_EXTRA_ROOTS} folders`,
            onSelect: () => void addTaskFolder(workspacePath, runId)
          },
          ...extraRoots.map((root) => ({
            id: `remove-folder:${root}`,
            label: `Remove ${extraRootLabel(root)}`,
            icon: 'folderMinus' as const,
            detail: root,
            onSelect: () => void removeTaskFolder(workspacePath, runId, root)
          }))
        ]
      : []
  const taskItems: ActionMenuItem[] = [
    ...(props.actions.onRename && runId ? [{ id: 'rename', label: 'Rename', icon: 'edit' as const, onSelect: () => setRenaming(true) }] : []),
    // An archived task is out of the way; pinning it would pull it back.
    ...(props.actions.onTogglePin && runId && !archived
      ? [{ id: 'pin', label: props.actions.isPinned?.() ? 'Unpin' : 'Pin', icon: 'pin' as const, onSelect: props.actions.onTogglePin }]
      : []),
    // A live task can't be put away, as in the navigator's row menu; it says why.
    ...(props.actions.onToggleArchive && runId
      ? [
          {
            id: 'archive',
            label: archived ? 'Unarchive' : 'Archive',
            icon: 'archive' as const,
            disabled: liveNow && !archived,
            disabledReason: 'Stop it or let it finish first',
            onSelect: props.actions.onToggleArchive
          }
        ]
      : []),
    // What the record shows, not what is done to the task: last in its group.
    ...(runId
      ? [
          {
            id: 'reasoning',
            label: showReasoning ? 'Hide reasoning' : 'Show reasoning',
            icon: 'eye' as const,
            onSelect: () => setReasoningChoice(!showReasoning)
          }
        ]
      : []),
    ...(props.actions.onExport && runId
      ? [{ id: 'export', label: 'Export as Markdown', icon: 'download' as const, onSelect: props.actions.onExport }]
      : []),
    ...(props.actions.onExportJson && runId
      ? [{ id: 'export-json', label: 'Export as JSON', icon: 'download' as const, onSelect: props.actions.onExportJson }]
      : []),
    // Main forks only a stopped task ("Cancel run first").
    ...(props.actions.onFork && runId && !liveNow
      ? [{ id: 'fork', label: 'Fork', icon: 'fork' as const, onSelect: props.actions.onFork }]
      : []),
    ...(props.actions.onCopyLink && runId
      ? [{ id: 'link', label: 'Copy link', icon: 'link' as const, onSelect: props.actions.onCopyLink }]
      : []),
    ...(props.actions.onSplit && runId
      ? [{ id: 'split', label: 'Open a task beside', icon: 'columns' as const, onSelect: props.actions.onSplit }]
      : []),
    // Folders outside the workspace it may also work in: add one, or take one
    // away. A live run takes the change up when it next starts (taskFolders.ts).
    ...folderItems,
    // A live run cannot be deleted (main refuses: "Cancel run first") — stop it first.
    ...(props.actions.onDelete && runId && !liveNow
      ? [{ id: 'delete', label: 'Delete', icon: 'trash' as const, danger: true, separatorBefore: true, onSelect: props.actions.onDelete }]
      : [])
  ]
  // The run's own way on comes first, set apart from what is done to the task.
  const menuItems: ActionMenuItem[] = runAction
    ? [runAction, ...taskItems.map((item, i) => (i === 0 ? { ...item, separatorBefore: true } : item))]
    : taskItems

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
      // A code editor steps its own matches with F3.
      if (findOpen && e.key === 'F3' && !isCodeEditorTarget(e.target) && paneOwns(e.target)) {
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

  // Task commands from the palette act on the focused pane exactly as its menu
  // would: the same items, so the same rules (no delete while live). An action
  // the menu doesn't offer right now says why instead of doing nothing.
  const menuItemsRef = useRef(menuItems)
  menuItemsRef.current = menuItems
  const taskStateRef = useRef({ runId, liveNow, archived })
  taskStateRef.current = { runId, liveNow, archived }
  useEffect(() => {
    const onCommand = (event: Event): void => {
      const command = (event as CustomEvent<{ id?: string }>).detail?.id ?? ''
      const itemId = TASK_COMMAND_MENU_ITEMS[command]
      if (!itemId) return
      const pane = scroll.scrollRef.current?.closest('[data-chat-pane]')
      if (!scroll.scrollRef.current || pane?.getAttribute('data-chat-pane-focused') === '0') return
      const item = menuItemsRef.current.find((entry) => entry.id === itemId)
      // A greyed-out item (Archive while it works) is as unavailable from the palette.
      if (item && !item.disabled) {
        item.onSelect()
        return
      }
      const state = taskStateRef.current
      pushToast(!state.runId ? 'Open a task first.' : state.liveNow ? 'Stop the task first.' : 'This task can’t do that.', {
        state: 'failed'
      })
    }
    window.addEventListener('vyotiq:command', onCommand)
    return () => window.removeEventListener('vyotiq:command', onCommand)
  }, [scroll.scrollRef])

  // ── A new request for you comes into view in the focused pane ─────────
  const { jumpTop, jumpTo, jumpBottom, isFollowing, contentRef: recordContentRef } = scroll

  // ── The header's plan line goes to its step ───────────────────────────
  const [reveal, setReveal] = useState<StepReveal | null>(null)
  const lastRunN = last?.n ?? null
  const onPlanStep = useCallback(
    (index: number) => {
      const step = planSteps[index]
      if (!step || lastRunN == null) return
      setReveal({ runN: lastRunN, key: step.key, nonce: Date.now() })
      // Once it has opened: the step's top is where it was, but the room
      // below it to scroll into is only there after it opens.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const row = recordContentRef.current?.querySelector<HTMLElement>(
            `[data-steps-run="${lastRunN}"] > [data-step="${step.n}"]`
          )
          if (row) jumpTo(row)
        })
      )
    },
    [planSteps, lastRunN, jumpTo, recordContentRef]
  )
  const needsKey = firstNeed ? (firstNeed.kind === 'approval' ? firstNeed.approval.requestId : firstNeed.question.requestId) : null
  const gateKey = props.instanceGates?.[0]?.runId ?? null
  const shownNeedRef = useRef<string | null>(null)
  // Following the run when a request pulled the view up: once it is answered,
  // follow again — the run carries on at the bottom.
  const resumeFollowRef = useRef(false)
  useEffect(() => {
    const key = needsKey ?? gateKey
    if (!key) {
      shownNeedRef.current = null
      if (resumeFollowRef.current) {
        resumeFollowRef.current = false
        if (live) jumpBottom()
      }
      return
    }
    if (key === shownNeedRef.current || !props.approvalAutoFocus) return
    if (shownNeedRef.current == null) resumeFollowRef.current = isFollowing()
    shownNeedRef.current = key
    // The card sits in the step it holds up, which may be far down: go to it,
    // not to the top. The first in the record is the first to answer.
    const card = scroll.contentRef.current?.querySelector<HTMLElement>('[data-needs-you]')
    if (card) jumpTo(card)
    else jumpTop()
  }, [needsKey, gateKey, props.approvalAutoFocus, jumpTop, jumpTo, jumpBottom, isFollowing, live, scroll.contentRef])

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
  // Read only once the latest turn has failed and settled: never while live.
  const mockTarget = useMemo(() => (retryableErrorId ? unreachableServiceInTurn(items) : null), [retryableErrorId, items])
  const recordActions = useMemo(
    () => ({
      onOpenChanges: props.onOpenChanges,
      onLoadToolContent: props.onLoadToolContent,
      mcpServerNames: props.mcpServerNames,
      retryableErrorId,
      onRetry: props.onRetry,
      mockTarget,
      onFollowUp: props.onFollowUp,
      onDismissRunError: props.onDismissRunError
    }),
    [
      props.onOpenChanges,
      props.onLoadToolContent,
      props.mcpServerNames,
      retryableErrorId,
      props.onRetry,
      mockTarget,
      props.onFollowUp,
      props.onDismissRunError
    ]
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
        plan={planSteps}
        onPlanStep={onPlanStep}
        actions={
          <>
            {liveNow ? (
              <Tooltip content="Stop the run (Esc)">
                <Button size="xs" variant="ghost" icon="stop" onClick={props.onStop}>
                  Stop
                </Button>
              </Tooltip>
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
                    label={`More — ${menuItems.map((item) => item.label.toLowerCase()).join(', ')}`}
                    size="xs"
                    aria-expanded={t['aria-expanded']}
                    aria-controls={t['aria-controls']}
                    aria-haspopup={t['aria-haspopup']}
                    onClick={t.onClick}
                  />
                )}
              />
            ) : null}
            <PaneHeaderActions title={title} inspectorToggle={props.inspectorToggle} onClosePane={props.actions.onClosePane} />
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
            className="min-w-0 flex-1 rounded-sm bg-transparent text-sm text-fg outline-none placeholder:text-tertiary focus-visible:vy-focus-ring"
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
        <StepRevealContext.Provider value={reveal}>
        {/* The record and, while a run goes on below what you read, the way back to it. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
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
            {redo && !live ? (
              <div className="mt-3 flex items-center gap-2 text-xs text-muted" data-rewind-redo>
                <Icon name="undo" size={13} className="shrink-0 text-tertiary" />
                <span className="min-w-0 flex-1">
                  Rewound to here. Redo brings back the runs after this instruction
                  {redo.files > 0 ? ` and ${redo.files} ${redo.files === 1 ? 'file' : 'files'} as the task left them` : ''}.
                </span>
                <Button size="xs" variant="ghost" icon="redo" disabled={redoing} pending={redoing} onClick={onRedo}>
                  Redo
                </Button>
              </div>
            ) : null}
            {worktree.info && runId && !live ? (
              <TaskWorktreeStrip info={worktree.info} title={title} onChanged={worktree.refresh} />
            ) : null}
          </RecordBody>
          {live && scroll.away && !loading ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
              <Button
                size="xs"
                variant="secondary"
                icon="arrowDown"
                // The record's own End key (useRecordScroll), not a rebindable chord.
                kbd={['End']}
                onClick={jumpBottom}
                className="pointer-events-auto shadow-menu"
                data-jump-to-now
              >
                Jump to now
              </Button>
            </div>
          ) : null}
        </div>
        </StepRevealContext.Provider>
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
      className="h-6 min-w-0 flex-1 rounded-md bg-surface px-2 text-sm font-semibold text-fg-strong outline-none focus-visible:vy-focus-ring"
    />
  )
}

