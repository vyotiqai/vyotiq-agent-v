import { useContext, useMemo, useState, type ReactNode } from 'react'
import type { ToolApprovalDecision, RunFeedbackRating } from '@shared/ipc'
import type { UiAgentQuestionAnswer, UiItem } from '@shared/transcript'
import type { StepUsageTotals } from '@shared/utils/runTelemetry'
import { formatDisplayTime, formatElapsed } from '@shared/utils/timeFormat'
import { formatUsdCost } from '@shared/utils/costDisplay'
import { formatAgentInstanceShortId } from '@shared/utils/agentInstance'
import { Icon } from '@renderer/lib/icons'
import { Button, DiffStat, StatusGlyph, cn } from '@renderer/lib/ui'
import { FileTypeIcon } from '@renderer/lib/fileIcons'
import { QUESTION_GATE_HEADER, QUESTION_GATE_SURFACE, ROW_HOVER } from '@renderer/lib/utils/layout'
import { turnCost } from '@renderer/features/chat/utils/messageFooterStats'
import { collectSessionChangedFiles, normalizeRelPath, type ChangedFile } from '@renderer/features/chat/utils/turnFileDiffs'
import { outcomeMarks, summarizeOutcome, useTaskOutcome, type OutcomeSummary } from './taskOutcomeStore'
import { AskQuestionPanel } from '@renderer/features/chat/components/AskQuestionPanel'
import type { InlineInstanceGate } from '@renderer/features/chat/hooks/useInlineInstanceUi'
import type { DoneWhenCheck } from '@shared/doneWhenChecks'
import { CheckedBlock, DoneWhenRow, checksByRun } from './record/Checks'
import { runStateOf, type BuildOptions, type NeedsYou, type RecordModel, type RecordRun, type WorkItem } from './recordModel'
import { ApprovalCard } from './record/ApprovalCard'
import { Brief } from './record/Brief'
import { ReceiptLine } from './record/Receipt'
import { RecordRow, RunDivider } from './record/RecordLayout'
import { RecordProse } from './record/RecordProse'
import { Steps, instancesOf, placeKey } from './record/Steps'
import {
  BrokeAtContext,
  EditMarksContext,
  FirstRuleGrantContext,
  LooseWork,
  NowLine,
  RecordActionsContext,
  counted,
  plainLine,
  workIsLive
} from './record/WorkItems'
import { useRunSession } from '@renderer/features/chat/RunSessionContext'
import { requestCommitBox } from '@renderer/features/chat/commitRequest'
import { RecordOpenContext, looseOpenKey, runOpenKey } from './recordFind'

export type TaskRecordProps = {
  model: RecordModel
  options: BuildOptions
  /**
   * What the live run is doing when none of its work shows it — waiting on
   * the network, compacting, or between calls. Null when it is idle.
   */
  activity?: string | null
  /** Usage per run (index = run number − 1). */
  turnUsage?: readonly StepUsageTotals[]
  runFeedback?: { value: RunFeedbackRating | null; onRate: (rating: RunFeedbackRating | null) => void }
  onApprovalDecision?: (requestId: string, decision: ToolApprovalDecision) => void | Promise<void>
  onQuestionSubmit?: (requestId: string, answers: UiAgentQuestionAnswer[]) => void | Promise<void>
  /** Focus the needs-you card only in the focused pane. */
  approvalAutoFocus?: boolean
  /** Sub-agent instances of this task waiting on you in their own records. */
  instanceGates?: readonly InlineInstanceGate[]
  onOpenInstance?: (instanceRunId: string) => void
  /** The task's done-when checks (checks.json), each shown under the run that made it. */
  checks?: readonly DoneWhenCheck[]
  /** Rows before the record proper — an instance's Goal and Scope. */
  lead?: ReactNode
  /** The first run's brief is already shown by `lead` (an instance's goal). */
  omitFirstBrief?: boolean
  /** Heading for the run's loose work ("Work" in an instance record). */
  workLabel?: string
  /** Edit-and-rerun / rewind, by the brief's message index. */
  editingUserMessageIndex?: number | null
  editComposer?: ReactNode
  onBeginEdit?: (messageIndex: number) => void
  /** Rewind to before the brief at `messageIndex`, the record's run `runN`. */
  onRevert?: (messageIndex: number, runN?: number) => void
  messageCount: number
  onImageClick?: (src: string) => void
}

