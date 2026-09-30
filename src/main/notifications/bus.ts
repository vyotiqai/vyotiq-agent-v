import type { NotificationPublishInput } from '../../shared/ipc'

export type NotificationBus = {
  publish: (input: NotificationPublishInput) => void
  dismissByDedupeKey: (dedupeKey: string) => void
}

let bus: NotificationBus | null = null

/**
 * Notices raised before `initNotifications()` wires the bus — settings load
 * first, and a damaged settings.json has to reach the inbox too. Bounded: a
 * process that never wires a bus (unit tests) keeps only the latest few.
 */
const EARLY_NOTICE_CAP = 20
let early: NotificationPublishInput[] = []

/** Wired by `initNotifications()`. Callers stay electron-free so unit tests stay isolated. */
export function setNotificationBus(next: NotificationBus | null): void {
  bus = next
  if (!next || early.length === 0) return
  const pending = early
  early = []
  for (const input of pending) next.publish(input)
}

export function publishLifecycleNotification(input: NotificationPublishInput): void {
  if (bus) {
    bus.publish(input)
    return
  }
  early = [...early.slice(-(EARLY_NOTICE_CAP - 1)), input]
}

export function dismissLifecycleNotification(dedupeKey: string): void {
  early = early.filter((input) => input.dedupeKey !== dedupeKey)
  bus?.dismissByDedupeKey(dedupeKey)
}
