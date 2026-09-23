import { useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { NotificationItem, NotificationMutateRequest } from '@shared/ipc'
import { relativeTime } from '@shared/utils/timeFormat'
import { useDropdownMenu } from '@renderer/lib/hooks/useDropdownMenu'
import { Button, IconButton, MENU_SURFACE, cn } from '@renderer/lib/ui'

function unreadLabel(count: number): string {
  if (count <= 0) return 'Notifications'
  return count === 1 ? 'Notifications, 1 unread' : `Notifications, ${count} unread`
}

/**
 * The inbox behind the bell: tasks that finished, failed or want you, and app
 * alerts. A dot on the bell says something is unread; the count is in its
 * name and in the panel, not on the navigator.
 */
export function NotificationsButton({
  items,
  unreadCount,
  onMarkRead,
  onDismiss,
  onOpenItem,
  onOpenSettings
}: {
  items: NotificationItem[]
  unreadCount: number
  onMarkRead: (req: NotificationMutateRequest) => void
  onDismiss: (req: NotificationMutateRequest) => void
  onOpenItem: (item: NotificationItem) => void
  onOpenSettings: () => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const { position, close } = useDropdownMenu({
    open,
    onOpenChange: setOpen,
    triggerRef,
    panelRef,
    placement: 'up',
    align: 'start',
    trapFocus: true,
    autoFocusFirst: true
  })
  const label = unreadLabel(unreadCount)

  const panel =
    open && position ? (
      <div
        ref={panelRef}
        id={panelId}
        role="dialog"
        aria-label="Notifications"
        tabIndex={-1}
        className={cn(
          'app-region-no-drag fixed flex max-h-[min(28rem,70vh)] w-[min(22rem,calc(100vw-1.5rem))] flex-col origin-bottom',
          MENU_SURFACE
        )}
        style={{
          top: position.placement === 'up' ? undefined : position.top,
          bottom: position.placement === 'up' ? window.innerHeight - position.top : undefined,
          left: position.left
        }}
      >
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border pl-3 pr-1.5">
          <h2 className="flex-1 text-sm font-semibold text-fg-strong">Notifications</h2>
          <Button size="xs" variant="ghost" disabled={unreadCount === 0} onClick={() => onMarkRead({ all: true })}>
            Mark all read
          </Button>
          <Button size="xs" variant="ghost" disabled={items.length === 0} onClick={() => onDismiss({ all: true })}>
            Clear
          </Button>
          <IconButton
            icon="gear"
            label="Notification settings"
            size="sm"
            tone="muted"
            onClick={() => {
              onOpenSettings()
              close(true)
            }}
          />
        </div>
        <ul className="scroll-thin m-0 min-h-0 flex-1 list-none overflow-y-auto p-1">
          {items.length === 0 ? (
            <li className="px-2 py-6 text-center text-xs text-tertiary">Nothing new.</li>
          ) : (
            items.map((item) => (
              <li key={item.id} className="group relative">
                <button
                  type="button"
                  className="flex w-full min-w-0 items-start gap-2 rounded-md py-1.5 pl-2 pr-8 text-left vy-transition hover:bg-surface focus-visible:vy-focus-ring"
                  onClick={() => {
                    onMarkRead({ id: item.id })
                    onOpenItem(item)
                    close(true)
                  }}
                >
                  <span
                    aria-hidden="true"
                    className={cn('mt-[7px] size-1.5 shrink-0 rounded-full', item.read ? 'bg-transparent' : 'bg-accent')}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className={cn('min-w-0 flex-1 truncate text-sm', item.read ? 'text-secondary' : 'font-medium text-fg-strong')}>
                        {item.title}
                      </span>
                      <span className="shrink-0 font-mono text-caption text-tertiary tnum">{relativeTime(item.createdAt)}</span>
                    </span>
                    {item.body ? <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{item.body}</span> : null}
                  </span>
                </button>
                <span className="absolute right-1 top-1 hidden group-hover:block group-focus-within:block">
                  <IconButton
                    icon="close"
                    label={`Dismiss ${item.title}`}
                    size="xs"
                    tone="muted"
                    onClick={() => onDismiss({ id: item.id })}
                  />
                </span>
              </li>
            ))
          )}
        </ul>
      </div>
    ) : null

  return (
    <>
      <span className="relative inline-flex">
        <IconButton
          ref={triggerRef}
          icon="bell"
          label={label}
          size="md"
          tone="muted"
          active={open}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen((prev) => !prev)}
        />
        {unreadCount > 0 ? (
          <span aria-hidden="true" className="pointer-events-none absolute right-1 top-1 size-1.5 rounded-full bg-accent" />
        ) : null}
      </span>
      {panel ? createPortal(panel, document.body) : null}
    </>
  )
}
