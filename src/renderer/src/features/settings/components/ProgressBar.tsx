import { DIVIDER_FILL } from '@renderer/lib/utils/layout'
import { cn } from '@renderer/lib/ui'

/**
 * Determinate or indeterminate progress track, shared by the code index sync
 * and the Whisper model download. Both drew the same 1.5px bar with the same
 * accent fill; only the indeterminate case differed, and only because one of
 * them had never needed it.
 *
 * `percent === null` renders the indeterminate pulse and drops the
 * `aria-value*` attributes, which is what a screen reader needs to announce
 * "busy" rather than "0 percent".
 */
export function ProgressBar({
  percent,
  label
}: {
  percent: number | null
  label: string
}) {
  const pct =
    percent != null && Number.isFinite(percent)
      ? Math.max(0, Math.min(100, Math.round(percent)))
      : null

  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded-sm', DIVIDER_FILL)}
      role="progressbar"
      aria-valuemin={pct == null ? undefined : 0}
      aria-valuemax={pct == null ? undefined : 100}
      aria-valuenow={pct ?? undefined}
      aria-label={label}
    >
      <div
        className={
          pct == null
            ? 'h-full w-2/5 bg-accent motion-safe:animate-pulse'
            : 'h-full bg-accent transition-[width] duration-100 ease-linear'
        }
        style={pct == null ? undefined : { width: `${pct}%` }}
      />
    </div>
  )
}
