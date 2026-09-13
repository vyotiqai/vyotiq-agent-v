/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { NotificationsInbox } from '@renderer/app/sidebar/NotificationsInbox'
import type { NotificationItem } from '@shared/ipc'

const sample: NotificationItem = {
  id: 'n1',
  createdAt: '2026-08-16T12:00:00.000Z',
  read: false,
  source: 'agent',
  kind: 'run_done',
  title: 'Finished: Fix tests',
  body: 'Agent run finished',
  dedupeKey: 'run:run-1:done',
  action: { type: 'open_run', workspacePath: '/ws', runId: 'run-1' }
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  // @ts-expect-error test bridge
  window.vyotiq = { platform: 'win32' }
})

async function openInbox(name: RegExp | string = /^notifications$/i): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name }))
  await waitFor(() => {
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeTruthy()
  })
}

describe('NotificationsInbox', () => {
  it('shows an unread badge and empty state', async () => {
    const { rerender } = render(
      <NotificationsInbox
        items={[]}
        unreadCount={0}
        collapsed={false}
        onMarkRead={vi.fn()}
        onDismiss={vi.fn()}
        onOpenItem={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    )
    await openInbox()
    expect(screen.getByText('No notifications')).toBeTruthy()

    rerender(
      <NotificationsInbox
        items={[sample]}
        unreadCount={1}
        collapsed={false}
        onMarkRead={vi.fn()}
        onDismiss={vi.fn()}
        onOpenItem={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: /notifications, 1 unread/i })).toBeTruthy()
  })

  it('marks read and activates on item click, dismisses one, and mark-all/clear', async () => {
    const onMarkRead = vi.fn()
    const onDismiss = vi.fn()
    const onOpenItem = vi.fn()
    render(
      <NotificationsInbox
        items={[sample]}
        unreadCount={1}
        collapsed={false}
        onMarkRead={onMarkRead}
        onDismiss={onDismiss}
        onOpenItem={onOpenItem}
        onOpenSettings={vi.fn()}
      />
    )
    await openInbox(/notifications, 1 unread/i)
    const dialog = screen.getByRole('dialog', { name: 'Notifications' })
    fireEvent.click(within(dialog).getByText('Finished: Fix tests'))
    expect(onMarkRead).toHaveBeenCalledWith({ id: 'n1' })
    expect(onOpenItem).toHaveBeenCalledWith(sample)

    await openInbox(/notifications/i)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Finished: Fix tests' }))
    expect(onDismiss).toHaveBeenCalledWith({ id: 'n1' })

    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }))
    expect(onMarkRead).toHaveBeenCalledWith({ all: true })
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onDismiss).toHaveBeenCalledWith({ all: true })
  })

  it('opens settings from the panel footer', async () => {
    const onOpenSettings = vi.fn()
    render(
      <NotificationsInbox
        items={[]}
        unreadCount={0}
        collapsed={false}
        onMarkRead={vi.fn()}
        onDismiss={vi.fn()}
        onOpenItem={vi.fn()}
        onOpenSettings={onOpenSettings}
      />
    )
    await openInbox()
    fireEvent.click(screen.getByRole('button', { name: 'Notification settings' }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })
})
