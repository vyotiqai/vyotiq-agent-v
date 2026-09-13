/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { useNotifications } from '@renderer/lib/hooks/useNotifications'
import type { NotificationItem } from '@shared/ipc'

const unreadDone: NotificationItem = {
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

describe('useNotifications', () => {
  beforeEach(() => {
    // @ts-expect-error test bridge
    window.vyotiq = {
      listNotifications: vi.fn(async () => ({
        ok: true as const,
        data: { items: [unreadDone] }
      })),
      markNotificationsRead: vi.fn(async () => ({
        ok: true as const,
        data: { items: [{ ...unreadDone, read: true }] }
      })),
      dismissNotifications: vi.fn(async () => ({
        ok: true as const,
        data: { items: [] }
      })),
      onNotificationsChanged: vi.fn(() => () => undefined)
    }
  })

  it('marks unread run_done for the focused run as read', async () => {
    renderHook(() => useNotifications({ focusedRunId: 'run-1' }))
    await waitFor(() => {
      expect(window.vyotiq.markNotificationsRead).toHaveBeenCalledWith({ id: 'n1' })
    })
  })

  it('does not auto-mark when a different run is focused', async () => {
    const { result } = renderHook(() => useNotifications({ focusedRunId: 'other' }))
    await waitFor(() => {
      expect(result.current.items).toHaveLength(1)
    })
    expect(window.vyotiq.markNotificationsRead).not.toHaveBeenCalled()
  })
})
