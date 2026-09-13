import type { NotificationPublishInput } from '../../shared/ipc'

export type NotificationBus = {
  publish: (input: NotificationPublishInput) => void
  dismissByDedupeKey: (dedupeKey: string) => void
}

let bus: NotificationBus | null = null

/** Wired by `initNotifications()`. Callers stay electron-free so unit tests stay isolated. */
export function setNotificationBus(next: NotificationBus | null): void {
  bus = next
}

export function publishLifecycleNotification(input: NotificationPublishInput): void {
  bus?.publish(input)
}

export function dismissLifecycleNotification(dedupeKey: string): void {
  bus?.dismissByDedupeKey(dedupeKey)
}
