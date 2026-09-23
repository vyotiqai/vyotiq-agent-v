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
 * A fill ring for a 0–1 ratio: context used, a budget spent. It turns warning
 * at 70% and danger at 90% — the colour is backed by the number beside it.
 */
export function Ring({ value, size = 16, stroke = 2 }: { value: number; size?: number; stroke?: number }) {
  const v = Math.max(0, Math.min(1, value))
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const tone = v >= 0.9 ? 'text-danger' : v >= 0.7 ? 'text-warning' : 'text-fg'
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn('shrink-0 -rotate-90', tone)}
      aria-hidden="true"
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--vy-border-strong)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeDasharray={`${c * v} ${c}`}
        strokeLinecap="round"
      />
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
