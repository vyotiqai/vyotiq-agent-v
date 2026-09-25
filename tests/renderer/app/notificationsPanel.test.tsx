/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { NotificationItem } from '@shared/ipc'
import { NotificationsButton } from '@renderer/app/navigator/NotificationsButton'

afterEach(cleanup)

const WS = 'C:\\work\\alpha'

function item(over: Partial<NotificationItem>): NotificationItem {
  return {
    id: over.id ?? 'n',
    createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    read: false,
    source: 'agent',
    kind: 'run_done',
    title: 'Regroup Settings',
    body: 'Finished',
    dedupeKey: `k-${over.id ?? 'n'}`,
    action: { type: 'open_run', workspacePath: WS, runId: 'r1' },
    ...over
  }
}

const ITEMS: NotificationItem[] = [
  item({ id: 'a', kind: 'needs_you', title: 'Add backpressure', body: 'Wants to run pnpm vitest run' }),
  item({ id: 'b', kind: 'run_done', title: 'Regroup Settings', body: 'Ready for review · 14 files', reviewFiles: 14 }),
  item({ id: 'c', kind: 'run_error', title: 'Audit the runtime', body: 'Failed: provider rate limit', read: true }),
  item({ id: 'd', kind: 'run_done', title: 'Bump electron', body: 'Finished', read: true }),
  item({
    id: 'e',
    kind: 'crash',
    source: 'system',
    title: 'UI recovered after a crash',
    body: 'render-process-gone',
    read: true,
    action: { type: 'open_settings', section: 'diagnostics' }
  })
]

function open(over: Partial<Parameters<typeof NotificationsButton>[0]> = {}) {
  const handlers = {
    onMarkRead: vi.fn(),
    onDismiss: vi.fn(),
    onOpenItem: vi.fn(),
    onOpenSettings: vi.fn()
  }
  render(<NotificationsButton items={ITEMS} unreadCount={2} {...handlers} {...over} />)
  fireEvent.click(screen.getByRole('button', { name: /^Notifications/ }))
  return { handlers, panel: screen.getByRole('dialog', { name: 'Notifications' }) }
}

describe('NotificationsButton', () => {
  it('says how many are new beside the heading', () => {
    const { panel } = open()
    expect(within(panel).getByText('2 new')).toBeTruthy()
  })

  it('marks each row with its task state, the way the navigator draws it', () => {
    const { panel } = open()
    const states = [...panel.querySelectorAll('[data-notification-kind]')].map((row) => [
      row.getAttribute('data-notification-kind'),
      row.querySelector('[data-state]')?.getAttribute('data-state') ?? 'icon'
    ])
    expect(states).toEqual([
      ['needs_you', 'needs'],
      ['run_done', 'review'],
      ['run_error', 'failed'],
      ['run_done', 'done'],
      ['crash', 'icon']
    ])
  })

  it('names the task, says what happened, and marks the unread ones', () => {
    const { panel } = open()
    const review = within(panel).getByRole('button', { name: /^Regroup Settings/ })
    expect(review.textContent).toContain('Ready for review · 14 files')
    expect(review.textContent).toContain('2m')
    expect(within(review).getByText('Unread')).toBeTruthy()
    expect(within(review).getByText('Regroup Settings').className).toContain('font-medium')
    const read = within(panel).getByRole('button', { name: /^Audit the runtime/ })
    expect(within(read).queryByText('Unread')).toBeNull()
    expect(within(read).getByText('Audit the runtime').className).not.toContain('font-medium')
  })

  it('opens an item and marks it read', () => {
    const { handlers, panel } = open()
    fireEvent.click(within(panel).getByRole('button', { name: /^Add backpressure/ }))
    expect(handlers.onMarkRead).toHaveBeenCalledWith({ id: 'a' })
    expect(handlers.onOpenItem).toHaveBeenCalledWith(ITEMS[0])
  })

  it('marks all read, clears, dismisses one, and opens its settings from the footer', () => {
    const { handlers, panel } = open()
    fireEvent.click(within(panel).getByRole('button', { name: 'Mark all read' }))
    expect(handlers.onMarkRead).toHaveBeenCalledWith({ all: true })
    fireEvent.click(within(panel).getByRole('button', { name: 'Clear' }))
    expect(handlers.onDismiss).toHaveBeenCalledWith({ all: true })
    fireEvent.click(within(panel).getByRole('button', { name: 'Dismiss Bump electron' }))
    expect(handlers.onDismiss).toHaveBeenCalledWith({ id: 'd' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Notification settings' }))
    expect(handlers.onOpenSettings).toHaveBeenCalled()
  })

  it('shows no count and nothing to mark when everything is read', () => {
    const { panel } = open({ items: ITEMS.map((i) => ({ ...i, read: true })), unreadCount: 0 })
    expect(within(panel).queryByText(/new$/)).toBeNull()
    expect((within(panel).getByRole('button', { name: 'Mark all read' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says so when the inbox is empty', () => {
    const { panel } = open({ items: [], unreadCount: 0 })
    expect(within(panel).getByText('Nothing new.')).toBeTruthy()
    expect((within(panel).getByRole('button', { name: 'Clear' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