/** The brief's message index, from the `user-<index>` id the transcript gives it. */
function messageIndexOf(run: RecordRun): number | null {
  const m = /^user-(\d+)$/.exec(run.id)
  return m ? Number(m[1]) : null
}

function runDuration(run: RecordRun): number | null {
  return run.startedAt != null && run.endedAt != null ? run.endedAt - run.startedAt : null
}

export function TaskRecord(props: TaskRecordProps) {
  const { model, options } = props
  const runs = model.runs
  const gates = props.instanceGates ?? []
  if (runs.length === 0) return null
  const last = runs[runs.length - 1]!
  const lastLive = options.running
  const earlier = runs.slice(0, -1)
  const needs = lastLive ? last.needs : []
  // Each card goes where the gated call would have: in its step, or the loose
  // work around the steps. An instance's goes in the step that started it.
  // A place the record does not draw (a step a later plan dropped) keeps its
  // card above the record, so nothing waiting on you is ever out of sight.
  const drawn = new Set([
    placeKey({ kind: 'setup' }),
    placeKey({ kind: 'after' }),
    ...last.steps.flatMap((s) => [placeKey({ kind: 'step', key: s.key }), placeKey({ kind: 'between', key: s.key })])
  ])
  const placed = new Map<string, ReactNode[]>()
  const top: ReactNode[] = []
  const place = (key: string, card: ReactNode): void => {
    if (!drawn.has(key)) top.push(card)
    else placed.set(key, [...(placed.get(key) ?? []), card])
  }
  for (const need of needs) {
    const key = placeKey(need.place)
    // In its place the agent's words are right above it; away from it, the card says them.
    place(key, <NeedCard key={needId(need)} need={need} quoteWhy={!drawn.has(key)} props={props} />)
  }
  for (const gate of gates) {
    const card = <InstanceGateCard key={gate.runId} gate={gate} onOpen={props.onOpenInstance} />
    const step = last.steps.find((s) => instancesOf(s).some((i) => i.runId === gate.runId))
    if (step) place(placeKey({ kind: 'step', key: step.key }), card)
    else top.push(card)
  }
  const needCards = new Map<string, ReactNode>([...placed].map(([key, cards]) => [key, <>{cards}</>]))
  const byRun = checksByRun(runs, props.checks ?? [])
  // The cost column is kept only when some run has a cost, so durations share
  // the right edge the work rows' durations use instead of stopping short of a gap.
  const historyCost = earlier.some((run) => props.turnUsage?.[run.n - 1] && turnCost(props.turnUsage[run.n - 1]!))

  return (
    <>
      {/* A card with nowhere closer to wait: an instance started outside any step, or a dropped step's call. */}
      {top.length > 0 ? <div className="space-y-2 pb-1 pt-3">{top}</div> : null}

      {props.lead}

      {earlier.length > 0 ? (
        <RecordRow label="History">
          <div className="-mx-2">
            {earlier.map((run) => (
              <HistoryRun key={run.id} run={run} props={props} checks={byRun.get(run.n) ?? []} costColumn={historyCost} />
            ))}
          </div>
        </RecordRow>
      ) : null}

      {runs.length > 1 ? (
        <RunDivider n={last.n} at={last.at != null ? formatDisplayTime(new Date(last.at).toISOString()) : undefined} />
      ) : null}
      {/* Keyed by run: a follow-up's run must not inherit the last one's open steps. */}
      <RunBody key={last.id} run={last} isLast props={props} checks={byRun.get(last.n) ?? []} needs={needCards} />
    </>
  )
}

