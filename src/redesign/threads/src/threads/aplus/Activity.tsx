import { useState, type ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { StatusGlyph, Tooltip, cn } from '@renderer/lib/ui'
import { ROW_HOVER } from '@renderer/lib/utils/layout'
import type { Step, Turn, Work } from '../data'
import { CommandCard, DiffCard, fmtSecs, plural, turnCounts, workCounts } from '../parts'
import { fmtClock, useSeconds } from '../stream'

/*
  The work behind one reply, as one line that opens.

  It is open while the agent works, so you can watch it, and folds itself
  the moment the reply settles, so the answer — not forty rows of how — sits
  under your message. Open it again and every step is there, in the order it
  happened: what it said it would do, what it read, what it ran, what it
  changed. Lookups are one line; commands and edits keep their bordered cards.

  One left edge: the label, every step title and every item start 24px in,
  past the 16px glyph column and its 8px gap.
*/

type Phase = 'working' | 'writing' | 'needs' | 'done' | 'failed' | 'stopped'

function phaseOf(turn: Turn): Phase {
  if (turn.state === 'running') return turn.answer ? 'writing' : 'working'
  return turn.state
}

export function Activity({ turn }: { turn: Turn }) {
  const phase = phaseOf(turn)
  const watching = phase === 'working' || phase === 'needs'
  // Your toggle wins until the phase moves on; then it follows the run again.
  const [override, setOverride] = useState<{ phase: Phase; open: boolean } | null>(null)
  const open = override && override.phase === phase ? override.open : watching || phase === 'failed'
  const now = useSeconds(phase === 'working' || phase === 'needs' || phase === 'writing')
  const elapsed = turn.startedAt ? (now - turn.startedAt) / 1000 : turn.secs
  const steps = turn.steps.filter((s) => s.state !== 'queued' || watching)
  const at = turn.steps.findIndex((s) => s.state === 'running' || s.state === 'needs')
  const hasWork = turn.steps.some((s) => s.work.length > 0)

  return (
    <div role="group" aria-label="Work" data-activity={phase}>
      <button
        type="button"
        onClick={() => setOverride({ phase, open: !open })}
        aria-expanded={open}
        disabled={!hasWork && !watching}
        className={cn(
          'group -mx-2 flex h-8 w-[calc(100%+16px)] min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm focus-visible:vy-focus-ring disabled:cursor-default',
          ROW_HOVER
        )}
      >
        <span className="grid w-4 shrink-0 place-items-center">
          <PhaseGlyph phase={phase} />
        </span>
        <PhaseLabel phase={phase} secs={elapsed} />
        <span className="min-w-0 flex-1 truncate text-xs text-tertiary">
          {phase === 'working' || phase === 'needs'
            ? at >= 0
              ? `Step ${at + 1} of ${turn.steps.length} · ${turn.steps[at].title}`
              : null
            : turnCounts(turn)}
        </span>
        {watching ? <StepMeter steps={turn.steps} /> : null}
        {phase === 'working' || phase === 'needs' || phase === 'writing' ? (
          <span className="shrink-0 font-mono tnum text-caption text-tertiary">
            <span aria-hidden>{fmtClock(elapsed)}</span>
            <span className="sr-only">, {fmtSecs(elapsed)} so far</span>
          </span>
        ) : null}
        <Icon name="chevron" size={11} className={cn('shrink-0 text-tertiary transition-transform duration-200', open ? 'rotate-180' : '', !hasWork && !watching ? 'invisible' : '')} />
      </button>

      <div className="th-fold" data-open={open} inert={!open}>
        <div>
          <ol className="space-y-px pb-1 pt-0.5" aria-label="Steps">
            {steps.map((s, i) => (
              <StepItem key={`${i}-${s.title}`} step={s} />
            ))}
          </ol>
        </div>
      </div>
    </div>
  )
}

function PhaseGlyph({ phase }: { phase: Phase }) {
  if (phase === 'working' || phase === 'writing') return <StatusGlyph state="running" size={14} />
  if (phase === 'needs') return <StatusGlyph state="needs" size={14} />
  if (phase === 'failed') return <StatusGlyph state="failed" size={14} />
  if (phase === 'stopped') return <StatusGlyph state="stopped" size={14} />
  return <Icon name="checkCircle" size={15} className="text-tertiary" />
}

function PhaseLabel({ phase, secs }: { phase: Phase; secs: number }) {
  const cls = 'shrink-0'
  if (phase === 'working') return <span className={cn(cls, 'vy-text-live font-medium')}>Working</span>
  if (phase === 'writing') return <span className={cn(cls, 'vy-text-live font-medium')}>Writing the answer</span>
  if (phase === 'needs') return <span className={cn(cls, 'font-medium text-accent')}>Waiting for you</span>
  if (phase === 'failed') return <span className={cn(cls, 'text-fg')}>Failed after {fmtSecs(secs)}</span>
  if (phase === 'stopped') return <span className={cn(cls, 'text-fg')}>Stopped after {fmtSecs(secs)}</span>
  return <span className={cn(cls, 'text-secondary')}>Worked for {fmtSecs(secs)}</span>
}

/** The plan at a glance: one 2px segment per step, the live one in the accent. */
function StepMeter({ steps }: { steps: Step[] }) {
  if (steps.length < 2) return null
  return (
    <span className="flex w-16 shrink-0 gap-[2px]" aria-hidden>
      {steps.map((s, i) => (
        <span
          key={i}
          className={cn(
            'h-[3px] flex-1 rounded-full',
            s.state === 'done' ? 'bg-muted' : s.state === 'running' ? 'bg-accent' : s.state === 'needs' ? 'bg-accent' : s.state === 'failed' ? 'bg-danger' : 'bg-border'
          )}
        />
      ))}
    </span>
  )
}

/* ─── A step, and its work in order ─────────────────────────────────────── */

function StepItem({ step }: { step: Step }) {
  const live = step.state === 'running' || step.state === 'needs' || step.state === 'failed'
  const [override, setOverride] = useState<{ live: boolean; open: boolean } | null>(null)
  const open = override && override.live === live ? override.open : live
  // An approval waiting for an answer is drawn beside the reply, not in here.
  const work = step.work.filter((w) => w.kind !== 'approval' || w.answer)
  const can = work.length > 0
  return (
    <li data-step={step.state}>
      <button
        type="button"
        onClick={() => can && setOverride({ live, open: !open })}
        aria-expanded={can ? open : undefined}
        className={cn('-mx-2 flex h-7 w-[calc(100%+16px)] min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs focus-visible:vy-focus-ring', can ? ROW_HOVER : 'cursor-default')}
      >
        <span className="grid w-4 shrink-0 place-items-center">
          <StepGlyph state={step.state} />
        </span>
        <span className="min-w-0 truncate">
          <span
            className={cn(
              step.state === 'queued' ? 'text-tertiary' : step.state === 'done' ? 'text-secondary' : step.state === 'running' ? 'font-medium text-fg-strong' : 'text-fg'
            )}
          >
            {step.title}
          </span>
          {step.state === 'needs' ? <span className="text-accent"> · needs your answer</span> : null}
          {step.state === 'failed' ? <span className="text-danger"> · failed</span> : null}
          {step.state === 'stopped' ? <span className="text-tertiary"> · stopped</span> : null}
        </span>
        <span className="flex-1" />
        {!open && can ? <span className="min-w-0 truncate text-caption text-tertiary">{workCounts(work)}</span> : null}
        {step.secs != null ? (
          <span className="shrink-0 font-mono tnum text-caption text-tertiary">{fmtSecs(step.secs)}</span>
        ) : null}
        <Icon name="chevron" size={11} className={cn('shrink-0 text-tertiary transition-transform duration-200', open ? 'rotate-180' : '', can ? '' : 'invisible')} />
      </button>
      <div className="th-fold" data-open={open && can} inert={!(open && can)}>
        <div>
          <div className="space-y-1.5 pb-2 pl-6 pt-0.5">
            {work.map((w, i) => (
              <div key={i} className="th-rise">
                <WorkLine w={w} />
              </div>
            ))}
            {step.state === 'running' && !work.some((w) => w.kind === 'command' && w.live) ? <Pending /> : null}
          </div>
        </div>
      </div>
    </li>
  )
}

function StepGlyph({ state }: { state: Step['state'] }) {
  if (state === 'queued') return <span className="size-2 rounded-full border border-border-strong" />
  if (state === 'done') return <Icon name="check" size={12} className="text-tertiary" />
  return <StatusGlyph state={state} size={12} />
}

/** Three quiet dots while the live step has nothing new to show. */
function Pending() {
  return (
    <span className="flex h-5 items-center gap-1">
      {[0, 1, 2].map((i) => (
        <span key={i} aria-hidden className="th-dot size-1 rounded-full bg-muted" style={{ animationDelay: `${i * 160}ms` }} />
      ))}
      <span className="sr-only">Working</span>
    </span>
  )
}

/* ─── One item of work ──────────────────────────────────────────────────── */

function WorkLine({ w }: { w: Work }) {
  switch (w.kind) {
    case 'thought':
      return <p className="max-w-[72ch] py-0.5 text-xs leading-[20px] text-secondary">{w.text.replace(/`/g, '')}</p>
    case 'read':
      return (
        <Line verb="Read">
          <FileNames paths={w.paths} />
        </Line>
      )
    case 'search':
      return (
        <Line verb="Searched">
          <code className="truncate font-mono text-caption text-fg">{w.query}</code>
          <span className="shrink-0 text-tertiary">{plural(w.hits, 'match', 'matches')}</span>
        </Line>
      )
    case 'command':
      return <CommandCard w={w} />
    case 'edit':
      return <DiffCard w={w} defaultOpen={false} />
    case 'steer':
      return (
        <div className="flex min-w-0 items-start gap-1.5 py-0.5 text-xs leading-[20px]">
          <Icon name="chat" size={13} className="mt-[3px] shrink-0 text-tertiary" />
          <span className="shrink-0 text-tertiary">You said</span>
          <span className="min-w-0 text-fg">
            {w.text}
            {w.attachments?.length ? <span className="text-tertiary"> · {w.attachments.join(', ')}</span> : null}
          </span>
        </div>
      )
    case 'approval':
      return (
        <Line verb={w.answer === 'deny' ? 'You denied' : w.answer === 'always' ? 'You always allowed' : 'You allowed'}>
          <code className="truncate font-mono text-caption text-fg">{w.cmd}</code>
        </Line>
      )
  }
}

function Line({ verb, children }: { verb: string; children: ReactNode }) {
  return (
    <div className="flex h-6 min-w-0 items-center gap-2 text-xs">
      <span className="shrink-0 text-tertiary">{verb}</span>
      <span className="flex min-w-0 items-center gap-2">{children}</span>
    </div>
  )
}

/** File names in ink, folders on hover; past three, a count. */
function FileNames({ paths }: { paths: string[] }) {
  const shown = paths.slice(0, 3)
  return (
    <>
      {shown.map((p) => (
        <Tooltip key={p} content={p}>
          <span className="truncate font-mono text-caption text-fg">
            {p.split('/').pop()}
          </span>
        </Tooltip>
      ))}
      {paths.length > 3 ? <span className="shrink-0 text-tertiary">+{paths.length - 3}</span> : null}
    </>
  )
}
