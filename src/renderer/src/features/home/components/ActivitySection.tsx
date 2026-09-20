import { useMemo, type CSSProperties } from 'react'
import type { HomeActivityResult } from '@shared/ipc'
import { runCostDisplay } from '@shared/utils/costDisplay'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import {
  activityDayBars,
  activityOutcomeSegments,
  activityTokenTrend,
  activityToolFailures,
  formatCompactCount,
  formatCount,
  type ActivityOutcomeSegment
} from '../activityView'
import type { ActivityWindowDays } from '../useHomeActivity'
import { HomeCard, HomeNote, HomeSection } from './HomeSection'
import { ModelMix, SpendPerDay } from './ActivityCharts'

const OUTCOME_FILL: Record<ActivityOutcomeSegment['id'], string> = {
  done: 'bg-success/70',
  error: 'bg-danger/70',
  cancelled: 'bg-muted/45',
  running: 'bg-accent/70'
}

function Tile({
  label,
  value,
  hint,
  title
}: {
  label: string
  value: string
  hint?: string
  title?: string
}) {
  return (
    <div className="min-w-0 px-3 py-2.5">
      <p className="m-0 text-3xs uppercase tracking-[var(--vy-tracking-caps)] text-tertiary">
        {label}
      </p>
      <p
        className="m-0 mt-1 flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-md tabular-nums text-fg-strong"
        title={title}
      >
        <span className="truncate">{value}</span>
        {hint ? <span className="text-2xs tabular-nums text-muted">{hint}</span> : null}
      </p>
    </div>
  )
}

function WindowToggle({
  value,
  onChange
}: {
  value: ActivityWindowDays
  onChange: (next: ActivityWindowDays) => void
}) {
  return (
    <div
      role="group"
      aria-label="Activity window"
      className="flex items-center gap-0.5 rounded-md border border-border/50 p-0.5"
    >
      {([7, 30] as const).map((days) => (
        <button
          key={days}
          type="button"
          aria-pressed={value === days}
          className={cn(
            'rounded px-1.5 py-0.5 text-3xs font-medium tabular-nums vy-transition focus-visible:vy-focus-ring',
            value === days ? 'bg-surface text-fg' : 'text-muted hover:text-fg'
          )}
          onClick={() => onChange(days)}
        >
          {days}d
        </button>
      ))}
    </div>
  )
}

/**
 * Usage over a local-day window, entirely from persisted run receipts and
 * per-step usage ledgers. Missing measurements read as "—" rather than zero:
 * a provider that never reported a cost is not a free run.
 */
