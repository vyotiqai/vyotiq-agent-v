/**
 * @vitest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationItem } from '@shared/ipc'
import { useLiveAnnouncer } from '@renderer/lib/a11y/useLiveAnnouncer'
import { runAnnouncement, useRunAnnouncements } from '@renderer/lib/hooks/useRunAnnouncements'

function item(over: Partial<NotificationItem>): NotificationItem {
  return {
    id: 'n1',
    kind: 'run_done',
    title: 'Fix tests',
    body: 'Ready for review · 3 files',
    createdAt: new Date(Date.now() + 1000).toISOString(),
    read: false,
    ...over
  } as NotificationItem
}

function Harness({ items }: { items: NotificationItem[] }) {
  const { LiveRegion } = useLiveAnnouncer()
  useRunAnnouncements(items)
  return <LiveRegion />
}

beforeEach(() => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    cb(0)
    return 0
  })
})
afterEach(() => vi.restoreAllMocks())

describe('run announcements', () => {
  it('speaks finished politely, and failures and needs-you assertively', () => {
    expect(runAnnouncement(item({}))).toEqual({ text: 'Fix tests: Ready for review · 3 files', assertive: false })
    expect(runAnnouncement(item({ kind: 'run_error', body: 'HTTP 500' }))).toEqual({
      text: 'Task failed: Fix tests. HTTP 500',
      assertive: true
    })
    expect(runAnnouncement(item({ kind: 'needs_you', body: 'Approve a command' }))).toEqual({
      text: 'Fix tests needs you: Approve a command',
      assertive: true
    })
    expect(runAnnouncement(item({ kind: 'update_ready' }))).toBeNull()
  })

  it('announces new items once, in the live regions, and never old or read ones', () => {
    const old = item({ id: 'old', createdAt: new Date(Date.now() - 60_000).toISOString() })
    const { rerender } = render(<Harness items={[old]} />)
    expect(screen.getByRole('status').textContent).toBe('')

    const done = item({ id: 'd1' })
    const asks = item({ id: 'q1', kind: 'needs_you', title: 'Deploy', body: 'Answer a question' })
    act(() => rerender(<Harness items={[old, done, asks]} />))
    expect(screen.getByRole('status').textContent).toBe('Fix tests: Ready for review · 3 files')
    expect(screen.getByRole('alert').textContent).toBe('Deploy needs you: Answer a question')

    // The same items again (a re-render, or marked read) say nothing new.
    act(() => rerender(<Harness items={[old, { ...done, read: true }, asks]} />))
    expect(screen.getByRole('status').textContent).toBe('Fix tests: Ready for review · 3 files')

    // Two failures in one update are one line.
    const f1 = item({ id: 'e1', kind: 'run_error', title: 'A', body: 'x' })
    const f2 = item({ id: 'e2', kind: 'run_error', title: 'B', body: 'y' })
    act(() => rerender(<Harness items={[f1, f2]} />))
    expect(screen.getByRole('alert').textContent).toBe('Task failed: A. x. Task failed: B. y')
  })
})
