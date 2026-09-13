import { useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { NotificationItem, NotificationMutateRequest } from '@shared/ipc'
import { Icon } from '@renderer/lib/icons'
import { useDropdownMenu } from '@renderer/lib/hooks/useDropdownMenu'
import { SIDEBAR_ROW_HOVER } from '@renderer/lib/utils/layout'
import { Button, IconButton, NavItem, cn } from '@renderer/lib/ui'

function unreadLabel(count: number): string {
  if (count <= 0) return 'Notifications'
  return count === 1 ? 'Notifications, 1 unread' : `Notifications, ${count} unread`
}

function UnreadBadge({ count, compact }: { count: number; compact?: boolean }): ReactNode {
  if (count <= 0) return null
  const text = count > 9 ? '9+' : String(count)
  return (
    <span
      className={cn(
        'inline-flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-2xs font-medium leading-4 text-accent-fg',
        compact ? 'absolute right-0.5 top-0.5 min-w-3.5 px-0.5 text-3xs leading-3' : ''
      )}
    >
      {text}
    </span>
  )
}

export function NotificationsInbox({
  items,
  unreadCount,
  collapsed,
  onMarkRead,
  onDismiss,
  onOpenItem,
  onOpenSettings
}: {
  items: NotificationItem[]
  unreadCount: number
  collapsed: boolean
  onMarkRead: (req: NotificationMutateRequest) => void
  onDismiss: (req: NotificationMutateRequest) => void
  onOpenItem: (item: NotificationItem) => void
  onOpenSettings: () => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
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
        id={menuId}
        role="dialog"
        aria-label="Notifications"
        tabIndex={-1}
        className="app-region-no-drag fixed z-dropdown flex max-h-[min(28rem,70vh)] w-[min(20rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-md border border-border bg-card shadow-menu animate-menu-in origin-bottom"
        style={{
          top: position.placement === 'up' ? undefined : position.top,
          bottom:
            position.placement === 'up' ? window.innerHeight - position.top : undefined,
          left: collapsed ? position.left : position.left,
          minWidth: 240
        }}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-2.5 py-2">
          <p className="m-0 text-sm font-medium text-fg">Notifications</p>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              className="min-h-7 px-2 text-xs"
              disabled={unreadCount === 0}
              onClick={() => {
                onMarkRead({ all: true })
              }}
            >
              Mark all read
            </Button>
            <Button
              variant="ghost"
              className="min-h-7 px-2 text-xs"
              disabled={items.length === 0}
              onClick={() => {
                onDismiss({ all: true })
              }}
            >
              Clear
            </Button>
          </div>
        </div>
        <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-1">
          {items.length === 0 ? (
            <li className="px-2.5 py-6 text-center text-xs text-secondary">No notifications</li>
          ) : (
            items.map((item) => (
              <li key={item.id} className="flex items-stretch gap-0.5">
                <button
                  type="button"
                  className={cn(
                    'flex min-w-0 flex-1 flex-col rounded-md px-2.5 py-1.5 text-left vy-transition',
                    SIDEBAR_ROW_HOVER,
                    item.read ? 'text-secondary' : 'text-fg'
                  )}
                  onClick={() => {
                    onMarkRead({ id: item.id })
                    onOpenItem(item)
                    close(true)
                  }}
                >
                  <span className={cn('truncate text-sm', item.read ? 'font-normal' : 'font-medium')}>
                    {item.title}
                  </span>
                  {item.body ? (
                    <span className="mt-0.5 line-clamp-2 text-xs text-muted">{item.body}</span>
                  ) : null}
                </button>
                <IconButton
                  icon="close"
                  label={`Dismiss ${item.title}`}
                  variant="bare"
                  size="sm"
                  className="mt-1 shrink-0"
                  onClick={() => {
                    onDismiss({ id: item.id })
                  }}
                />
              </li>
            ))
          )}
        </ul>
        <div className="border-t border-border/60 p-1">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-secondary hover:bg-surface hover:text-fg"
            onClick={() => {
              onOpenSettings()
              close(true)
            }}
          >
            <Icon name="gear" size={14} />
            Notification settings
          </button>
        </div>
      </div>
    ) : null

  return (
    <>
      <NavItem
        buttonRef={triggerRef}
        label="Notifications"
        icon="bell"
        variant={collapsed ? 'icon' : 'sidebar'}
        className={collapsed ? undefined : 'w-full'}
        title={label}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? menuId : undefined}
        trailing={<UnreadBadge count={unreadCount} compact={collapsed} />}
        onClick={() => setOpen((prev) => !prev)}
      />
      {panel ? createPortal(panel, document.body) : null}
    </>
  )
}
