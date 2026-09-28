import { cn } from './cn'

const fillTone = {
  neutral: 'bg-fg',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger'
} as const

export function ProgressBar({
  value,
  max = 1,
  tone = 'neutral',
  flush = false,
  className,
  label
}: {
  value: number
  max?: number
  tone?: keyof typeof fillTone
  /** Edge-to-edge 2px rule with square ends — for a bar that doubles as a divider. */
  flush?: boolean
  /** No width of its own when given: callers size it. */
  className?: string
  label?: string
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
  return (
    <div
      className={cn('overflow-hidden bg-border', flush ? 'h-0.5' : 'h-1 rounded-full', className ?? 'w-full')}
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={cn('h-full', !flush && 'rounded-full', fillTone[tone])} style={{ width: `${pct}%` }} />
    </div>
  )
}

/**
 * Below this share the pie draws its outline only. Any thinner wedge is a line
 * from the centre at this size — it read as a clock hand, the way a short arc
 * read as a spinner. The number beside the pie carries the exact share.
 */
const PIE_MIN_SHARE = 0.1

/**
 * A pie for a 0–1 ratio: context used, a budget spent — an outline, and a
 * wedge from twelve o'clock. Not a ring: at small sizes a short round-capped
 * arc on a track is a loading spinner's shape, and "3%" beside one read as
 * something loading. It turns warning at 70% and danger at 90% — the colour
 * is backed by the number beside it.
 */
export function Pie({ value, size = 16 }: { value: number; size?: number }) {
  const v = Math.max(0, Math.min(1, value))
  const c = size / 2
  const outer = c - 0.5
  // A hairline of air between the outline and the wedge keeps both legible.
  const r = outer - 1.5
  const a = v * 2 * Math.PI
  const tone = v >= 0.9 ? 'text-danger' : v >= 0.7 ? 'text-warning' : 'text-fg'
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cn('shrink-0', tone)} aria-hidden="true">
      <circle cx={c} cy={c} r={outer} fill="none" stroke="currentColor" strokeWidth={1} />
      {v >= 1 ? (
        <circle cx={c} cy={c} r={r} fill="currentColor" data-pie-fill />
      ) : v >= PIE_MIN_SHARE ? (
        <path
          d={`M${c} ${c}V${c - r}A${r} ${r} 0 ${a > Math.PI ? 1 : 0} 1 ${c + r * Math.sin(a)} ${c - r * Math.cos(a)}Z`}
          fill="currentColor"
          data-pie-fill
        />
      ) : null}
    </svg>
  )
}

/** Tiny bars for a 7- or 30-day trend. Zero days draw a stub, not nothing. */
export function Sparkbars({
  values,
  highlightLast = true,
  className
}: {
  values: readonly number[]
  highlightLast?: boolean
  className?: string
}) {
  const max = Math.max(1, ...values)
  return (
    <div className={cn('flex h-10 items-end gap-[3px]', className)} aria-hidden="true">
      {values.map((v, i) => (
        <span
          key={i}
          className={cn(
            'w-full rounded-[2px]',
            highlightLast && i === values.length - 1 ? 'bg-accent' : v === 0 ? 'bg-border' : 'bg-border-strong'
          )}
          style={{ height: v === 0 ? 2 : `${Math.max(12, (v / max) * 100)}%` }}
        />
      ))}
    </div>
  )
}
