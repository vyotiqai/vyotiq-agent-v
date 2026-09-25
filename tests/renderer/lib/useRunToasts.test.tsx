/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { NotificationItem } from '@shared/ipc'
import { toastRunNotification, useRunToasts } from '@renderer/lib/hooks/useRunToasts'
import { getToasts, resetToastStoreForTests } from '@renderer/lib/ui/toastStore'

const WS = 'C:\\work\\alpha'

function item(over: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'n1',
    createdAt: new Date(Date.now() + 1000).toISOString(),
    read: false,
    source: 'agent',
    kind: 'run_done',
    title: 'Fade rows under the pinned prompt',
    body: 'Ready for review · 3 files',
    dedupeKey: 'run:r1:done',
    action: { type: 'open_run', workspacePath: WS, runId: 'r1' },
    reviewFiles: 3,
    ...over
  }
}

function Harness(props: { items: NotificationItem[]; focusedRunId?: string | null; onOpenTask?: () => void; onReviewTask?: () => void }) {
  useRunToasts({
    items: props.items,
    isOnScreen: (_path, runId) => runId === props.focusedRunId,
    onOpenTask: props.onOpenTask ?? vi.fn(),
    onReviewTask: props.onReviewTask ?? vi.fn()
  })
  return null
}

beforeEach(() => {
  resetToastStoreForTests()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  resetToastStoreForTests()
})

describe('toastRunNotification', () => {
  it('says a task is ready for review, names it and its files, and offers Review', () => {
    const onReviewTask = vi.fn()
    toastRunNotification(item(), { onOpenTask: vi.fn(), onReviewTask })
    const [toast] = getToasts()
    expect(toast).toMatchObject({
      message: 'Ready for review',
      detail: 'Fade rows under the pinned prompt · 3 files',
      state: 'review',
      action: { label: 'Review' }
    })
    toast!.action!.onClick()
    expect(onReviewTask).toHaveBeenCalledWith(WS, 'r1')
  })

  it('says Finished or Failed otherwise, and opens the task', () => {
    const onOpenTask = vi.fn()
    toastRunNotification(item({ id: 'a', reviewFiles: undefined, body: 'Finished' }), { onOpenTask, onReviewTask: vi.fn() })
    toastRunNotification(item({ id: 'b', kind: 'run_error', reviewFiles: undefined, title: 'Audit', body: 'Failed: 429' }), {
      onOpenTask,
      onReviewTask: vi.fn()
    })
    expect(getToasts().map((t) => [t.message, t.detail, t.state, t.action?.label])).toEqual([
      ['Finished', 'Fade rows under the pinned prompt', 'done', 'Open'],
      ['Failed', 'Audit', 'failed', 'Open']
    ])
    getToasts()[1]!.action!.onClick()
    expect(onOpenTask).toHaveBeenCalledWith(WS, 'r1')
  })

  it('toasts nothing for an item that is not a run finishing', () => {
    expect(toastRunNotification(item({ kind: 'needs_you' }), { onOpenTask: vi.fn(), onReviewTask: vi.fn() })).toBe(-1)
    expect(getToasts()).toHaveLength(0)
  })
})

describe('useRunToasts', () => {
  it('toasts a run that finishes while you look at another task, once', () => {
    const { rerender } = render(<Harness items={[]} focusedRunId="other" />)
    const done = item()
    rerender(<Harness items={[done]} focusedRunId="other" />)
    rerender(<Harness items={[{ ...done }]} focusedRunId="other" />)
    expect(getToasts().map((t) => t.message)).toEqual(['Ready for review'])
  })

  it('toasts again when the same run finishes again', () => {
    const { rerender } = render(<Harness items={[]} />)
    rerender(<Harness items={[item()]} />)
    const first = getToasts()[0]!.id
    rerender(<Harness items={[item({ createdAt: new Date(Date.now() + 5000).toISOString() })]} />)
    // A new toast, which replaces the one with the same words rather than stacking.
    expect(getToasts()).toHaveLength(1)
    expect(getToasts()[0]!.id).not.toBe(first)
  })

  it('says nothing about the task in front of you', () => {
    const { rerender } = render(<Harness items={[]} focusedRunId="r1" />)
    rerender(<Harness items={[item()]} focusedRunId="r1" />)
    expect(getToasts()).toHaveLength(0)
  })

  it('says nothing about what was already in the inbox when the window opened', () => {
    render(<Harness items={[item({ createdAt: new Date(Date.now() - 60_000).toISOString() })]} />)
    expect(getToasts()).toHaveLength(0)
  })

  it('leaves a read item, a needs-you item and a background window to the bell and the OS', () => {
    const { rerender } = render(<Harness items={[]} />)
    rerender(<Harness items={[item({ id: 'read', read: true }), item({ id: 'ask', kind: 'needs_you' })]} />)
    expect(getToasts()).toHaveLength(0)
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    rerender(<Harness items={[item({ id: 'away' })]} />)
    expect(getToasts()).toHaveLength(0)
  })
})
