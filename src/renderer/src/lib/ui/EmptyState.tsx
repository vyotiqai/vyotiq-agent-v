import type { ReactNode } from 'react'
import { Icon, type IconName } from '../icons'
import { cn } from './cn'

/**
 * The "nothing here yet" panel.
 *
 * Every empty surface in this app used to be a bare muted paragraph, which
 * meant each one re-decided its own spacing and none of them offered the action
 * that would end the empty state. Keep `description` to one sentence that says
 * what would fill it, and pass `action` when the user can do that from here.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
  className
}: {
  icon?: IconName
  title: string
  description?: ReactNode
  /** A button, usually — the thing that ends the empty state. */
  action?: ReactNode
  /** Tighter spacing for panels and sidebars rather than a full pane. */
  compact?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-1.5 px-3 py-6' : 'gap-2 px-4 py-12',
        className
      )}
      data-empty-state
    >
      {icon ? (
        <span
          className={cn(
            'grid place-items-center rounded-full bg-surface-2 text-muted',
            compact ? 'size-8' : 'size-11'
          )}
          aria-hidden
        >
          <Icon name={icon} size={compact ? 16 : 22} />
        </span>
      ) : null}
      <p
        className={cn(
          'm-0 tracking-[var(--vy-tracking)] text-fg-strong',
          compact ? 'text-xs' : 'text-sm'
        )}
      >
        {title}
      </p>
      {description ? (
        <p
          className={cn(
            'm-0 max-w-[42ch] leading-snug text-muted',
            compact ? 'text-2xs' : 'text-xs'
          )}
        >
          {description}
        </p>
      ) : null}
      {action ? <div className={compact ? 'mt-0.5' : 'mt-1'}>{action}</div> : null}
    </div>
  )
}
