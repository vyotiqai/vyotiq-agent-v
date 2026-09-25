import type { ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'

/**
 * A sentence above a section's groups: a degraded-capability warning. It
 * sits in the page's own rhythm (the `mt-6` every group has) rather than in a
 * card, so it reads as part of the section it qualifies.
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
        'm-0 mt-6 flex items-start gap-2 text-xs leading-[18px] [overflow-wrap:anywhere]',
        tone === 'warning' ? 'text-warning' : 'text-secondary'
      )}
      role="status"
    >
      {tone === 'warning' ? <Icon name="warning" size={14} className="mt-0.5 shrink-0" /> : null}
      <span className="min-w-0">{children}</span>
    </p>
  )
}
