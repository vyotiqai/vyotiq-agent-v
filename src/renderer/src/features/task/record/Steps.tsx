import { useContext, useState, type ReactNode } from 'react'
import { parseAgentInstanceRunId, parseAgentInstanceRunIdFromArgs, formatAgentInstanceShortId } from '@shared/utils/agentInstance'
import { formatElapsed } from '@shared/utils/timeFormat'
import { Icon } from '@renderer/lib/icons'
import { StepMarker, cn } from '@renderer/lib/ui'
import { HOVER_ON_SURFACE, NUM, ROW_HOVER } from '@renderer/lib/utils/layout'
import { useSharedNow } from '@renderer/lib/hooks/useSharedNow'
import { scrollMotion } from '@renderer/lib/utils/motion'
import { useRunSession } from '@renderer/features/chat/RunSessionContext'
import type { RecordStep, RecordTail } from '../recordModel'
import { RecordOpenContext, stepOpenKey } from '../recordFind'
import { RecordRow } from './RecordLayout'
import { NowLine, WorkList, counted, plainLine, workCounts, workIsLive } from './WorkItems'

/**
 * The plan's steps; only the step the live work is going into is open, the
 * rest are one line each. Work done while no step was in progress sits after
 * the step it followed, outside it.
 */
export function Steps({
  steps,
  runN,
  tail = null,
  activity = null,
  needs
}: {
  steps: readonly RecordStep[]
  runN: number
  /** Where the live run's latest work is going; null once the run is over. */
  tail?: RecordTail | null
  /** The live run's activity, shown where its latest work is going. */
  activity?: string | null
  /** Needs-you cards by `placeKey` of where the gated call would have gone. */
  needs?: ReadonlyMap<string, ReactNode>
}) {
  if (steps.length === 0) return null
  return (
    <RecordRow>
      {/* -mx-2 bleeds each row into the gutter its own px-2 pulls back; the
          gap is what keeps folded steps from reading as one dense slab. */}
      <ol className="-mx-2 space-y-1" aria-label="Steps" data-steps-run={runN}>
        {steps.map((s) => (
          <StepRow
            key={s.key}
            step={s}
            runN={runN}
            holdsTail={tail?.kind === 'step' && tail.key === s.key}
            activity={tail?.kind === 'step' && tail.key === s.key ? activity : null}
            betweenActivity={tail?.kind === 'between' && tail.key === s.key ? activity : null}
            needs={needs?.get(placeKey({ kind: 'step', key: s.key })) ?? null}
            betweenNeeds={needs?.get(placeKey({ kind: 'between', key: s.key })) ?? null}
          />
        ))}
      </ol>
    </RecordRow>
  )
}

/** One key per place a run's work goes, for the needs-you cards placed there. */
export function placeKey(place: RecordTail): string {
  return place.kind === 'step' || place.kind === 'between' ? `${place.kind}:${place.key}` : place.kind
}

/** Brings the needs-you card inside `within` into view and puts focus on its first action. */
function showNeedsYou(within: Element): void {
  const card = within.querySelector<HTMLElement>('[data-needs-you]')
  if (!card) return
  card.scrollIntoView({ block: 'start', behavior: scrollMotion() })
  card.querySelector<HTMLElement>('button:not([disabled]), [href], input, textarea')?.focus({ preventScroll: true })
}

/** Instances this step started, with the short id the navigator and panes use. */
export function instancesOf(step: RecordStep): { runId: string; shortId: string }[] {
  const out: { runId: string; shortId: string }[] = []
  for (const w of step.work) {
    if (w.kind !== 'instance' || w.tool.tool.name !== 'spawn_agent_instance') continue
    const runId = parseAgentInstanceRunId(w.tool.tool.content) ?? parseAgentInstanceRunIdFromArgs(w.tool.tool.argsPreview)
    if (runId && !out.some((i) => i.runId === runId)) out.push({ runId, shortId: formatAgentInstanceShortId(runId) })
  }
  return out
}