export function ActivitySection({
  data,
  loading,
  error,
  windowDays,
  onWindowChange,
  onRetry
}: {
  data: HomeActivityResult | null
  loading: boolean
  error: string | null
  windowDays: ActivityWindowDays
  onWindowChange: (next: ActivityWindowDays) => void
  onRetry: () => void
}) {
  const bars = useMemo(
    () => (data ? activityDayBars(data.days, data.windowDays ?? windowDays) : []),
    [data, windowDays]
  )
  const peak = useMemo(() => bars.reduce((max, bar) => Math.max(max, bar.runs), 0), [bars])
  const outcomes = useMemo(() => (data ? activityOutcomeSegments(data.outcomes) : []), [data])
  const trend = useMemo(() => (data ? activityTokenTrend(data.totals) : null), [data])
  const toolFailures = useMemo(
    () => activityToolFailures(data?.attention?.topTools),
    [data?.attention?.topTools]
  )

  const unverifiedRuns = data?.attention?.unverifiedRuns ?? 0

  const trailing = <WindowToggle value={windowDays} onChange={onWindowChange} />

  if (error) {
    return (
      <HomeSection id="home-activity-heading" title="Activity" trailing={trailing}>
        <HomeCard>
          <p className="m-0 flex flex-wrap items-center justify-between gap-2 px-3 py-4 text-xs text-muted">
            <span>Activity could not be read from this workspace&apos;s receipts.</span>
            <button
              type="button"
              className="underline underline-offset-2 vy-transition hover:text-fg focus-visible:vy-focus-ring"
              onClick={onRetry}
            >
              Retry
            </button>
          </p>
        </HomeCard>
      </HomeSection>
    )
  }

  if (!data) {
    return (
      <HomeSection id="home-activity-heading" title="Activity" trailing={trailing}>
        <HomeNote>{loading ? 'Reading run receipts…' : 'Activity is unavailable.'}</HomeNote>
      </HomeSection>
    )
  }

  const totals = data.totals
  const tokens = totals.billedInputTokens + totals.outputTokens
  const cost = runCostDisplay(totals)
  const activeDays = data.activeDays
  const span = data.windowDays ?? windowDays
  const todayKey = bars[bars.length - 1]?.date

  if (totals.runs === 0) {
    return (
      <HomeSection id="home-activity-heading" title="Activity" trailing={trailing}>
        <HomeNote>No sessions recorded in the last {span} days.</HomeNote>
      </HomeSection>
    )
  }

  return (
    <HomeSection id="home-activity-heading" title="Activity" trailing={trailing}>
      <HomeCard className="animate-fade-in">
        {/* Two up in a narrow column, four across once the card is wide enough
            for four numbers not to collide. Driven by the card, not the window:
            Activity sits in the rail on a wide screen, and that rail measures
            about 550-600px on a real display — so the threshold has to sit
            below that band, not inside it. Four 128px cells hold a caps label
            and a short number without touching. */}
        <div className="grid grid-cols-2 divide-border/40 [&>*:nth-child(-n+2)]:border-b [&>*:nth-child(-n+2)]:border-border/40 @lg:grid-cols-4 @lg:divide-x @lg:[&>*]:border-b-0">
          <Tile label="Sessions" value={formatCount(totals.runs)} />
          <Tile
            label="Tokens"
            value={formatCompactCount(tokens)}
            hint={trend?.label}
            title={`${formatCount(tokens)} billed input + output tokens`}
          />
          <Tile
            label="Cost"
            value={cost ? cost.text : '—'}
            title={cost ? cost.title : 'No provider reported a cost for these sessions'}
          />
          <Tile
            label="Active days"
            value={activeDays != null ? `${activeDays} of ${span}` : '—'}
            title={
              activeDays != null
                ? `Days with recorded activity in the last ${span} days`
                : 'Per-day activity was not reported'
            }
          />
        </div>

        <div className="border-t border-border/40 px-3 py-3">
          {/* A window can be genuinely lopsided — one busy day and six idle
              ones is a real shape. Naming the peak and keeping a baseline rule
              under every column is what stops that reading as a failed render. */}
          <div className="flex items-baseline justify-between gap-2 text-3xs text-tertiary">
            <span>Sessions per day</span>
            <span className="tabular-nums">peak {formatCount(peak)}</span>
          </div>
          <div
            role="img"
            aria-label={`Sessions per day over the last ${span} days, ${formatCount(totals.runs)} total, busiest day ${formatCount(peak)}`}
            className="mt-2 flex h-14 items-end gap-1 border-b border-border/40"
          >
            {bars.map((bar, index) => (
              <div
                key={bar.date}
                title={bar.title}
                className="flex h-full min-w-0 flex-1 items-end"
              >
                <div
                  className={cn(
                    'home-bar-enter mx-auto w-full max-w-10 rounded-t-sm vy-transition',
                    bar.runs === 0
                      ? 'bg-border/50'
                      : bar.date === todayKey
                        ? 'bg-accent/85'
                        : 'bg-accent/55'
                  )}
                  style={
                    {
                      height: bar.runs > 0 ? `${Math.max(8, bar.ratio * 100)}%` : '2px',
                      '--stagger-index': index
                    } as CSSProperties
                  }
                />
              </div>
            ))}
          </div>
          <div aria-hidden="true" className="mt-1.5 flex gap-1">
            {bars.map((bar, index) => (
              <span
                key={bar.date}
                className={cn(
                  'min-w-0 flex-1 truncate text-center text-3xs tabular-nums',
                  bar.date === todayKey ? 'text-secondary' : 'text-tertiary'
                )}
              >
                {span <= 7 || index % 5 === 0 ? bar.label : ''}
              </span>
            ))}
          </div>
        </div>

        {outcomes.length > 0 ? (
          <div className="border-t border-border/40 px-3 py-3">
            <div className="flex h-1.5 overflow-hidden rounded-full bg-border/40" aria-hidden="true">
              {outcomes.map((segment) => (
                <span
                  key={segment.id}
                  className={OUTCOME_FILL[segment.id]}
                  style={{ width: `${segment.ratio * 100}%` }}
                />
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted">
              {outcomes.map((segment) => (
                <span key={segment.id} className="inline-flex items-center gap-1.5">
                  <span
                    className={cn('size-1.5 shrink-0 rounded-full', OUTCOME_FILL[segment.id])}
                    aria-hidden="true"
                  />
                  {segment.label}
                  <span className="tabular-nums text-tertiary">{segment.count}</span>
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <SpendPerDay days={data.days} windowDays={span} />
        {data.days.some((day) => day.byModel != null) ? <ModelMix days={data.days} /> : null}

        {/* Both attention signals share one bordered band. A second band costs
            a border plus its own vertical padding, and Home is laid out to fit
            the window without scrolling — the gui-e2e `fits the window` check
            holds it to that. */}
        {unverifiedRuns > 0 || toolFailures.length > 0 ? (
          <div className="border-t border-border/40 px-3 py-3">
            {unverifiedRuns > 0 ? (
              <>
                <p className="m-0 flex items-center gap-1.5 text-3xs uppercase tracking-[var(--vy-tracking-caps)] text-tertiary">
                  <Icon name="warning" size={10} className="text-warning" aria-hidden="true" />
                  Unchecked runs
                </p>
                <p className="m-0 mt-1.5 text-2xs text-muted">
                  <span className="font-medium tabular-nums text-fg">{unverifiedRuns}</span>
                  {unverifiedRuns === 1 ? ' run' : ' runs'} changed files with no passing check
                  afterwards.
                </p>
              </>
            ) : null}

            {toolFailures.length > 0 ? (
              <div className={unverifiedRuns > 0 ? 'mt-2.5' : undefined}>
                <p className="m-0 flex items-center gap-1.5 text-3xs uppercase tracking-[var(--vy-tracking-caps)] text-tertiary">
                  <Icon name="warning" size={10} className="text-warning" aria-hidden="true" />
                  Tool failures
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted">
                  {toolFailures.map((tool) => (
                    <span key={tool.name} className="inline-flex items-center gap-1.5">
                      <span className="font-medium text-fg">{tool.name}</span>
                      <span className="tabular-nums">
                        {tool.failed} of {tool.total}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </HomeCard>
    </HomeSection>
  )
}
