import { useContext, useState, type ReactNode } from 'react'
import { formatElapsed } from '@shared/utils/timeFormat'
import { Icon } from '@renderer/lib/icons'
import { StatusGlyph, cn } from '@renderer/lib/ui'
import { ROW_HOVER } from '@renderer/lib/utils/layout'
import { ExpandPanel } from '@renderer/features/chat/toolUi/ExpandPanel'
import type { RecordRun, WorkItem } from '../recordModel'
import { RecordOpenContext, workOpenKey } from '../recordFind'
import { plainLine } from './plainText'
import { WorkList, counted, workSummary } from './WorkItems'

/** Where the run stands, as the work line says it. */
export type WorkPhase = 'working' | 'needs' | 'writing' | 'done' | 'failed' | 'stopped'

/**
 * A run's work — its steps and the work around them — behind one line.
 *
 * It is open while the agent works, so you can watch it, and folds itself
 * once the answer is being written or the run settles with one, so the
 * answer sits under the brief instead of under every row of how. A run that
 * ended without one (failed,
 * stopped) stays open: its work is then all there is to read. A toggle of
 * yours holds until the run moves to another phase; then the line follows
 * the run again. Something waiting on you inside always holds it open, and
 * folded, the line keeps any error in view under it: it may offer Retry.
 */
export function WorkFold({
  run,
  phase,
  answered,
  waiting,
  children
}: {
  run: RecordRun
  phase: WorkPhase
  /** The run has a Result to read instead. */
  answered: boolean
  /** A card inside is waiting on you. */
  waiting: boolean
  children: ReactNode
}) {
  const [override, setOverride] = useState<{ phase: WorkPhase; open: boolean } | null>(null)
  // Dropped, not just ignored, once the phase moves on: a run asked for again
  // keeps its brief's id, and an old toggle must not hold its next answer open.
  if (override && override.phase !== phase) setOverride(null)
  // Find in record opens the line when a match is in the work behind it.
  const forced = useContext(RecordOpenContext).has(workOpenKey(run.n))
  const settledOpen = !(answered && (phase === 'done' || phase === 'writing'))
  const open = forced || waiting || (override && override.phase === phase ? override.open : settledOpen)
  // Watching the work: the line says where it is, not what it came to.
  const live = phase === 'working' || phase === 'needs'
  const errors = open ? [] : runWork(run).filter((w) => w.kind === 'error')
  const span =
    !live && phase !== 'writing' && run.startedAt != null && run.endedAt != null ? run.endedAt - run.startedAt : null
  // Time waiting on you is not work: "Worked for 4s · waited 30s for you".
  const waited = span != null ? Math.min(run.waitedMs, span) : 0
  const ms = span != null ? span - waited : null
  return (
    <section aria-label="Work" className="py-3" data-work-fold={phase}>
      <div className="-mx-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOverride({ phase, open: !open })}
          className={cn(
            'group flex min-h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm vy-transition focus-visible:vy-focus-ring',
            ROW_HOVER
          )}
        >
          <StatusGlyph state={phase === 'working' || phase === 'writing' ? 'running' : phase} size={14} />
          <PhaseLabel phase={phase} ms={ms} waitedMs={waited} />
          <span className="min-w-0 flex-1 truncate text-xs text-tertiary">{detailOf(run, live)}</span>
          <Icon
            name={open ? 'chevron' : 'chevronRight'}
            size={11}
            className={cn('-ml-0.5 shrink-0 text-tertiary', open ? '' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100')}
          />
        </button>
      </div>
      <ExpandPanel open={open}>{children}</ExpandPanel>
      {!open && errors.length > 0 ? (
        <div className="pt-1" data-work-errors>
          <WorkList items={errors} />
        </div>
      ) : null}
    </section>
  )
}

function PhaseLabel({ phase, ms, waitedMs }: { phase: WorkPhase; ms: number | null; waitedMs: number }) {
  const took = ms != null && ms >= 1000 ? formatElapsed(ms) : null
  const waited = waitedMs >= 1000 ? (
    <span className="text-tertiary" data-work-waited>
      {`waited ${formatElapsed(waitedMs)} for you`}
    </span>
  ) : null
  switch (phase) {
    case 'working':
      return <span className="shrink-0 font-medium vy-text-live">Working</span>
    case 'needs':
      return <span className="shrink-0 font-medium text-accent">Waiting for you</span>
    case 'writing':
      return <span className="shrink-0 font-medium vy-text-live">Writing the answer</span>
    case 'failed':
      return (
        <span className="shrink-0 text-fg">
          {took ? `Failed after ${took}` : 'Failed'}
          {waited ? ' · ' : null}
          {waited}
        </span>
      )
    case 'stopped':
      return (
        <span className="shrink-0 text-fg">
          {took ? `Stopped after ${took}` : 'Stopped'}
          {waited ? ' · ' : null}
          {waited}
        </span>
      )
    case 'done':
      return (
        <span className="shrink-0 text-secondary">
          {took ? `Worked for ${took}` : 'Worked'}
          {waited ? ' · ' : null}
          {waited}
        </span>
      )
  }
}

/**
 * The line's quiet half: while the run works, the step it is on; after, what
 * the work amounts to — "4 steps · 12 lookups · 3 commands · 2 edits".
 */
export function detailOf(run: RecordRun, live: boolean): string {
  const plan = run.steps.filter((s) => s.n > 0 && !s.superseded)
  if (live) {
    const going = plan.filter((s) => s.state === 'running' || s.state === 'needs')
    const failed = plan.filter((s) => s.state === 'failed').length
    // Steps run side by side when each is a child's: the first of them alone would hide the rest.
    const where =
      going.length === 1
        ? `Step ${plan.indexOf(going[0]!) + 1} of ${plan.length} · ${plainLine(going[0]!.title)}`
        : going.length > 1
          ? `${going.length} of ${plan.length} steps running`
          : ''
    if (where) return failed > 0 ? `${where} · ${failed} failed` : where
  }
  const items = runWork(run)
  // Live with none under way (planned, or between steps), the count is how far
  // it has got: "7 steps" read as seven done before any had started.
  const steps =
    plan.length === 0
      ? ''
      : live
        ? `${plan.filter((s) => s.state === 'done').length} of ${plan.length} steps done`
        : counted(plan.length, 'step')
  return [steps, workSummary(items)].filter(Boolean).join(' · ')
}

/** Every item of a run's work, in the order the record shows it. */
function runWork(run: RecordRun): WorkItem[] {
  return [...run.setup, ...run.steps.flatMap((s) => [...s.work, ...s.between]), ...run.after]
}