function editSummaryText(edits: RecordStep['edits']): string | null {
  if (!edits) return null
  const files = `${edits.files} ${edits.files === 1 ? 'file' : 'files'} edited`
  if (edits.add === undefined || edits.del === undefined) return files
  return `${files} · +${edits.add} −${edits.del}`
}

/**
 * What a step's own work amounts to, for its folded line: "6 lookups · 2
 * commands · 3 files edited · +12 −4". Edits come last so their lines stay
 * beside them; instances are left out — the row's chips already name them.
 */
export function stepSummaryText(step: Pick<RecordStep, 'work' | 'edits'>): string | null {
  const c = workCounts(step.work)
  const parts = [
    c.lookups > 0 ? counted(c.lookups, 'lookup') : '',
    c.commands > 0 ? counted(c.commands, 'command') : '',
    c.calls > 0 ? counted(c.calls, 'call') : '',
    editSummaryText(step.edits) ?? ''
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : null
}

function StepRow({
  step,
  runN,
  holdsTail,
  activity,
  betweenActivity,
  needs,
  betweenNeeds
}: {
  step: RecordStep
  runN: number
  /** The live run's latest work is going into this step. */
  holdsTail: boolean
  activity: string | null
  /** The live run's activity, when its latest work sits after this step. */
  betweenActivity: string | null
  /** Needs-you cards for a call gated in this step, after its work. */
  needs: ReactNode
  /** …and for one gated after it settled. */
  betweenNeeds: ReactNode
}) {
  const live = step.state === 'running' || step.state === 'needs'
  const [open, setOpen] = useState<boolean | null>(null)
  // Find in record opens a step that holds a match, whatever you last chose.
  const forced = useContext(RecordOpenContext).has(stepOpenKey(runN, step.key))
  // A card waiting on you inside the step (an instance it started may ask
  // after the step itself settled).
  const waiting = needs != null
  // The step the live work is going into stays open, even one marked done:
  // what is happening now is never folded away — nor what is waiting on you.
  const expanded = forced || (open ?? (live || holdsTail || waiting))
  const quiet = step.state === 'queued'
  const now = useSharedNow(live && step.startedAt != null)
  const durationMs =
    step.startedAt == null ? null : step.endedAt != null ? step.endedAt - step.startedAt : live ? now - step.startedAt : null
  const instances = instancesOf(step)
  const { onOpenAgentInstance } = useRunSession()
  const summary = stepSummaryText(step)
  const tail = step.work[step.work.length - 1]
  const showActivity = activity != null && !(tail && workIsLive(tail))
  const canOpen = step.work.length > 0 || showActivity || waiting
  const errors = step.work.filter((w) => w.kind === 'error')
  const betweenTail = step.between[step.between.length - 1]
  const showBetweenActivity = betweenActivity != null && !(betweenTail && workIsLive(betweenTail))
  return (
    <li
      className="rounded-lg"
      data-step={step.n}
      data-step-state={step.state}
      {...(step.superseded ? { 'data-step-superseded': '' } : {})}
    >
      {/* The live fill stops before the work done between this step and the
          next: that work belongs to no step, so it paints on no step's card. */}
      <div className={cn(live && 'rounded-lg bg-card')}>
      {/* The title button stretches over the whole row (its ::after), so the row
            toggles anywhere; the needs-you link sits above it as its own control. */}
        <div
          className={cn(
            'group relative flex min-h-8 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 vy-transition',
            !live && canOpen && ROW_HOVER
          )}
        >
          <StepMarker state={step.state} n={step.n} />
          <button
            type="button"
            aria-expanded={canOpen ? expanded : undefined}
            disabled={!canOpen}
            onClick={() => setOpen(!expanded)}
            className={cn(
              // The title keeps at least 40% of the row: the counts beside it give way first.
              'min-w-[40%] flex-1 truncate rounded-sm text-left text-sm after:absolute after:inset-0 after:rounded-lg focus-visible:vy-focus-ring disabled:cursor-default',
              live ? 'font-medium text-fg-strong' : quiet || step.superseded ? 'text-muted' : 'text-secondary'
            )}
          >
            {/* As words: a plan names `inputs` and **bold** the way its markdown does. */}
            {plainLine(step.title)}
          </button>
          {step.superseded ? (
            <span className="shrink-0 text-xs text-tertiary" title="A later plan dropped or renamed this step">
              replaced
            </span>
          ) : null}
          {/* The step's children, each a way into it — above the row's own
              toggle, like the needs-you link. */}
          {instances.map(({ runId, shortId }) =>
            onOpenAgentInstance ? (
              <button
                key={runId}
                type="button"
                onClick={() => onOpenAgentInstance(runId)}
                aria-label={`Open instance ${shortId}`}
                className={cn(
                  'relative z-[1] inline-flex h-[18px] shrink-0 items-center rounded-sm bg-surface px-1.5 text-muted hover:text-fg-strong focus-visible:vy-focus-ring',
                  HOVER_ON_SURFACE,
                  NUM
                )}
              >
                {shortId}
              </button>
            ) : (
              <span key={runId} className={cn('inline-flex h-[18px] shrink-0 items-center rounded-sm bg-surface px-1.5 text-muted', NUM)}>
                {shortId}
              </span>
            )
          )}
          {waiting && !expanded ? (
            // Folded away, the step still says it is waiting, and opens onto the card.
            <button
              type="button"
              onClick={(e) => {
                const row = e.currentTarget.closest('li')
                setOpen(true)
                requestAnimationFrame(() => row && showNeedsYou(row))
              }}
              className="relative z-[1] shrink-0 rounded-sm text-xs font-medium text-accent hover:underline focus-visible:vy-focus-ring"
            >
              Waiting for you
            </button>
          ) : waiting || expanded ? null : summary ? (
            // A folded step says what it holds; an open one shows it, and its
            // title gets the room ("p5: Make c14 pass — bound maxFor…" was cut for counts).
            <span className="hidden min-w-0 truncate text-xs text-tertiary @[640px]/record:inline" title={summary}>
              {summary}
            </span>
          ) : null}
          <span className="min-w-14 shrink-0 whitespace-nowrap text-right font-mono text-caption text-tertiary tnum">
            {durationMs != null && durationMs >= 1000 ? formatElapsed(durationMs) : ''}
          </span>
          {/* Sized and pulled in like the History row's, so the time shares the work rows' right edge. */}
          {canOpen ? (
            <Icon
              name={expanded ? 'chevron' : 'chevronRight'}
              size={11}
              className={cn('-ml-0.5 shrink-0 text-tertiary', !expanded && 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100')}
            />
          ) : (
            <span aria-hidden className="-ml-0.5 w-[11px] shrink-0" />
          )}
        </div>
        {expanded && canOpen ? (
          <div className="space-y-2 pb-3 pl-[36px] pr-2">
            {step.work.length > 0 ? <WorkList items={step.work} /> : null}
            {showActivity ? <NowLine text={activity!} /> : null}
            {needs}
          </div>
        ) : errors.length > 0 ? (
          // Folded, a step still shows why its run failed — and Retry with it.
          <div className="pb-3 pl-[36px] pr-2" data-step-errors={step.n}>
            <WorkList items={errors} />
          </div>
        ) : null}
      </div>
      {step.between.length > 0 || showBetweenActivity || betweenNeeds != null ? (
        // Done after this step settled and before another started: on the
        // run's own edge, never folded into the step above it — and below the
        // fill above, so it paints on no step's card.
        <div className="space-y-2 px-2 pb-3 pt-1" data-step-between={step.n}>
          {step.between.length > 0 ? <WorkList items={step.between} /> : null}
          {showBetweenActivity ? <NowLine text={betweenActivity!} /> : null}
          {betweenNeeds}
        </div>
      ) : null}
    </li>
  )
}
