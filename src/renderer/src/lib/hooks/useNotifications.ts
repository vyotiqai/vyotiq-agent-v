import { useCallback, useEffect, useState } from 'react'
import type { NotificationItem, NotificationList, NotificationMutateRequest } from '@shared/ipc'

export function useNotifications(opts?: { focusedRunId?: string | null }): {
  items: NotificationItem[]
  unreadCount: number
  markRead: (req: NotificationMutateRequest) => Promise<void>
  dismiss: (req: NotificationMutateRequest) => Promise<void>
} {
  const [items, setItems] = useState<NotificationItem[]>([])
  const focusedRunId = opts?.focusedRunId ?? null

  const applyList = useCallback((list: NotificationList): void => {
    setItems(list.items)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.vyotiq?.listNotifications?.()
      if (cancelled || !res?.ok) return
      applyList(res.data)
    })()
    const unsub = window.vyotiq?.onNotificationsChanged?.((payload) => {
      applyList(payload)
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [applyList])

  useEffect(() => {
    if (!focusedRunId) return
    const matches = items.filter((item) => {
      if (item.read) return false
      if (item.kind !== 'run_done' && item.kind !== 'run_error') return false
      return item.action?.type === 'open_run' && item.action.runId === focusedRunId
    })
    for (const item of matches) {
      void window.vyotiq?.markNotificationsRead?.({ id: item.id })
    }
  }, [items, focusedRunId])

  const markRead = useCallback(async (req: NotificationMutateRequest): Promise<void> => {
    const res = await window.vyotiq?.markNotificationsRead?.(req)
    if (res?.ok) setItems(res.data.items)
  }, [])

  const dismiss = useCallback(async (req: NotificationMutateRequest): Promise<void> => {
    const res = await window.vyotiq?.dismissNotifications?.(req)
    if (res?.ok) setItems(res.data.items)
  }, [])

  return {
    items,
    unreadCount: items.filter((item) => !item.read).length,
    markRead,
    dismiss
  }
}
