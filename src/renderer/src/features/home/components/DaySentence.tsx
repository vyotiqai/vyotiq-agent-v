import type { ReactNode } from 'react'
import type { HomeActivityResult } from '@shared/ipc'
import { runCostDisplay } from '@shared/utils/costDisplay'
import { Icon } from '@renderer/lib/icons'
import { Button, StatusGlyph, cn } from '@renderer/lib/ui'
import type { NavRow } from '@renderer/app/navigator/navigatorModel'
import { formatCompactCount } from '../activityView'
import type { FactKey, Segment } from '../daySentence'
import { HomeLink, HomeRow, HomeSection } from './HomeBlocks'

/** What one of Home's controls opens under the sentence. A fact and a footer item may open the same one. */
export type HomeRegion = 'needs' | 'failed' | 'running' | 'review' | 'schedule' | 'workspaces' | 'week'

/** The region a fact opens: uncommitted files open the workspaces they sit in. */
export const REGION_OF: Record<FactKey, HomeRegion> = {
  needs: 'needs',
  failed: 'failed',
  running: 'running',
  review: 'review',
  schedule: 'schedule',
  changes: 'workspaces',
  week: 'week'
}

/** The id every disclosure on Home names in aria-controls. */
export const HOME_DETAIL_ID = 'home-detail'

