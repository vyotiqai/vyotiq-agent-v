import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { atomicWriteJson } from '../storage/atomicWrite'
import { logger } from '../../shared/logger'
import {
  NOTIFICATION_INBOX_CAP,
  NotificationItemSchema,
  NotificationStoreFileSchema,
  type NotificationItem
} from '../../shared/ipc'

let testPath: string | null = null
let cache: NotificationItem[] | null = null

export function notificationsStorePath(): string {
  if (testPath) return testPath
  return join(app.getPath('userData'), 'notifications.json')
}

export function setNotificationsPathForTests(path: string | null): void {
  testPath = path
  cache = null
}

export function resetNotificationsStoreForTests(): void {
  testPath = null
  cache = null
}

function persist(items: NotificationItem[]): void {
  cache = items
  try {
    atomicWriteJson(notificationsStorePath(), { items }, 0o600)
  } catch (err) {
    logger.warn('Failed to persist notifications inbox', { scope: 'notifications', err })
  }
}

function capItems(items: NotificationItem[]): NotificationItem[] {
  if (items.length <= NOTIFICATION_INBOX_CAP) return items
  const next = [...items]
  while (next.length > NOTIFICATION_INBOX_CAP) {
    let dropIndex = -1
    let dropCreatedAt = ''
    for (let i = 0; i < next.length; i++) {
      const item = next[i]!
      if (!item.read) continue
      if (dropIndex < 0 || item.createdAt < dropCreatedAt) {
        dropIndex = i
        dropCreatedAt = item.createdAt
      }
    }
    if (dropIndex < 0) {
      for (let i = 0; i < next.length; i++) {
        const item = next[i]!
        if (dropIndex < 0 || item.createdAt < dropCreatedAt) {
          dropIndex = i
          dropCreatedAt = item.createdAt
        }
      }
    }
    if (dropIndex < 0) break
    next.splice(dropIndex, 1)
  }
  return next
}

function sortNewestFirst(items: NotificationItem[]): NotificationItem[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
}

export function loadNotificationItems(): NotificationItem[] {
  if (cache) return cache
  const path = notificationsStorePath()
  if (!existsSync(path)) {
    cache = []
    return cache
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    const parsed = NotificationStoreFileSchema.safeParse(raw)
    if (!parsed.success) {
      cache = []
      return cache
    }
    const items: NotificationItem[] = []
    for (const entry of parsed.data.items) {
      const item = NotificationItemSchema.safeParse(entry)
      if (item.success) items.push(item.data)
    }
    cache = sortNewestFirst(capItems(items))
    return cache
  } catch (err) {
    logger.warn('Failed to read notifications inbox', { scope: 'notifications', err })
    cache = []
    return cache
  }
}

export function listNotificationItems(): NotificationItem[] {
  return loadNotificationItems()
}

export function findNotificationById(id: string): NotificationItem | undefined {
  return loadNotificationItems().find((item) => item.id === id)
}

export function upsertNotificationItem(item: NotificationItem): NotificationItem {
  const items = loadNotificationItems()
  const existingIndex = items.findIndex((entry) => entry.dedupeKey === item.dedupeKey)
  let next: NotificationItem[]
  if (existingIndex >= 0) {
    const prev = items[existingIndex]!
    const replaced: NotificationItem = {
      ...item,
      id: prev.id
    }
    next = [...items]
    next[existingIndex] = replaced
    persist(sortNewestFirst(capItems(next)))
    return replaced
  }
  persist(sortNewestFirst(capItems([item, ...items])))
  return item
}

export function markNotificationItemsRead(selector: { id: string } | { all: true }): NotificationItem[] {
  const items = loadNotificationItems()
  const next = items.map((item) => {
    if ('all' in selector) return item.read ? item : { ...item, read: true }
    return item.id === selector.id ? { ...item, read: true } : item
  })
  persist(next)
  return next
}

export function dismissNotificationItems(selector: { id: string } | { all: true }): NotificationItem[] {
  const items = loadNotificationItems()
  const next =
    'all' in selector ? [] : items.filter((item) => item.id !== selector.id)
  persist(next)
  return next
}

export function dismissNotificationItemsByDedupeKey(dedupeKey: string): NotificationItem[] {
  const items = loadNotificationItems()
  const next = items.filter((item) => item.dedupeKey !== dedupeKey)
  if (next.length === items.length) return items
  persist(next)
  return next
}
