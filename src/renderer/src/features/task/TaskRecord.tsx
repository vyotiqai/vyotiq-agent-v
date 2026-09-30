import { useContext, useState, type ReactNode } from 'react'
import type { ToolApprovalDecision, RunFeedbackRating } from '@shared/ipc'
import type { UiAgentQuestionAnswer } from '@shared/transcript'
import type { StepUsageTotals } from '@shared/utils/runTelemetry'
import { formatDisplayTime, formatElapsed } from '@shared/utils/timeFormat'
import { formatUsdCost } from '@shared/utils/costDisplay'
import { formatAgentInstanceShortId } from '@shared/utils/agentInstance'
import { Icon } from '@renderer/lib/icons'
import { Button, StatusGlyph, cn } from '@renderer/lib/ui'
import { QUESTION_GATE_HEADER, QUESTION_GATE_SURFACE, ROW_HOVER } from '@renderer/lib/utils/layout'
import { turnCost } from '@renderer/features/chat/utils/messageFooterStats'
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
import { Steps } from './record/Steps'
import { LooseWork, NowLine, RecordActionsContext, workIsLive } from './record/WorkItems'
import { useRunSession } from '@renderer/features/chat/RunSessionContext'
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

function stepLabelFor(run: RecordRun, need: NeedsYou): string | undefined {
  const step = run.steps.find((s) => s.key === need.stepKey)
  return step ? `Step ${step.n} · ${step.title}` : undefined
}

/** What the agent said right before the gated call, in the same list. */
function whyFor(run: RecordRun, toolId: string): string | undefined {
  const lists: WorkItem[][] = [run.setup, ...run.steps.flatMap((s) => [s.work, s.between]), run.after]
  for (const list of lists) {
    const at = list.findIndex((w) => w.kind === 'card' && w.tool.id === toolId)
    if (at < 0) continue
    for (let i = at - 1; i >= 0; i--) {
      const w = list[i]!
      if (w.kind === 'note') return w.text
      if (w.kind !== 'thought') break
    }
  }
  return undefined
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
  const byRun = checksByRun(runs, props.checks ?? [])
  // The cost column is kept only when some run has a cost, so durations share
  // the right edge the work rows' durations use instead of stopping short of a gap.
  const historyCost = earlier.some((run) => props.turnUsage?.[run.n - 1] && turnCost(props.turnUsage[run.n - 1]!))

  return (
    <>
      {needs.length > 0 || gates.length > 0 ? (
        <div className="space-y-2 pb-1 pt-3">
          {needs.map((need) =>
            need.kind === 'approval' ? (
              <ApprovalCard
                key={need.approval.requestId}
                approval={need.approval}
                stepLabel={stepLabelFor(last, need)}
                requestedAt={need.at}
                why={whyFor(last, need.tool.id)}
                onDecide={props.onApprovalDecision}
                captureFocus={props.approvalAutoFocus}
              />
            ) : (
              <AskQuestionPanel
                key={need.question.requestId}
                question={need.question}
                stepLabel={stepLabelFor(last, need)}
                onSubmit={props.onQuestionSubmit}
                captureFocus={props.approvalAutoFocus}
              />
            )
          )}
          {gates.map((gate) => (
            <InstanceGateCard key={gate.runId} gate={gate} onOpen={props.onOpenInstance} />
          ))}
        </div>
      ) : null}

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
      <RunBody key={last.id} run={last} isLast props={props} checks={byRun.get(last.n) ?? []} />
    </>
  )
}

/** The closing answer, and under it how the run did against its checks. */
function ResultRow({
  text,
  streaming = false,
  checks,
  review
}: {
  text: string
  streaming?: boolean
  checks: readonly DoneWhenCheck[]
  /** Its edits are still open: how many, and the way to them. */
  review?: { count: number; open: () => void }
}) {
  return (
    <RecordRow label="Result">
      <RecordProse text={text} streaming={streaming} size="md" tone="strong" />
      <CheckedBlock checks={checks} />
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

/** A sub-agent waiting on you: it asks in its own record, so this points there. */
function InstanceGateCard({ gate, onOpen }: { gate: InlineInstanceGate; onOpen?: (runId: string) => void }) {
  const label = `Instance ${formatAgentInstanceShortId(gate.runId)}`
  return (
    <section aria-label="Needs you" data-needs-you className={QUESTION_GATE_SURFACE}>
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
  checks
}: {
  run: RecordRun
  isLast: boolean
  props: TaskRecordProps
  checks: readonly DoneWhenCheck[]
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
  const state = live ? null : runStateOf(run, isLast, props.options)
  // The latest run's edits still open in the inspector, and what the record offers for them.
  const { pendingWrites } = useRunSession()
  const { onOpenChanges, onRetry, retryableErrorId } = useContext(RecordActionsContext)
  const unkept = isLast && !live ? (pendingWrites?.count ?? 0) : 0
  // An error row with Retry already says how to carry on.
  const resume = state === 'stopped' && isLast && onRetry && !retryableErrorId ? onRetry : undefined
  const afterActivity = tail?.kind === 'after' && looseActivity(run.after)
  // A settled run with an answer folds its loose work; without one, the work is the record.
  const foldLoose = !live && run.result != null
  return (
    <>
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
      {run.setup.length > 0 || setupActivity ? (
        <RecordRow>
          <div className="space-y-2">
            {run.setup.length > 0 ? <LooseWork items={run.setup} fold={foldLoose} openKey={looseOpenKey(run.n, 'setup')} /> : null}
            {setupActivity ? <NowLine text={activity!} /> : null}
          </div>
        </RecordRow>
      ) : null}
      <Steps steps={run.steps} runN={run.n} tail={tail} activity={activity} />
      {run.after.length > 0 || afterActivity ? (
        <RecordRow label={run.steps.length === 0 && run.after.length > 0 ? props.workLabel : undefined}>
          <div className="space-y-2">
            {run.after.length > 0 ? <LooseWork items={run.after} fold={foldLoose} openKey={looseOpenKey(run.n, 'after')} /> : null}
            {afterActivity ? <NowLine text={activity!} /> : null}
          </div>
        </RecordRow>
      ) : null}
      {run.result ? (
        <ResultRow
          text={run.result.text}
          streaming={run.result.streaming}
          checks={live ? [] : checks}
          review={unkept > 0 && onOpenChanges ? { count: unkept, open: () => onOpenChanges() } : undefined}
        />
      ) : null}
      <ReceiptLine
        usage={props.turnUsage?.[run.n - 1] ?? null}
        startedAt={run.startedAt}
        endedAt={run.endedAt}
        live={live}
        feedback={isLast && !live ? props.runFeedback : undefined}
        checks={checks}
        outcome={state === 'stopped' || state === 'failed' ? state : undefined}
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
    </>
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
  const title = run.result?.text.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '') ?? (run.text || (run.command ? `/${run.command}` : ''))
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
        <span className="w-14 shrink-0 text-right font-mono text-caption text-tertiary tnum">
          {duration != null && duration >= 1000 ? formatElapsed(duration) : ''}
        </span>
        {costColumn ? (
          <span className="w-12 shrink-0 text-right font-mono text-caption text-tertiary tnum">
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