type ToolItem = Extract<UiItem, { kind: 'tool' }>

/** Every call in a run, in order, wherever the record filed it. */
function runTools(run: RecordRun): ToolItem[] {
  const out: ToolItem[] = []
  const add = (list: readonly WorkItem[]): void => {
    for (const w of list) {
      if (w.kind === 'explore') out.push(...w.tools)
      else if (w.kind === 'tool' || w.kind === 'card' || w.kind === 'instance' || w.kind === 'plan') out.push(w.tool)
    }
  }
  add(run.setup)
  for (const s of run.steps) {
    add(s.work)
    add(s.between)
  }
  add(run.after)
  return out
}

/**
 * Where a stopped run got to and what it left: "at step 2 of 4 · 3 files
 * changed". Undefined when it stopped before a step or a file.
 */
function stoppedDetail(run: RecordRun, tools: readonly ToolItem[]): string | undefined {
  const plan = run.steps.filter((s) => s.n > 0)
  const at = plan.find((s) => s.state === 'stopped' && !s.superseded)
  const files = collectSessionChangedFiles(tools as ToolItem[]).length
  const parts = [at ? `at step ${at.n} of ${plan.length}` : null, files > 0 ? `${counted(files, 'file')} changed` : null]
  const said = parts.filter((p): p is string => p != null)
  return said.length > 0 ? said.join(' · ') : undefined
}

/** Past this many, the rest are one line into Changes. */
const RESULT_FILES_SHOWN = 8

/** What the run changed, file by file; each opens in Changes. */
function ResultFiles({
  files,
  onOpen,
  marks
}: {
  files: readonly ChangedFile[]
  onOpen: (path?: string) => void
  /** What was decided for each file once reviewed: Kept or Undone. */
  marks?: ReadonlyMap<string, 'kept' | 'undone'>
}) {
  const shown = files.slice(0, RESULT_FILES_SHOWN)
  const more = files.length - shown.length
  return (
    <ul aria-label="Files changed" className="mt-3" data-result-files>
      {shown.map((f) => {
        const cut = f.path.lastIndexOf('/')
        const mark = marks?.get(normalizeRelPath(f.path))
        return (
          <li key={f.path}>
            <button
              type="button"
              onClick={() => onOpen(f.path)}
              title={f.path}
              className={cn(
                'group -mx-2 flex h-7 w-[calc(100%+16px)] min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs focus-visible:vy-focus-ring',
                ROW_HOVER
              )}
            >
              <FileTypeIcon path={f.path} size={14} />
              <span className="min-w-0 flex-1 truncate">
                {cut >= 0 ? <span className="text-tertiary">{f.path.slice(0, cut + 1)}</span> : null}
                <span className={mark === 'undone' ? 'text-muted line-through decoration-tertiary' : 'text-fg'}>
                  {f.path.slice(cut + 1)}
                </span>
              </span>
              {f.action === 'created' || f.action === 'deleted' ? (
                <span className="shrink-0 text-caption text-tertiary">{f.action === 'created' ? 'New' : 'Deleted'}</span>
              ) : null}
              {mark ? (
                <span className="shrink-0 text-caption text-tertiary" data-result-file-mark={mark}>
                  {mark === 'kept' ? 'Kept' : 'Undone'}
                </span>
              ) : null}
              {f.added != null || f.removed != null ? <DiffStat add={f.added ?? 0} del={f.removed ?? 0} className="shrink-0" /> : null}
              <Icon
                name="chevronRight"
                size={11}
                className="shrink-0 text-tertiary opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
              />
            </button>
          </li>
        )
      })}
      {more > 0 ? (
        <li>
          <button
            type="button"
            onClick={() => onOpen()}
            className={cn(
              '-mx-2 flex h-7 w-[calc(100%+16px)] items-center rounded-md px-2 text-left text-xs text-muted focus-visible:vy-focus-ring',
              ROW_HOVER
            )}
          >
            {more} more in Changes
          </button>
        </li>
      ) : null}
    </ul>
  )
}

