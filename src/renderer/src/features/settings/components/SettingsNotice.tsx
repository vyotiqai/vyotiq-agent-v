import type { ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'

/**
 * A sentence above a section's groups: the workspace-override banner, a
 * degraded-capability warning. Three sections had hand-rolled copies of the
 * same `rounded-xl bg-surface px-4 py-3 text-xs` paragraph that had already
 * drifted apart in tone colour, so it lives here once.
 *
 * A warning carries an icon as well as its colour, so the tone never rests on
 * hue alone. Not an error: `Alert` owns those, and a failed write should not
 * look like standing context.
 */
export function SettingsNotice({
  tone = 'info',
  children
}: {
  tone?: 'info' | 'warning'
  children: ReactNode
}) {
  return (
    <p
      className={cn(
        'm-0 flex items-start gap-2 rounded-xl bg-surface px-4 py-3 text-xs leading-snug [overflow-wrap:anywhere]',
        tone === 'warning' ? 'text-warning' : 'text-secondary'
      )}
      role="status"
    >
      {tone === 'warning' ? <Icon name="warning" size={14} className="mt-px" /> : null}
      <span className="min-w-0">{children}</span>
    </p>
  )
}
