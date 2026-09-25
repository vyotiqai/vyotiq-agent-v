import { useEffect, useRef } from 'react'
import type { NotificationItem } from '@shared/ipc'
import { pushToast } from '@renderer/lib/ui/toastStore'

type RunToastHandlers = {
  onOpenTask: (workspacePath: string, runId: string) => void
  /** The task, with Changes on what it changed. */
  onReviewTask: (workspacePath: string, runId: string) => void
}

/** The toast for a run's finished or failed notification — its state, then the task. */
export function toastRunNotification(item: NotificationItem, handlers: RunToastHandlers): number {
  if (item.action?.type !== 'open_run') return -1
  const { workspacePath, runId } = item.action
  const open = { label: 'Open', onClick: () => handlers.onOpenTask(workspacePath, runId) }
  if (item.kind === 'run_error') {
    return pushToast('Failed', { state: 'failed', detail: item.title, action: open })
  }
  if (item.kind !== 'run_done') return -1
  const files = item.reviewFiles ?? 0
  if (files > 0) {
    return pushToast('Ready for review', {
      state: 'review',
      detail: `${item.title} · ${files} ${files === 1 ? 'file' : 'files'}`,
      action: { label: 'Review', onClick: () => handlers.onReviewTask(workspacePath, runId) }
    })
  }
  return pushToast('Finished', { state: 'done', detail: item.title, action: open })
}

/**
 * A task that finishes or fails while you are looking at something else says
 * so as a toast — the same notification the bell holds, read from the item
 * main published when the run stopped. Nothing toasts for the task in front
 * of you, for anything already in the inbox when the window opened, or while
 * the window is in the background: then the OS notification speaks for it.
 */
export function useRunToasts({
  items,
  isOnScreen,
  ...handlers
}: RunToastHandlers & {
  items: readonly NotificationItem[]
  /** True while the task shows in a pane you are looking at. */
  isOnScreen: (workspacePath: string, runId: string) => boolean
}): void {
  const mountedAt = useRef(Date.now())
  // An item is replaced in place when its run finishes again: same id, new time.
  const seen = useRef(new Set<string>())
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const isOnScreenRef = useRef(isOnScreen)
  isOnScreenRef.current = isOnScreen

  useEffect(() => {
    for (const item of items) {
      const key = `${item.id}@${item.createdAt}`
      if (seen.current.has(key)) continue
      seen.current.add(key)
      if (item.read || (item.kind !== 'run_done' && item.kind !== 'run_error')) continue
      if (Date.parse(item.createdAt) < mountedAt.current) continue
      if (item.action?.type !== 'open_run') continue
      if (isOnScreenRef.current(item.action.workspacePath, item.action.runId)) continue
      if (typeof document !== 'undefined' && !document.hasFocus()) continue
      toastRunNotification(item, {
        onOpenTask: (path, runId) => handlersRef.current.onOpenTask(path, runId),
        onReviewTask: (path, runId) => handlersRef.current.onReviewTask(path, runId)
      })
    }
  }, [items])
}
