import { memo, useId, useMemo } from 'react'
import type { ChartSpec } from '@shared/chartSpec'
import { CodeBlockCopyButton } from './CodeBlockCopyButton'
import { buildLineSegments, smoothLinePath } from './lineChart'

/** Virtual viewBox width; the svg stretches non-uniformly, strokes stay 1.5px. */
const LINE_VIEW_WIDTH = 600
const LINE_HEIGHT = 96
const SPARK_HEIGHT = 32
/** Ring geometry. */
const DONUT_SIZE = 88
const DONUT_RADIUS = 30
const DONUT_STROKE = 12

/** Opacity ladder over existing theme tokens — no new palette, no rainbow. */
const SLICE_FILLS: ReadonlyArray<{ color: string; opacity: number }> = [
  { color: 'var(--vy-accent)', opacity: 1 },
  { color: 'var(--vy-accent)', opacity: 0.55 },
  { color: 'var(--vy-tertiary)', opacity: 0.5 },
  { color: 'var(--vy-muted)', opacity: 0.45 },
  { color: 'var(--vy-accent)', opacity: 0.32 },
  { color: 'var(--vy-tertiary)', opacity: 0.3 },
  { color: 'var(--vy-muted)', opacity: 0.28 },
  { color: 'var(--vy-accent)', opacity: 0.18 }
]

