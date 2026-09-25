import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { Icon, type IconName } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'

/**
 * Middle-click close for tab shells — mousedown swallows Chromium autoscroll,
 * auxclick button 1 closes. Spread onto closable tab shells only.
 */
export function tabMiddleClickHandlers(onClose: () => void): {
  onMouseDown: (e: ReactMouseEvent) => void
  onAuxClick: (e: ReactMouseEvent) => void
} {
  return {
    onMouseDown: (e) => {
      if (e.button === 1) e.preventDefault()
    },
    onAuxClick: (e) => {
      if (e.button !== 1) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }
}

/** Compact dock toolbar control — avoids Button's min-h-8 base. */
export const DOCK_TOOLBAR_BTN =
  'inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-md border border-border bg-surface px-2 text-caption leading-none text-fg hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]'

export const DOCK_TOOLBAR_ICON_BTN =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-caption leading-none text-muted hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]'

export function EmptyPanel({
  icon,
  title,
  body,
  actions,
  centered = false
}: {
  icon: IconName
  title: string
  body: string
  actions?: ReactNode
  /** Fill a flex parent and center vertically (use with `flex flex-col` on the parent). */
  centered?: boolean
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center px-8 py-10 text-center',
        centered ? 'min-h-0 flex-1' : 'h-full'
      )}
    >
      <span className="grid size-10 place-items-center rounded-lg bg-surface text-muted" aria-hidden>
        <Icon name={icon} size={18} />
      </span>
      <p className="mt-3 text-sm font-medium text-fg-strong">{title}</p>
      <p className="mt-1 max-w-[260px] text-xs leading-[18px] text-muted">{body}</p>
      {actions ? (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">{actions}</div>
      ) : null}
    </div>
  )
}
