/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { NotificationItem } from '@shared/ipc'
import type { PendingAsk } from '@renderer/features/home/usePendingAsks'
import { NotificationsRow } from '@renderer/app/navigator/NotificationsRow'

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

/** r1 still waits on a terminal command. */
const ASKS: Record<string, PendingAsk | null> = {
  r1: {
    kind: 'approval',
    request: {
      requestId: 'req-1',
      runId: 'r1',
      toolCallId: 'call-1',
      name: 'terminal',
      summary: 'Run pnpm vitest run',
      argsPreview: JSON.stringify({ command: 'pnpm   vitest run' }),
      mutating: true
    }
  }
}

function open(over: Partial<Parameters<typeof NotificationsRow>[0]> = {}) {
  const handlers = {
    onMarkRead: vi.fn(),
    onDismiss: vi.fn(),
    onOpenItem: vi.fn(),
    onOpenSettings: vi.fn()
  }
  render(<NotificationsRow items={ITEMS} unreadCount={2} {...handlers} {...over} />)
  fireEvent.click(screen.getByRole('button', { name: /^Inbox/ }))
  return { handlers, panel: screen.getByRole('dialog', { name: 'Inbox' }) }
}

describe('NotificationsRow', () => {
  it('says how many are new beside the heading', () => {
    const { panel } = open()
    expect(within(panel).getByText('2 new')).toBeTruthy()
  })

  it('says a group’s state once on its heading, and marks only Earlier’s rows, where kinds mix', () => {
    const { panel } = open({ asks: ASKS })
    const headings = [...panel.querySelectorAll('[data-inbox-group] h3')].map(
      (h) => h.querySelector('[data-state]')?.getAttribute('data-state') ?? null
    )
    expect(headings).toEqual(['needs', 'review', null])
    const states = [...panel.querySelectorAll('[data-notification-kind]')].map((row) => [
      row.getAttribute('data-notification-kind'),
      row.querySelector('[data-state]')?.getAttribute('data-state') ?? (row.querySelector('svg') ? 'icon' : null)
    ])
    expect(states).toEqual([
      ['needs_you', null],
      ['run_done', null],
      ['run_error', 'failed'],
      ['run_done', 'done'],
      ['crash', 'icon']
    ])
  })

  it('takes a question to its task with Answer, and says what it asks', () => {
    const question: Record<string, PendingAsk | null> = {
      r1: {
        kind: 'question',
        request: {
          requestId: 'q-1',
          runId: 'r1',
          toolCallId: 'call-q',
          questions: [{ id: 'q1', prompt: 'Which database?', type: 'single', options: ['Postgres', 'SQLite'] }]
        }
      } as PendingAsk
    }
    const { handlers, panel } = open({ asks: question })
    const row = within(panel).getByRole('button', { name: /^Add backpressure/ })
    expect(row.querySelector('[data-inbox-question]')?.textContent).toBeTruthy()
    fireEvent.click(within(panel).getByRole('button', { name: 'Answer Add backpressure' }))
    expect(handlers.onOpenItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))
  })

  it('names the task, says what happened, and marks the unread ones', () => {
    const { panel } = open()
    const review = within(panel).getByRole('button', { name: /^Regroup Settings/ })
    expect(review.textContent).toContain('Ready for review · 14 files')
    expect(review.textContent).toContain('2m')
    expect(within(review).getByText('Unread')).toBeTruthy()
    // Unread is ink, never weight.
    expect(within(review).getByText('Regroup Settings').className).toContain('text-fg-strong')
    expect(within(review).getByText('Regroup Settings').className).not.toContain('font-medium')
    const read = within(panel).getByRole('button', { name: /^Audit the runtime/ })
    expect(within(read).queryByText('Unread')).toBeNull()
    expect(within(read).getByText('Audit the runtime').className).not.toContain('font-medium')
  })

  it('groups open asks, then work ready for review, then everything else', () => {
    const { panel } = open({ asks: ASKS })
    const groups = [...panel.querySelectorAll<HTMLElement>('[data-inbox-group]')].map((group) => ({
      heading: within(group).getByRole('heading').textContent,
      kinds: [...group.querySelectorAll('[data-notification-kind]')].map((row) => row.getAttribute('data-notification-kind'))
    }))
    expect(groups).toEqual([
      { heading: 'Needs you', kinds: ['needs_you'] },
      { heading: 'Ready for review', kinds: ['run_done'] },
      { heading: 'Earlier', kinds: ['run_error', 'run_done', 'crash'] }
    ])
  })

  it('files an ask already answered under Earlier, with no decision', () => {
    const { panel } = open({ asks: {}, onRespondApproval: vi.fn() })
    expect(panel.querySelector('[data-inbox-group="asks"]')).toBeNull()
    const earlier = panel.querySelector('[data-inbox-group="earlier"]') as HTMLElement
    expect(within(earlier).getByRole('button', { name: /^Add backpressure/ })).toBeTruthy()
    expect(within(panel).queryByRole('group', { name: 'Answer Add backpressure' })).toBeNull()
  })

  it('shows a waiting command and allows it in place', async () => {
    const onRespondApproval = vi.fn().mockResolvedValue(undefined)
    const { handlers, panel } = open({ asks: ASKS, onRespondApproval })
    const row = within(panel).getByRole('button', { name: /^Add backpressure/ })
    expect(row.querySelector('[data-inbox-command]')?.textContent).toBe('$pnpm vitest run')
    const decision = within(panel).getByRole('group', { name: 'Answer Add backpressure' })
    fireEvent.click(within(decision).getByRole('button', { name: 'Allow once' }))
    expect(onRespondApproval).toHaveBeenCalledWith(WS, 'r1', 'req-1', 'once')
    await waitFor(() => expect(handlers.onMarkRead).toHaveBeenCalledWith({ id: 'a' }))
    expect(handlers.onOpenItem).not.toHaveBeenCalled()
  })

  it('retries a failed task in place, while it still stands failed', () => {
    const onRetry = vi.fn()
    const canRetry = vi.fn().mockReturnValue(true)
    const { handlers, panel } = open({ onRetry, canRetry })
    // Only the failed item offers it.
    expect(within(panel).getAllByRole('button', { name: /^Retry/ })).toHaveLength(1)
    fireEvent.click(within(panel).getByRole('button', { name: 'Retry Audit the runtime' }))
    expect(canRetry).toHaveBeenCalledWith(WS, 'r1')
    expect(onRetry).toHaveBeenCalledWith(WS, 'r1')
    expect(handlers.onMarkRead).toHaveBeenCalledWith({ id: 'c' })
    expect(handlers.onOpenItem).not.toHaveBeenCalled()
    // Retrying opens the task, so the panel steps aside.
    expect(screen.queryByRole('dialog', { name: 'Inbox' })).toBeNull()
  })

  it('offers no Retry once the task is going again, or without a way to retry', () => {
    const first = open({ onRetry: vi.fn(), canRetry: () => false })
    expect(within(first.panel).queryByRole('button', { name: /^Retry/ })).toBeNull()
    cleanup()
    const second = open()
    expect(within(second.panel).queryByRole('button', { name: /^Retry/ })).toBeNull()
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

describe('NotificationsRow, made of the tasks waiting on you', () => {
  const WAITING = [{ workspacePath: WS, runId: 'r1', title: 'Add backpressure', since: new Date(Date.now() - 60_000).toISOString() }]

  it('lists a waiting task with no notice at all, says it in the count, and has nothing to dismiss', () => {
    const onOpenTask = vi.fn()
    const { handlers, panel } = open({ items: [], unreadCount: 0, waiting: WAITING, asks: ASKS, onOpenTask, onRespondApproval: vi.fn() })
    expect(screen.getByRole('button', { name: 'Inbox, 1 unread' })).toBeTruthy()
    expect(within(panel).getByText('1 new')).toBeTruthy()
    const asks = panel.querySelector('[data-inbox-group="asks"]') as HTMLElement
    const row = within(asks).getByRole('button', { name: /^Add backpressure/ })
    expect(row.querySelector('[data-inbox-command]')?.textContent).toBe('$pnpm vitest run')
    expect(within(asks).queryByRole('button', { name: /^Dismiss/ })).toBeNull()
    // Nothing to clear: the waiting task is not a notice.
    expect((within(panel).getByRole('button', { name: 'Clear' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(row)
    expect(onOpenTask).toHaveBeenCalledWith(WS, 'r1')
    expect(handlers.onOpenItem).not.toHaveBeenCalled()
  })

  it('draws a waiting task’s notice as its one row, counts it once, and reads it when answered', async () => {
    const onRespondApproval = vi.fn().mockResolvedValue(undefined)
    const { handlers, panel } = open({ waiting: WAITING, asks: ASKS, onRespondApproval })
    // Two unread notices (a, b); a is r1's, which waits: still two, not three.
    expect(within(panel).getByText('2 new')).toBeTruthy()
    const kinds = [...panel.querySelectorAll<HTMLElement>('[data-inbox-group]')].map((group) => ({
      key: group.getAttribute('data-inbox-group'),
      rows: group.querySelectorAll('[data-notification-kind]').length
    }))
    expect(kinds).toEqual([
      { key: 'asks', rows: 1 },
      { key: 'review', rows: 1 },
      { key: 'earlier', rows: 3 }
    ])
    const decision = within(panel).getByRole('group', { name: 'Answer Add backpressure' })
    fireEvent.click(within(decision).getByRole('button', { name: 'Allow once' }))
    expect(onRespondApproval).toHaveBeenCalledWith(WS, 'r1', 'req-1', 'once')
    await waitFor(() => expect(handlers.onMarkRead).toHaveBeenCalledWith({ id: 'a' }))
  })

  it('keeps a waiting task in sight and in the dot after Mark all read and Clear', () => {
    const { handlers, panel } = open({ items: ITEMS.map((i) => ({ ...i, read: true })), unreadCount: 0, waiting: WAITING, asks: ASKS })
    expect(screen.getByRole('button', { name: 'Inbox, 1 unread' }).parentElement?.querySelector('[data-unread-dot]')).not.toBeNull()
    expect((within(panel).getByRole('button', { name: 'Mark all read' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(panel).getByRole('button', { name: 'Clear' }))
    expect(handlers.onDismiss).toHaveBeenCalledWith({ all: true })
    expect(panel.querySelector('[data-inbox-group="asks"]')).not.toBeNull()
  })

  it('files a notice for a task no longer waiting under Earlier', () => {
    const { panel } = open({ waiting: [], asks: {} })
    expect(panel.querySelector('[data-inbox-group="asks"]')).toBeNull()
    const earlier = panel.querySelector('[data-inbox-group="earlier"]') as HTMLElement
    expect(within(earlier).getByRole('button', { name: /^Add backpressure/ })).toBeTruthy()
  })
})
