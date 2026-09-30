import { useEffect, useRef } from 'react'
import type { NotificationItem } from '@shared/ipc'
import { announceLive } from '@renderer/lib/a11y/useLiveAnnouncer'

/** One spoken line for an inbox item, and how urgently; null for kinds not spoken. */
export function runAnnouncement(item: NotificationItem): { text: string; assertive: boolean } | null {
  const body = item.body?.trim()
  switch (item.kind) {
    case 'run_done':
      return { text: body ? `${item.title}: ${body}` : `${item.title}: finished`, assertive: false }
    case 'run_error':
      return { text: `Task failed: ${item.title}${body ? `. ${body}` : ''}`, assertive: true }
    case 'needs_you':
      return { text: `${item.title} needs you${body ? `: ${body}` : ''}`, assertive: true }
    default:
      return null
  }
}

/**
 * Screen readers hear a task finish, fail, or ask for you — read from the
 * same inbox items the bell and the OS notification use, so the Notifications
 * settings decide what is spoken. Unlike the toasts, this speaks for the task
 * in front of you and while the window is in the background: a screen-reader
 * user can't glance at the record to see it stopped. Items that arrive
 * together are spoken as one line, so one doesn't cut the other off.
 */
export function useRunAnnouncements(items: readonly NotificationItem[]): void {
  const mountedAt = useRef(Date.now())
  // An item is replaced in place when its run stops again: same id, new time.
  const seen = useRef(new Set<string>())

  useEffect(() => {
    const polite: string[] = []
    const assertive: string[] = []
    for (const item of items) {
      const key = `${item.id}@${item.createdAt}`
      if (seen.current.has(key)) continue
      seen.current.add(key)
      if (item.read) continue
      if (Date.parse(item.createdAt) < mountedAt.current) continue
      const line = runAnnouncement(item)
      if (!line) continue
      ;(line.assertive ? assertive : polite).push(line.text)
    }
    if (assertive.length) announceLive(assertive.join('. '), 'assertive')
    if (polite.length) announceLive(polite.join('. '), 'polite')
  }, [items])
}