/** The day, large on the left edge; the date on the right edge, quieter as it gets less useful. */
export function DayHead({ now, wants }: { now: Date; wants: boolean }) {
  return (
    <div className="flex items-end justify-between gap-6">
      <h1 className="flex items-center gap-2.5 text-display font-semibold tracking-[var(--vy-tracking-tight)] text-fg-strong">
        {now.toLocaleDateString(undefined, { weekday: 'long' })}
        {/* The sentence says what wants you; the dot only repeats it at a glance. */}
        {wants ? <span aria-hidden="true" className="size-2 rounded-full bg-accent" data-home-wants /> : null}
      </h1>
      <div className="text-right text-sm leading-5">
        <div className="text-muted">{now.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</div>
        <div className="text-tertiary">{now.getFullYear()}</div>
      </div>
    </div>
  )
}

const FACT_GLYPH: Record<FactKey, ReactNode> = {
  needs: <StatusGlyph state="needs" size={15} />,
  failed: <StatusGlyph state="failed" size={15} />,
  running: <StatusGlyph state="running" size={15} />,
  review: <StatusGlyph state="review" size={15} />,
  schedule: <Icon name="repeat" size={15} className="text-muted" />,
  changes: <Icon name="diff" size={15} className="text-muted" />,
  week: <Icon name="checkCircle" size={15} className="text-muted" />
}

/**
 * The sentence: joiners in muted, facts in fg-strong, each fact a disclosure
 * for its rows under the sentence; the open one carries the selected fill.
 */
export function Sentence({
  segments,
  open,
  onToggle
}: {
  segments: readonly Segment[]
  open: HomeRegion | null
  onToggle: (region: HomeRegion) => void
}) {
  return (
    <p className="mt-6 max-w-[640px] text-title leading-[32px] text-muted" data-day-sentence>
      {segments.map((s, i) =>
        s.kind === 'words' ? (
          <span key={i}>{s.text}</span>
        ) : s.kind === 'name' ? (
          <span key={i} className="text-fg">
            {s.text}
          </span>
        ) : (
          <button
            key={i}
            type="button"
            aria-expanded={open === REGION_OF[s.fact.key]}
            aria-controls={HOME_DETAIL_ID}
            data-fact={s.fact.key}
            onClick={() => onToggle(REGION_OF[s.fact.key])}
            className={cn(
              // The fill reaches 4px left (into the space before the fact) but only 2px right,
              // so it never covers the comma or full stop that hugs the fact.
              '-ml-1 inline-flex items-baseline gap-1.5 rounded-md pl-1 pr-0.5 align-baseline font-medium text-fg-strong vy-transition focus-visible:vy-focus-ring',
              open === REGION_OF[s.fact.key] ? 'bg-surface-2' : 'hover:bg-surface'
            )}
          >
            <span className="self-center">{FACT_GLYPH[s.fact.key]}</span>
            {s.fact.text}
          </button>
        )
      )}
    </p>
  )
}

/**
 * Running, review and failed tasks as Home rows: the navigator's own rows,
 * opened from the sentence. Each glyph is the row's own state (a failed run
 * with edits left reads failed under review, as in the navigator), and the
 * second line says what it is doing or why it stands where it does.
 */
export function TaskRowsSection({
  id,
  label,
  rows,
  onOpen,
  onRetry
}: {
  id: string
  label: string
  rows: readonly NavRow[]
  onOpen: (row: NavRow) => void
  onRetry?: (row: NavRow) => void
}) {
  return (
    <HomeSection id={id} label={label}>
      {rows.map((row) => {
        const { run } = row
        const files = run.review ? `${run.review.files} ${run.review.files === 1 ? 'file' : 'files'} to keep or undo` : null
        const meta =
          row.state === 'running'
            ? (row.activity ?? 'Working')
            : row.state === 'queued'
              ? row.stateLabel
              : row.state === 'failed'
                ? [run.error ?? 'Failed', files].filter(Boolean).join(' · ')
                : (files ?? row.stateLabel)
        return (
          <HomeRow key={`${row.workspacePath}:${row.runId}`}>
            <StatusGlyph state={row.state} size={14} label />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-fg">{row.title}</span>
              <span className="block truncate text-xs text-muted">
                {meta} · {row.workspaceName}
              </span>
            </span>
            {row.steps ? (
              <span className="font-mono text-xs tabular-nums text-tertiary" title={`Step ${row.steps.current} of ${row.steps.total}`}>
                {row.steps.current}/{row.steps.total}
              </span>
            ) : null}
            {row.state === 'failed' && run.retryable && onRetry ? (
              <Button size="xs" variant="secondary" onClick={() => onRetry(row)}>
                Retry
              </Button>
            ) : null}
            <Button
              size="xs"
              variant={run.review ? 'secondary' : 'ghost'}
              aria-label={`${run.review ? 'Review' : 'Open'} ${row.title}`}
              onClick={() => onOpen(row)}
            >
              {run.review ? 'Review' : 'Open'}
            </Button>
          </HomeRow>
        )
      })}
    </HomeSection>
  )
}

/**
 * The quiet line at Home's foot: the workspaces and the week, each a
 * disclosure into the same region the sentence uses, so both stay reachable
 * when the sentence names neither; then tokens, spend and Usage.
 */
export function HomeFootLine({
  workspaces,
  activity,
  open,
  onToggle,
  onOpenUsage
}: {
  workspaces: number
  activity: HomeActivityResult | null
  open: HomeRegion | null
  onToggle: (region: HomeRegion) => void
  onOpenUsage: () => void
}) {
  const totals = activity?.totals
  const cost = runCostDisplay(totals)
  const item = (region: HomeRegion, icon: 'workspace' | 'tasks', text: string) => (
    <button
      type="button"
      aria-expanded={open === region}
      aria-controls={HOME_DETAIL_ID}
      data-foot={region}
      onClick={() => onToggle(region)}
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-sm px-1 -mx-1 vy-transition focus-visible:vy-focus-ring',
        open === region ? 'bg-surface-2 text-fg-strong' : 'hover:bg-surface hover:text-fg'
      )}
    >
      <Icon name={icon} size={13} />
      {text}
    </button>
  )
  return (
    <div className="mt-12 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted" data-home-foot>
      {item('workspaces', 'workspace', `${workspaces} ${workspaces === 1 ? 'workspace' : 'workspaces'}`)}
      {totals ? item('week', 'tasks', `${totals.runs} ${totals.runs === 1 ? 'task' : 'tasks'} this week`) : null}
      {totals ? (
        <span className="inline-flex items-center gap-1.5">
          <Icon name="gauge" size={13} />
          {formatCompactCount(totals.billedInputTokens + totals.outputTokens)} tokens
        </span>
      ) : null}
      {cost ? (
        <span className="inline-flex items-center gap-1.5" title={cost.title}>
          <Icon name="cost" size={13} />
          {cost.text}
        </span>
      ) : null}
      <span className="flex-1" />
      <HomeLink onClick={onOpenUsage}>Usage</HomeLink>
    </div>
  )
}
