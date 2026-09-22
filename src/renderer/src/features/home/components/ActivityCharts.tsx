import { useId, useMemo, useState } from 'react'
import type { HomeActivityDay } from '@shared/ipc'
import { activityModelMix, activitySpendSeries, formatCompactCount } from '../activityView'
import { cn } from '@renderer/lib/ui'
import { buildLineSegments, smoothLinePath } from '@renderer/lib/ui/lineChart'

/** Plot height in px — a step up from the sessions chart it sits beside. */
const SPEND_CHART_HEIGHT = 64
/**
 * Virtual viewBox width; the svg stretches non-uniformly so only ratios
 * matter, and `vector-effect` keeps strokes 1.5px regardless of the stretch.
 */
const SPEND_VIEW_WIDTH = 600
/** Named slices before the tail folds into "Other". */
const MODEL_MIX_NAMED = 3

const MODEL_MIX_FILL = ['bg-accent', 'bg-accent/55', 'bg-tertiary/50'] as const
const MODEL_MIX_OTHER_FILL = 'bg-muted/40'

type SpendMetric = 'cost' | 'tokens'

/** Cost reads as $4.90; tokens reuse the compact magnitudes of the tiles. */
function spendValueText(metric: SpendMetric, value: number): string {
  return metric === 'cost' ? `$${value.toFixed(2)}` : formatCompactCount(value)
}

function metricLabel(metric: SpendMetric): string {
  return metric === 'cost' ? 'Spend per day' : 'Tokens per day'
}

function MetricToggle({
  value,
  onChange
}: {
  value: SpendMetric
  onChange: (next: SpendMetric) => void
}) {
  return (
    <div
      role="group"
      aria-label="Spend chart metric"
      className="flex items-center gap-0.5 rounded-md border border-border p-0.5"
    >
      {(['cost', 'tokens'] as const).map((metric) => (
        <button
          key={metric}
          type="button"
          aria-pressed={value === metric}
          className={cn(
            'rounded px-1.5 py-0.5 text-3xs font-medium capitalize vy-transition focus-visible:vy-focus-ring',
            value === metric ? 'bg-surface text-fg' : 'text-muted hover:text-fg'
          )}
          onClick={() => onChange(metric)}
        >
          {metric}
        </button>
      ))}
    </div>
  )
}

/**
 * Spend (or tokens) per local day as an area line. Days nobody reported a
 * cost for, and days with no usage, are gaps in the line — never fake zeros.
 * The metric defaults to whichever this window actually has data for, so a
 * free-model window lands on tokens instead of a dead cost chart. Axis rules
 * mirror the sessions chart: weekday ticks for 7 days, day-of-month every 5th
 * tick beyond that, today last.
 */
