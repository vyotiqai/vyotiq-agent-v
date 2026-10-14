import { useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { ActionMenu, Tooltip, cn, type ActionMenuItem } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'

/**
 * New task's one action, with the other ways a brief can end beside it: the
 * button starts the task, its caret opens Save as draft, Schedule… and Also
 * run on. Both halves are the primary fill; the caret stays usable while
 * Start is not (a draft can be saved before the brief could start).
 */
export function StartSplit({
  children,
  chord,
  keyShortcuts,
  disabled,
  pending,
  title,
  onStart,
  items,
  menuLabel,
  placement = 'down',
  onMouseDown
}: {
  children: ReactNode
  /** The start chord as words, shown after the label ("Ctrl ↵"). */
  chord?: string
  keyShortcuts?: string
  disabled: boolean
  pending?: boolean
  /** Why it can't start, or the action's name with its chord. */
  title: string
  onStart: () => void
  items: ActionMenuItem[]
  menuLabel: string
  placement?: 'up' | 'down'
  onMouseDown?: (e: ReactMouseEvent) => void
}) {
  const [open, setOpen] = useState(false)
  const blocked = disabled || Boolean(pending)
  const main = (
    <button
      type="button"
      disabled={blocked}
      aria-busy={pending || undefined}
      aria-keyshortcuts={keyShortcuts}
      title={blocked ? undefined : title}
      onMouseDown={onMouseDown}
      onClick={onStart}
      data-start-task
      className="inline-flex h-7 shrink-0 items-center gap-2 whitespace-nowrap rounded-l-md bg-accent pl-2.5 pr-2 text-xs font-medium text-accent-fg vy-transition hover:bg-accent-hover focus-visible:vy-focus-ring disabled:vy-disabled-state"
    >
      {children}
      {chord && !pending ? (
        // Said by aria-keyshortcuts; seen here so the chord is learnt by looking.
        <span aria-hidden="true" className="font-normal @max-[480px]:hidden">
          {chord}
        </span>
      ) : null}
    </button>
  )
  return (
    <div className="ml-1 inline-flex shrink-0 items-stretch" data-start-split>
      {blocked && !pending ? (
        <Tooltip content={title}>
          <span className="inline-flex cursor-not-allowed">{main}</span>
        </Tooltip>
      ) : (
        main
      )}
      <ActionMenu
        open={open}
        onOpenChange={setOpen}
        placement={placement}
        align="end"
        aria-label={menuLabel}
        items={items}
        trigger={(t) => (
          <button
            ref={t.ref}
            type="button"
            aria-label={menuLabel}
            aria-expanded={t['aria-expanded']}
            aria-controls={t['aria-controls']}
            aria-haspopup={t['aria-haspopup']}
            onClick={t.onClick}
            className={cn(
              'inline-flex h-7 w-6 shrink-0 items-center justify-center rounded-r-md border-l border-accent-hover text-accent-fg vy-transition focus-visible:vy-focus-ring',
              open ? 'bg-accent-hover' : 'bg-accent hover:bg-accent-hover'
            )}
          >
            <Icon name="chevron" size={12} />
          </button>
        )}
      />
    </div>
  )
}
