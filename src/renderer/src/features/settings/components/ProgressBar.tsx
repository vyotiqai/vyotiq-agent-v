import { ProgressBar as Bar } from '@renderer/lib/ui'

/**
 * The shared progress track, plus the one state it has no need for elsewhere:
 * a sync or download that has not reported a fraction yet.
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
  if (percent == null || !Number.isFinite(percent)) {
    return (
      <div className="h-1 w-full overflow-hidden rounded-full bg-border" role="progressbar" aria-label={label}>
        <div className="h-full w-2/5 rounded-full bg-accent motion-safe:animate-pulse" />
      </div>
    )
  }
  return <Bar value={percent} max={100} tone="accent" label={label} />
}