/**
 * How the task's edits were settled after review, on one quiet line, with the
 * step after it: kept edits can be committed, a commit can become a pull request.
 */
function SettledLine({ settled, onCommit, onPullRequest }: { settled: OutcomeSummary; onCommit?: () => void; onPullRequest?: () => void }) {
  const icon = settled.kind === 'committed' ? 'gitCommit' : settled.kind === 'undone' ? 'undo' : 'check'
  const commitable = settled.kind === 'kept' || settled.kind === 'mixed'
  return (
    <div className="mt-3 flex min-w-0 items-center gap-2 text-xs text-tertiary" data-result-outcome={settled.kind}>
      <Icon name={icon} size={13} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {settled.kind === 'committed' ? (
          <>
            Committed <span className="font-mono text-muted">{settled.sha.slice(0, 7)}</span>
            {settled.branch ? <> to {settled.branch}</> : null}
            {settled.undone > 0 ? `, ${settled.undone} undone` : null}
          </>
        ) : settled.kind === 'kept' ? (
          'Kept, not committed yet'
        ) : settled.kind === 'undone' ? (
          'Undone — the files are back as they were'
        ) : (
          `${settled.kept} kept, ${settled.undone} undone, not committed yet`
        )}
      </span>
      {commitable && onCommit ? (
        <Button size="xs" variant="ghost" icon="gitCommit" onClick={onCommit}>
          Commit…
        </Button>
      ) : null}
      {settled.kind === 'committed' && onPullRequest ? (
        <Button size="xs" variant="ghost" icon="pullRequest" onClick={onPullRequest}>
          Pull request
        </Button>
      ) : null}
    </div>
  )
}

/** The closing answer, and under it how the run did against its checks. */
function ResultRow({
  text,
  streaming = false,
  checks,
  files,
  onOpenFile,
  review,
  marks,
  settled,
  onCommit,
  onPullRequest
}: {
  text: string
  streaming?: boolean
  checks: readonly DoneWhenCheck[]
  /** What the run changed; listed only when there is somewhere to open them. */
  files?: readonly ChangedFile[]
  onOpenFile?: (path?: string) => void
  /** Its edits are still open: how many, and the way to them. */
  review?: { count: number; open: () => void }
  /** Each reviewed file's decision, marked on its row. */
  marks?: ReadonlyMap<string, 'kept' | 'undone'>
  /** How the task's edits were settled, once nothing waits on review. */
  settled?: OutcomeSummary | null
  /** The settled line's next step: open the commit box, or the PR tab. */
  onCommit?: () => void
  onPullRequest?: () => void
}) {
  return (
    <RecordRow label="Result">
      <RecordProse text={text} streaming={streaming} size="md" tone="strong" sectionCopy />
      {files && files.length > 0 && onOpenFile && !streaming ? (
        <ResultFiles files={files} onOpen={onOpenFile} marks={marks} />
      ) : null}
      <CheckedBlock checks={checks} />
      {settled && !review ? <SettledLine settled={settled} onCommit={onCommit} onPullRequest={onPullRequest} /> : null}
      {review ? (
        <div className="mt-3 flex items-center gap-2" data-result-review>
          <span className="min-w-0 flex-1 text-xs text-tertiary">
            {review.count} {review.count === 1 ? 'file' : 'files'} changed, not kept yet
          </span>
          <Button size="xs" variant="secondary" trailingIcon="arrowRight" onClick={review.open}>
            Review changes
          </Button>
        </div>
      ) : null}
    </RecordRow>
  )
}

function needId(need: NeedsYou): string {
  return need.kind === 'approval' ? need.approval.requestId : need.question.requestId
}