export function SpendPerDay({
  days,
  windowDays
}: {
  days: readonly HomeActivityDay[]
  windowDays: number
}) {
  // Null until the user picks a side; derived from the data meanwhile.
  const [chosen, setChosen] = useState<SpendMetric | null>(null)
  const gradientId = `${useId().replace(/[^a-zA-Z0-9]/g, '')}-spend-area`
  const series = useMemo(() => activitySpendSeries(days, windowDays), [days, windowDays])
  const hasCost = useMemo(() => series.some((point) => point.cost != null), [series])
  const metric = chosen ?? (hasCost ? 'cost' : 'tokens')

  const values = useMemo(
    () => series.map((point) => (metric === 'cost' ? point.cost : point.tokens)),
    [series, metric]
  )
  const { segments, total } = useMemo(
    () => buildLineSegments(values, SPEND_VIEW_WIDTH, SPEND_CHART_HEIGHT),
    [values]
  )

  // An empty window is "no data" — the same "—" the COST tile shows — never
  // a fabricated "total $0.00" that claims the spend was measured at zero.
  const totalText = segments.length === 0 ? '—' : spendValueText(metric, total)

  return (
    <div className="border-t border-border/40 px-3 py-3">
      <div className="flex items-center justify-between gap-2 text-3xs text-tertiary">
        <span className="uppercase tracking-[var(--vy-tracking-caps)]">{metricLabel(metric)}</span>
        <span className="flex items-center gap-2">
          <span className="tabular-nums">
            {segments.length === 0 ? '—' : `total ${totalText}`}
          </span>
          <MetricToggle value={metric} onChange={setChosen} />
        </span>
      </div>
      {segments.length === 0 ? (
        <p className="m-0 py-4 text-center text-2xs text-muted">
          {metric === 'cost'
            ? 'No provider-reported cost in this window.'
            : 'No token usage recorded in this window.'}
        </p>
      ) : (
        <>
          <div
            role="img"
            aria-label={`${metricLabel(metric)} over the last ${windowDays} days, total ${totalText}`}
            className="relative mt-2"
          >
            <svg
              viewBox={`0 0 ${SPEND_VIEW_WIDTH} ${SPEND_CHART_HEIGHT}`}
              preserveAspectRatio="none"
              className="block w-full"
              style={{ height: SPEND_CHART_HEIGHT }}
              aria-hidden="true"
            >
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="var(--vy-accent)" stopOpacity="0.2" />
                  <stop offset="1" stopColor="var(--vy-accent)" stopOpacity="0" />
                </linearGradient>
              </defs>
              <line
                x1="0"
                y1={SPEND_CHART_HEIGHT - 2}
                x2={SPEND_VIEW_WIDTH}
                y2={SPEND_CHART_HEIGHT - 2}
                stroke="var(--vy-border)"
                strokeOpacity="0.4"
                vectorEffect="non-scaling-stroke"
              />
              {segments.map((segment, segmentIndex) => {
                const line = smoothLinePath(segment)
                const first = segment[0]!
                const last = segment[segment.length - 1]!
                const area = `${line} L ${last.x.toFixed(2)} ${SPEND_CHART_HEIGHT - 2} L ${first.x.toFixed(2)} ${SPEND_CHART_HEIGHT - 2} Z`
                return (
                  <g key={segmentIndex}>
                    <path d={area} fill={`url(#${gradientId})`} />
                    <path
                      d={line}
                      fill="none"
                      stroke="var(--vy-accent)"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                )
              })}
            </svg>
            {segments.flat().map((point) => (
              <span
                key={point.index}
                title={`${series[point.index]!.dateLabel} — ${spendValueText(metric, point.value)}`}
                className="absolute size-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
                style={{
                  left: `${(point.x / SPEND_VIEW_WIDTH) * 100}%`,
                  top: `${(point.y / SPEND_CHART_HEIGHT) * 100}%`
                }}
              />
            ))}
          </div>
          <div aria-hidden="true" className="mt-1.5 flex gap-1">
            {series.map((point, index) => (
              <span
                key={point.date}
                className={cn(
                  'min-w-0 flex-1 truncate text-center text-3xs tabular-nums',
                  index === series.length - 1 ? 'text-secondary' : 'text-tertiary'
                )}
              >
                {windowDays <= 7 || index % 5 === 0 ? point.label : ''}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Output-token share per model across the window, from the per-day `byModel`
 * ledgers. The largest models are named and the tail folds into "Other" so
 * the stacked bar stays legible no matter how many models a window touches.
 */
export function ModelMix({ days }: { days: readonly HomeActivityDay[] }) {
  const slices = useMemo(() => activityModelMix(days), [days])
  const named = slices.slice(0, MODEL_MIX_NAMED)
  const rest = slices.slice(MODEL_MIX_NAMED)
  const restTokens = rest.reduce((sum, slice) => sum + slice.tokens, 0)
  const total = slices.reduce((sum, slice) => sum + slice.tokens, 0)
  if (slices.length === 0) return null

  const bars = [
    ...named.map((slice, index) => ({ ...slice, fill: MODEL_MIX_FILL[index]! })),
    ...(restTokens > 0
      ? [
          {
            model: `Other (${rest.length})`,
            tokens: restTokens,
            ratio: restTokens / total,
            fill: MODEL_MIX_OTHER_FILL
          }
        ]
      : [])
  ]

  return (
    <div className="border-t border-border/40 px-3 py-3">
      <div className="flex items-baseline justify-between gap-2 text-3xs text-tertiary">
        <span className="uppercase tracking-[var(--vy-tracking-caps)]">Model mix</span>
        <span className="tabular-nums">{formatCompactCount(total)} output tokens</span>
      </div>
      <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-border/40" aria-hidden="true">
        {bars.map((bar) => (
          <span key={bar.model} className={bar.fill} style={{ width: `${bar.ratio * 100}%` }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted">
        {bars.map((bar) => (
          <span key={bar.model} className="inline-flex items-center gap-1.5">
            <span className={cn('size-1.5 shrink-0 rounded-full', bar.fill)} aria-hidden="true" />
            <span className="max-w-[160px] truncate font-medium text-fg" title={bar.model}>
              {bar.model}
            </span>
            <span className="tabular-nums text-tertiary">
              {formatCompactCount(bar.tokens)} · {Math.round(bar.ratio * 100)}%
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}