function formatChartValue(value: number): string {
  if (value >= 1_000_000) {
    const m = value / 1_000_000
    return `${m >= 10 ? Math.round(m) : Number(m.toFixed(1))}M`
  }
  if (value >= 1_000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (value >= 10) return String(Number(value.toFixed(1)))
  return String(Number(value.toFixed(2)))
}

/** Show enough axis ticks to stay readable regardless of point count. */
function axisStep(count: number): number {
  return Math.max(1, Math.ceil(count / 12))
}

function NoDataNote() {
  return <p className="m-0 py-4 text-center text-2xs text-muted">No data points in this chart.</p>
}

function BarChart({
  labels,
  values
}: {
  labels: readonly string[]
  values: readonly (number | null)[]
}) {
  const measured = values.filter((v): v is number => v != null && v > 0)
  const max = measured.length > 0 ? Math.max(...measured) : 0
  const step = axisStep(labels.length)
  return (
    <>
      <div
        role="img"
        aria-label={`Bar chart with ${values.length} points`}
        className="mt-2 flex h-24 items-end gap-1 border-b border-border/40"
      >
        {values.map((value, index) => (
          <div key={index} className="flex h-full min-w-0 flex-1 items-end">
            {value == null ? null : value === 0 ? (
              <div className="h-[2px] w-full rounded-t-sm bg-border/50" />
            ) : (
              <div
                className="w-full rounded-t-sm bg-accent/55 vy-transition"
                style={{ height: `${Math.max(4, (value / max) * 100)}%` }}
                title={`${labels[index] ?? `#${index + 1}`} — ${formatChartValue(value)}`}
              />
            )}
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="mt-1.5 flex gap-1">
        {labels.map((label, index) => (
          <span
            key={index}
            className="min-w-0 flex-1 truncate text-center text-3xs tabular-nums text-tertiary"
          >
            {index % step === 0 ? label : ''}
          </span>
        ))}
      </div>
    </>
  )
}

function LineChart({
  labels,
  values
}: {
  labels: readonly string[]
  values: readonly (number | null)[]
}) {
  const gradientId = `${useId().replace(/[^a-zA-Z0-9]/g, '')}-vy-chart-area`
  const { segments, max } = useMemo(
    () => buildLineSegments(values, LINE_VIEW_WIDTH, LINE_HEIGHT),
    [values]
  )
  if (max <= 0) return <NoDataNote />
  const step = axisStep(labels.length)
  return (
    <>
      <div
        role="img"
        aria-label={`Line chart with ${values.length} points`}
        className="relative mt-2"
      >
        <svg
          viewBox={`0 0 ${LINE_VIEW_WIDTH} ${LINE_HEIGHT}`}
          preserveAspectRatio="none"
          className="block w-full"
          style={{ height: LINE_HEIGHT }}
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
            y1={LINE_HEIGHT - 2}
            x2={LINE_VIEW_WIDTH}
            y2={LINE_HEIGHT - 2}
            stroke="var(--vy-border)"
            strokeOpacity="0.4"
            vectorEffect="non-scaling-stroke"
          />
          {segments.map((segment, segmentIndex) => {
            const line = smoothLinePath(segment)
            const first = segment[0]!
            const last = segment[segment.length - 1]!
            const area = `${line} L ${last.x.toFixed(2)} ${LINE_HEIGHT - 2} L ${first.x.toFixed(2)} ${LINE_HEIGHT - 2} Z`
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
            title={`${labels[point.index] ?? `#${point.index + 1}`} — ${formatChartValue(point.value)}`}
            className="absolute size-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
            style={{
              left: `${(point.x / LINE_VIEW_WIDTH) * 100}%`,
              top: `${(point.y / LINE_HEIGHT) * 100}%`
            }}
          />
        ))}
      </div>
      <div aria-hidden="true" className="mt-1.5 flex gap-1">
        {labels.map((label, index) => (
          <span
            key={index}
            className="min-w-0 flex-1 truncate text-center text-3xs tabular-nums text-tertiary"
          >
            {index % step === 0 ? label : ''}
          </span>
        ))}
      </div>
    </>
  )
}

function DonutChart({
  labels,
  values
}: {
  labels: readonly string[]
  values: readonly number[]
}) {
  const total = values.reduce<number>((sum, v) => sum + v, 0)
  if (total <= 0) return <NoDataNote />
  const circumference = 2 * Math.PI * DONUT_RADIUS
  const lengths = values.map((value) => (value / total) * circumference)
  // Prefix sums (≤8 slices) — no render-time mutation in callbacks.
  const offsets = lengths.map((_, index) =>
    lengths.slice(0, index).reduce((sum, length) => sum + length, 0)
  )
  const slices = lengths.map((length, index) => ({
    index,
    value: values[index]!,
    length,
    dashOffset: -offsets[index]!,
    fill: SLICE_FILLS[index % SLICE_FILLS.length]!
  }))
  return (
    <div className="mt-2 flex items-center gap-4" role="img" aria-label="Donut chart">
      <svg
        width={DONUT_SIZE}
        height={DONUT_SIZE}
        viewBox={`0 0 ${DONUT_SIZE} ${DONUT_SIZE}`}
        className="shrink-0"
        aria-hidden="true"
      >
        {slices.map((slice) => (
          <circle
            key={slice.index}
            cx={DONUT_SIZE / 2}
            cy={DONUT_SIZE / 2}
            r={DONUT_RADIUS}
            fill="none"
            stroke={slice.fill.color}
            strokeOpacity={slice.fill.opacity}
            strokeWidth={DONUT_STROKE}
            strokeDasharray={`${slice.length.toFixed(2)} ${(circumference - slice.length).toFixed(2)}`}
            strokeDashoffset={slice.dashOffset.toFixed(2)}
            transform={`rotate(-90 ${DONUT_SIZE / 2} ${DONUT_SIZE / 2})`}
          >
            <title>{`${labels[slice.index] ?? `#${slice.index + 1}`} — ${formatChartValue(slice.value)}`}</title>
          </circle>
        ))}
        <text
          x={DONUT_SIZE / 2}
          y={DONUT_SIZE / 2 - 2}
          textAnchor="middle"
          fontSize="11"
          fontWeight="600"
          fill="var(--vy-fg-strong)"
        >
          {formatChartValue(total)}
        </text>
        <text
          x={DONUT_SIZE / 2}
          y={DONUT_SIZE / 2 + 11}
          textAnchor="middle"
          fontSize="8"
          letterSpacing="0.06em"
          fill="var(--vy-tertiary)"
        >
          TOTAL
        </text>
      </svg>
      <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-2xs text-muted">
        {slices.map((slice) => (
          <span key={slice.index} className="inline-flex items-center gap-1.5">
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ background: slice.fill.color, opacity: slice.fill.opacity }}
              aria-hidden="true"
            />
            <span className="max-w-[160px] truncate font-medium text-fg">
              {labels[slice.index] ?? `#${slice.index + 1}`}
            </span>
            <span className="tabular-nums text-tertiary">
              {formatChartValue(slice.value)} · {Math.round((slice.value / total) * 100)}%
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

function Sparkline({ values }: { values: readonly (number | null)[] }) {
  const gradientId = `${useId().replace(/[^a-zA-Z0-9]/g, '')}-vy-chart-spark`
  const { segments, max } = useMemo(
    () => buildLineSegments(values, LINE_VIEW_WIDTH, SPARK_HEIGHT),
    [values]
  )
  if (max <= 0) return <NoDataNote />
  return (
    <div role="img" aria-label="Sparkline" className="mt-2">
      <svg
        viewBox={`0 0 ${LINE_VIEW_WIDTH} ${SPARK_HEIGHT}`}
        preserveAspectRatio="none"
        className="block w-full"
        style={{ height: SPARK_HEIGHT }}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--vy-accent)" stopOpacity="0.16" />
            <stop offset="1" stopColor="var(--vy-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {segments.map((segment, segmentIndex) => {
          const line = smoothLinePath(segment)
          const first = segment[0]!
          const last = segment[segment.length - 1]!
          const area = `${line} L ${last.x.toFixed(2)} ${SPARK_HEIGHT - 1} L ${first.x.toFixed(2)} ${SPARK_HEIGHT - 1} Z`
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
    </div>
  )
}

/**
 * Renders a settled ```chart fence from a parsed, schema-validated spec. The
 * schema is the trust boundary — the component only ever sees clean data.
 * Invalid specs never reach this component; the fence falls back to code.
 */
export const ChartBlock = memo(function ChartBlock({ spec }: { spec: ChartSpec }) {
  return (
    <div className="group/code relative my-2" data-chart-block="">
      <CodeBlockCopyButton text={JSON.stringify(spec, null, 2)} />
      <div className="overflow-x-auto rounded-md border border-border bg-surface p-3">
        {spec.title ? (
          <p className="m-0 mb-2 text-3xs uppercase tracking-[var(--vy-tracking-caps)] text-tertiary">
            {spec.title}
          </p>
        ) : null}
        {spec.type === 'bar' ? <BarChart labels={spec.labels} values={spec.values} /> : null}
        {spec.type === 'line' ? <LineChart labels={spec.labels} values={spec.values} /> : null}
        {spec.type === 'donut' ? <DonutChart labels={spec.labels} values={spec.values} /> : null}
        {spec.type === 'sparkline' ? <Sparkline values={spec.values} /> : null}
      </div>
    </div>
  )
})