/** A call or question waiting on you, answered where it stopped the work. */
function NeedCard({ need, quoteWhy, props }: { need: NeedsYou; quoteWhy: boolean; props: TaskRecordProps }) {
  return need.kind === 'approval' ? (
    <ApprovalCard
      approval={need.approval}
      requestedAt={need.at}
      why={quoteWhy ? need.why : undefined}
      onDecide={props.onApprovalDecision}
      captureFocus={props.approvalAutoFocus}
    />
  ) : (
    <AskQuestionPanel
      question={need.question}
      onSubmit={props.onQuestionSubmit}
      captureFocus={props.approvalAutoFocus}
    />
  )
}

/** A sub-agent waiting on you: it asks in its own record, so this points there. */
function InstanceGateCard({ gate, onOpen }: { gate: InlineInstanceGate; onOpen?: (runId: string) => void }) {
  const label = `Instance ${formatAgentInstanceShortId(gate.runId)}`
  return (
    <section aria-label="Needs you" data-needs-you className={cn(QUESTION_GATE_SURFACE, 'vy-rise')}>
      <div className={QUESTION_GATE_HEADER}>
        <StatusGlyph state="needs" size={12} />
        <span className="min-w-0 truncate font-semibold text-accent">
          Needs you — {label} {gate.kind === 'approval' ? 'wants approval' : 'has a question'}
        </span>
      </div>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className="min-w-0 flex-1 text-sm text-secondary">It waits in its own record until you answer there.</span>
        {onOpen ? (
          <Button size="sm" variant="primary" onClick={() => onOpen(gate.runId)}>
            Open instance
          </Button>
        ) : null}
      </div>
    </section>
  )
}

