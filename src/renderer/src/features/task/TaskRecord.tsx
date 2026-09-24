import { useContext, useState, type ReactNode } from 'react'
import type { ToolApprovalDecision, RunFeedbackRating } from '@shared/ipc'
import type { UiAgentQuestionAnswer } from '@shared/transcript'
import type { StepUsageTotals } from '@shared/utils/runTelemetry'
import { formatDisplayTime, formatElapsed } from '@shared/utils/timeFormat'
import { formatUsdCost } from '@shared/utils/costDisplay'
import { formatAgentInstanceShortId } from '@shared/utils/agentInstance'
import { Icon } from '@renderer/lib/icons'
import { Button, MarkdownContent, StatusGlyph, cn } from '@renderer/lib/ui'
import { QUESTION_GATE_HEADER, QUESTION_GATE_SURFACE } from '@renderer/lib/utils/layout'
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
import { Steps } from './record/Steps'
import { NowLine, WorkList, workIsLive } from './record/WorkItems'
import { RecordOpenContext, runOpenKey } from './recordFind'

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
  const lists: WorkItem[][] = [run.setup, ...run.steps.map((s) => s.work), run.after]
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
  const showResultOnTop = !lastLive && last.result != null
  const needs = lastLive ? last.needs : []
  const byRun = checksByRun(runs, props.checks ?? [])

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
              />
            )
          )}
          {gates.map((gate) => (
            <InstanceGateCard key={gate.runId} gate={gate} onOpen={props.onOpenInstance} />
          ))}
        </div>
      ) : null}

      {props.lead}

      {showResultOnTop ? <ResultRow text={last.result!.text} checks={byRun.get(last.n) ?? []} /> : null}

      {earlier.length > 0 ? (
        <RecordRow label="History">
          <div className="-mx-2">
            {earlier.map((run) => (
              <HistoryRun key={run.id} run={run} props={props} checks={byRun.get(run.n) ?? []} />
            ))}
          </div>
        </RecordRow>
      ) : null}

      {runs.length > 1 ? (
        <RunDivider n={last.n} at={last.at != null ? formatDisplayTime(new Date(last.at).toISOString()) : undefined} />
      ) : null}
      <RunBody run={last} isLast props={props} resultShownAbove={showResultOnTop} checks={byRun.get(last.n) ?? []} />
    </>
  )
}

/** The closing answer, and under it how the run did against its checks. */
function ResultRow({
  text,
  streaming = false,
  checks
}: {
  text: string
  streaming?: boolean
  checks: readonly DoneWhenCheck[]
}) {
  return (
    <RecordRow label="Result">
      <div className="text-md leading-[22px] text-fg-strong">
        <MarkdownContent content={text} streaming={streaming} />
      </div>
      <CheckedBlock checks={checks} />
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
  resultShownAbove = false,
  checks
}: {
  run: RecordRun
  isLast: boolean
  props: TaskRecordProps
  resultShownAbove?: boolean
  checks: readonly DoneWhenCheck[]
}) {
  const live = isLast && props.options.running
  const index = messageIndexOf(run)
  const canRevert =
    index != null && props.messageCount > index + 1 && !props.options.running && props.editingUserMessageIndex == null
  // The activity line goes where the work is happening: the live step if there
  // is one, else after the run's loose work — never beside an item that is
  // already showing it is live.
  const activity = live ? (props.activity ?? null) : null
  const liveStep = run.steps.find((s) => s.state === 'running' || s.state === 'needs')
  const looseTail = run.after.length > 0 ? run.after : run.setup
  const showLooseActivity =
    activity != null && !liveStep && !(looseTail.length > 0 && workIsLive(looseTail[looseTail.length - 1]!))
  return (
    <>
      {(run.text || run.images.length > 0) && !(props.omitFirstBrief && run.n === 1) ? (
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
      {run.setup.length > 0 ? (
        <RecordRow>
          <WorkList items={run.setup} />
        </RecordRow>
      ) : null}
      <Steps steps={run.steps} runN={run.n} activity={liveStep ? activity : null} />
      {run.after.length > 0 ? (
        <RecordRow label={run.steps.length === 0 ? props.workLabel : undefined}>
          <WorkList items={run.after} />
        </RecordRow>
      ) : null}
      {showLooseActivity ? (
        <RecordRow>
          <NowLine text={activity!} />
        </RecordRow>
      ) : null}
      {run.result && !resultShownAbove ? (
        <ResultRow text={run.result.text} streaming={run.result.streaming} checks={live ? [] : checks} />
      ) : null}
      <ReceiptLine
        usage={props.turnUsage?.[run.n - 1] ?? null}
        startedAt={run.startedAt}
        endedAt={run.endedAt}
        live={live}
        feedback={isLast && !live ? props.runFeedback : undefined}
        checks={checks}
      />
    </>
  )
}

/** A run that is history: one line, opens in place. */
function HistoryRun({
  run,
  props,
  checks
}: {
  run: RecordRun
  props: TaskRecordProps
  checks: readonly DoneWhenCheck[]
}) {
  const [userOpen, setOpen] = useState(false)
  // Find in record opens an earlier run that holds a match.
  const forced = useContext(RecordOpenContext).has(runOpenKey(run.n))
  const open = userOpen || forced
  const state = runStateOf(run, false, props.options)
  const usage = props.turnUsage?.[run.n - 1] ?? null
  const cost = usage ? turnCost(usage) : null
  const duration = runDuration(run)
  const title = run.result?.text.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '') ?? run.text
  return (
    <div data-history-run={run.n}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left vy-transition hover:bg-surface focus-visible:vy-focus-ring"
      >
        <StatusGlyph state={state} size={14} label />
        <span className="shrink-0 font-mono text-caption text-tertiary">Run {run.n}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-secondary">{title}</span>
        {run.steps.length > 0 ? (
          <span className="shrink-0 text-xs text-tertiary">
            {run.steps.length} {run.steps.length === 1 ? 'step' : 'steps'}
          </span>
        ) : null}
        <span className="w-14 shrink-0 text-right font-mono text-caption text-tertiary tnum">
          {duration != null && duration >= 1000 ? formatElapsed(duration) : ''}
        </span>
        <span className="w-12 shrink-0 text-right font-mono text-caption text-tertiary tnum">
          {cost ? `${cost.estimated ? '~' : ''}${formatUsdCost(cost.cost)}` : ''}
        </span>
        <Icon
          name={open ? 'chevron' : 'chevronRight'}
          size={12}
          className={cn('shrink-0 text-tertiary', open ? '' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100')}
        />
      </button>
      {open ? (
        <div className="px-2 pb-2">
          <RunBody run={run} isLast={false} props={props} checks={checks} />
        </div>
      ) : null}
    </div>
  )
}
