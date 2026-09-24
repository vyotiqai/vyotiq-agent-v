import { useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { NotificationItem, NotificationMutateRequest } from '@shared/ipc'
import { relativeTime } from '@shared/utils/timeFormat'
import { Icon } from '@renderer/lib/icons'
import { useDropdownMenu } from '@renderer/lib/hooks/useDropdownMenu'
import { Badge, Button, IconButton, MENU_SURFACE, StatusGlyph, cn } from '@renderer/lib/ui'

function unreadLabel(count: number): string {
  if (count <= 0) return 'Notifications'
  return count === 1 ? 'Notifications, 1 unread' : `Notifications, ${count} unread`
}

/**
 * The item's state as the navigator draws it: a run that wants you, one whose
 * edits wait on review, one that finished or failed. An app alert gets a
 * quiet mark — it asks nothing of you.
 */
export function NotificationGlyph({ item }: { item: Pick<NotificationItem, 'kind' | 'reviewFiles'> }): ReactNode {
  switch (item.kind) {
    case 'needs_you':
      return <StatusGlyph state="needs" size={14} />
    case 'run_done':
      return <StatusGlyph state={item.reviewFiles ? 'review' : 'done'} size={14} />
    case 'run_error':
      return <StatusGlyph state="failed" size={14} />
    case 'crash':
      return <Icon name="warning" size={14} className="shrink-0 text-muted" />
    default: {
      const exhaustive: never = item.kind
      return exhaustive
    }
  }
}

/**
 * The inbox behind the bell: tasks that want you, wait on your review,
 * finished or failed, and app alerts. A dot on the bell says something is
 * unread; the count is in its name and in the panel, not on the navigator.
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
        data-notifications-panel
        className={cn(
          'app-region-no-drag fixed flex max-h-[min(30rem,72vh)] w-[min(22.5rem,calc(100vw-1.5rem))] flex-col overflow-hidden origin-bottom',
          MENU_SURFACE
        )}
        style={{
          top: position.placement === 'up' ? undefined : position.top,
          bottom: position.placement === 'up' ? window.innerHeight - position.top : undefined,
          left: position.left
        }}
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-3 pr-2">
          <h2 className="text-sm font-semibold text-fg-strong">Notifications</h2>
          {unreadCount > 0 ? <Badge tone="accent">{unreadCount} new</Badge> : null}
          <span className="flex-1" />
          <Button size="xs" variant="ghost" disabled={unreadCount === 0} onClick={() => onMarkRead({ all: true })}>
            Mark all read
          </Button>
          <Button size="xs" variant="ghost" disabled={items.length === 0} onClick={() => onDismiss({ all: true })}>
            Clear
          </Button>
        </div>
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-tertiary">Nothing new.</p>
        ) : (
          <ul className="scroll-thin m-0 min-h-0 flex-1 list-none divide-y divide-border overflow-y-auto p-0">
            {items.map((item) => (
              <li key={item.id} className="group relative">
                <button
                  type="button"
                  data-notification-kind={item.kind}
                  className="flex w-full min-w-0 items-start gap-3 px-3 py-2.5 text-left vy-transition hover:bg-surface focus-visible:vy-focus-ring"
                  onClick={() => {
                    onMarkRead({ id: item.id })
                    onOpenItem(item)
                    close(true)
                  }}
                >
                  <span className="mt-0.5 flex shrink-0">
                    <NotificationGlyph item={item} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn('block truncate text-sm', item.read ? 'text-fg' : 'font-medium text-fg-strong')}
                    >
                      {item.title}
                    </span>
                    {item.body ? <span className="block truncate text-xs text-muted">{item.body}</span> : null}
                  </span>
                  <span className="shrink-0 font-mono text-caption text-tertiary tnum group-focus-within:invisible group-hover:invisible">
                    {relativeTime(item.createdAt)}
                  </span>
                  {item.read ? (
                    <span aria-hidden="true" className="w-1.5 shrink-0" />
                  ) : (
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent group-focus-within:invisible group-hover:invisible">
                      <span className="sr-only">Unread</span>
                    </span>
                  )}
                </button>
                <span className="absolute right-2 top-2 hidden group-focus-within:block group-hover:block">
                  <IconButton
                    icon="close"
                    label={`Dismiss ${item.title}`}
                    size="xs"
                    tone="muted"
                    onClick={() => onDismiss({ id: item.id })}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex h-9 shrink-0 items-center border-t border-border px-3">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-sm text-xs text-muted vy-transition hover:text-fg focus-visible:vy-focus-ring"
            onClick={() => {
              onOpenSettings()
              close(true)
            }}
          >
            <Icon name="gear" size={13} />
            Notification settings
          </button>
        </div>
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