function RunBody({
  run,
  isLast,
  props,
  checks,
  needs
}: {
  run: RecordRun
  isLast: boolean
  props: TaskRecordProps
  checks: readonly DoneWhenCheck[]
  /** The live run's needs-you cards, by `placeKey` of where each goes. */
  needs?: ReadonlyMap<string, ReactNode>
}) {
  const live = isLast && props.options.running
  const index = messageIndexOf(run)
  const canRevert =
    index != null && props.messageCount > index + 1 && !props.options.running && props.editingUserMessageIndex == null
  // The activity line goes where the latest work is going — the setup list, a
  // step, after a step, or the loose work at the end — never beside an item
  // that is already showing it is live.
  const activity = live ? (props.activity ?? null) : null
  const tail = live ? run.tail : null
  const looseActivity = (list: readonly WorkItem[]): boolean =>
    activity != null && !(list.length > 0 && workIsLive(list[list.length - 1]!))
  const setupActivity = tail?.kind === 'setup' && looseActivity(run.setup)
  const setupNeeds = needs?.get(placeKey({ kind: 'setup' })) ?? null
  const afterNeeds = needs?.get(placeKey({ kind: 'after' })) ?? null
  const state = live ? null : runStateOf(run, isLast, props.options)
  // The latest run's edits still open in the inspector, and what the record offers for them.
  const { pendingWrites, onOpenPanel, workspacePath: sessionWorkspace, runId: sessionRunId } = useRunSession()
  const { onOpenChanges, onRetry, retryableErrorId } = useContext(RecordActionsContext)
  const unkept = isLast && !live ? (pendingWrites?.count ?? 0) : 0
  const changedFiles = useMemo(
    () => (run.result && !live ? collectSessionChangedFiles(runTools(run)) : []),
    [run, live]
  )
  // How the task's edits were settled: each file's Kept or Undone, and on the
  // latest run the one line that says it once nothing waits on review.
  const outcome = useTaskOutcome(
    sessionWorkspace,
    sessionRunId,
    !live && run.result != null && (isLast || changedFiles.length > 0),
    `${run.n}:${run.endedAt ?? ''}:${unkept}`
  )
  const marks = useMemo(() => outcomeMarks(outcome), [outcome])
  const settled = isLast && unkept === 0 ? summarizeOutcome(outcome) : null
  // An error row with Retry already says how to carry on.
  const resume = state === 'stopped' && isLast && onRetry && !retryableErrorId ? onRetry : undefined
  const afterActivity = tail?.kind === 'after' && looseActivity(run.after)
  // A settled run with an answer folds its loose work; without one, the work is the record.
  const foldLoose = !live && run.result != null
  // A rule's grant is said once per run, on the first call it let through.
  const tools = useMemo(() => runTools(run), [run])
  const firstRuleGrant = useMemo(() => tools.find((t) => t.tool.approvedBy?.by === 'rule')?.id ?? null, [tools])
  // A failed run opens the command it broke on: its last one, if that one failed.
  const brokeAt = useMemo(
    () => (state === 'failed' ? ([...tools].reverse().find((t) => t.tool.name === 'terminal')?.id ?? null) : null),
    [state, tools]
  )
  const stopped = useMemo(() => (state === 'stopped' ? stoppedDetail(run, tools) : undefined), [state, run, tools])
  return (
    <FirstRuleGrantContext.Provider value={firstRuleGrant}>
    <BrokeAtContext.Provider value={brokeAt}>
    <EditMarksContext.Provider value={marks}>
      {(run.text || run.command || run.images.length > 0) && !(props.omitFirstBrief && run.n === 1) ? (
        <Brief
          run={run}
          editing={index != null && props.editingUserMessageIndex === index}
          editComposer={props.editComposer}
          onEdit={
            props.onBeginEdit && index != null && props.editingUserMessageIndex == null
              ? () => props.onBeginEdit!(index)
              : undefined
          }
          onRewind={props.onRevert && canRevert ? () => props.onRevert!(index!, run.n) : undefined}
          onImageClick={props.onImageClick}
        />
      ) : null}
      {/* Open checks sit under the brief; once there is a result they move under it. */}
      {checks.length > 0 && (live || !run.result) ? <DoneWhenRow checks={checks} live={live} /> : null}
      {run.setup.length > 0 || setupActivity || setupNeeds ? (
        <RecordRow>
          <div className="space-y-2">
            {run.setup.length > 0 ? <LooseWork items={run.setup} fold={foldLoose} openKey={looseOpenKey(run.n, 'setup')} /> : null}
            {setupActivity ? <NowLine text={activity!} /> : null}
            {setupNeeds}
          </div>
        </RecordRow>
      ) : null}
      <Steps steps={run.steps} runN={run.n} tail={tail} activity={activity} needs={needs} />
      {run.after.length > 0 || afterActivity || afterNeeds ? (
        <RecordRow label={run.steps.length === 0 && run.after.length > 0 ? props.workLabel : undefined}>
          <div className="space-y-2">
            {run.after.length > 0 ? <LooseWork items={run.after} fold={foldLoose} openKey={looseOpenKey(run.n, 'after')} /> : null}
            {afterActivity ? <NowLine text={activity!} /> : null}
            {afterNeeds}
          </div>
        </RecordRow>
      ) : null}
      {run.result ? (
        <ResultRow
          text={run.result.text}
          streaming={run.result.streaming}
          checks={live ? [] : checks}
          files={changedFiles}
          onOpenFile={onOpenChanges}
          review={unkept > 0 && onOpenChanges ? { count: unkept, open: () => onOpenChanges() } : undefined}
          marks={marks}
          settled={settled}
          // Only the inspector's own run gets onOpenPanel: its tabs are that run's.
          onCommit={
            onOpenChanges && onOpenPanel && sessionRunId
              ? () => {
                  requestCommitBox(sessionRunId)
                  onOpenChanges()
                }
              : undefined
          }
          onPullRequest={onOpenPanel ? () => onOpenPanel('pr') : undefined}
        />
      ) : null}
      <ReceiptLine
        usage={props.turnUsage?.[run.n - 1] ?? null}
        startedAt={run.startedAt}
        endedAt={run.endedAt}
        live={live}
        feedback={isLast && !live ? props.runFeedback : undefined}
        checks={checks}
        summary={run.result && !run.result.streaming ? run.result.text : undefined}
        outcome={state === 'stopped' || state === 'failed' ? state : undefined}
        outcomeDetail={stopped}
        actions={
          state === 'stopped' && isLast && (resume || (unkept > 0 && pendingWrites)) ? (
            <>
              {unkept > 0 && pendingWrites ? (
                <Button size="xs" variant="ghost" icon="undo" onClick={pendingWrites.onUndo}>
                  Undo its changes
                </Button>
              ) : null}
              {resume ? (
                <Button size="xs" variant="secondary" icon="play" onClick={resume}>
                  Resume
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      />
    </EditMarksContext.Provider>
    </BrokeAtContext.Provider>
    </FirstRuleGrantContext.Provider>
  )
}

/** A run that is history: one line, opens in place. */
function HistoryRun({
  run,
  props,
  checks,
  costColumn
}: {
  run: RecordRun
  props: TaskRecordProps
  checks: readonly DoneWhenCheck[]
  costColumn: boolean
}) {
  const [userOpen, setOpen] = useState(false)
  // Find in record opens an earlier run that holds a match.
  const forced = useContext(RecordOpenContext).has(runOpenKey(run.n))
  const open = userOpen || forced
  const state = runStateOf(run, false, props.options)
  const usage = props.turnUsage?.[run.n - 1] ?? null
  const cost = usage ? turnCost(usage) : null
  const duration = runDuration(run)
  // The answer's first line, as words: "Checks recorded: **4 met**" showed its asterisks.
  const answerLine = run.result?.text.split('\n').find((l) => l.trim())
  const title = answerLine != null ? plainLine(answerLine) : run.text || (run.command ? `/${run.command}` : '')
  return (
    <div data-history-run={run.n}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          'group flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left vy-transition focus-visible:vy-focus-ring',
          ROW_HOVER
        )}
      >
        <StatusGlyph state={state} size={14} label />
        <span className="shrink-0 font-mono text-caption text-tertiary">Run {run.n}</span>
        {open ? (
          // Opened, the run shows its whole answer below: the row names when it
          // ran, as the divider above the latest run does, not the answer again.
          <span className="min-w-0 flex-1 truncate font-mono text-caption text-tertiary tnum">
            {run.at != null ? formatDisplayTime(new Date(run.at).toISOString()) : ''}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm text-secondary">{title}</span>
        )}
        {run.steps.length > 0 ? (
          <span className="shrink-0 text-xs text-tertiary">
            {run.steps.length} {run.steps.length === 1 ? 'step' : 'steps'}
          </span>
        ) : null}
        <span className="min-w-14 shrink-0 whitespace-nowrap text-right font-mono text-caption text-tertiary tnum">
          {duration != null && duration >= 1000 ? formatElapsed(duration) : ''}
        </span>
        {costColumn ? (
          <span className="min-w-12 shrink-0 whitespace-nowrap text-right font-mono text-caption text-tertiary tnum">
            {cost ? `${cost.estimated ? '~' : ''}${formatUsdCost(cost.cost)}` : ''}
          </span>
        ) : null}
        <Icon
          name={open ? 'chevron' : 'chevronRight'}
          size={11}
          // The row's gap is wider than a work row's; this puts its duration on their right edge.
          className={cn('-ml-0.5 shrink-0 text-tertiary', open ? '' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100')}
        />
      </button>
      {open ? (
        // The opened run hangs off its row: a guide under the glyph, its
        // content on the title's edge, so it never reads as the current run.
        <div className="mb-2 ml-[15px] border-l border-border pl-4 pr-2" data-history-body={run.n}>
          <RunBody run={run} isLast={false} props={props} checks={checks} />
        </div>
      ) : null}
    </div>
  )
}
