import { app, Notification } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { IPC } from '../../shared/channels'
import { logger } from '../../shared/logger'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_TITLE_MAX,
  NotificationItemSchema,
  NotificationPublishInputSchema,
  type DesktopNotificationMode,
  type NotificationItem,
  type NotificationKind,
  type NotificationList,
  type NotificationMutateRequest,
  type NotificationPublishInput,
  type NotificationSettings
} from '../../shared/ipc'
import { getSettings } from '../settings/settings'
import { getMainWindow } from '../app/window'
import { setNotificationBus } from './bus'
import {
  dismissNotificationItems,
  dismissNotificationItemsByDedupeKey,
  findNotificationById,
  listNotificationItems,
  loadNotificationItems,
  markNotificationItemsRead,
  upsertNotificationItem
} from './store'

const liveNotifications = new Map<string, Notification>()
const activatingIds = new Set<string>()
let loggedOsFailed = false
let handleActivationInstalled = false

function clipText(text: string, max: number): string {
  const clipped = text.replace(/\s+/g, ' ').trim()
  if (clipped.length <= max) return clipped
  return `${clipped.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function notificationSettings(): NotificationSettings {
  return getSettings().notifications ?? DEFAULT_NOTIFICATION_SETTINGS
}

function categoryEnabled(settings: NotificationSettings, kind: NotificationKind): boolean {
  switch (kind) {
    case 'run_done':
      return settings.agentRunFinished
    case 'run_error':
      return settings.agentRunFailed
    case 'needs_you':
      return settings.agentNeedsYou
    case 'crash':
      return settings.system
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

function mainWindowUnfocused(): boolean {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return true
  try {
    if (typeof win.isMinimized === 'function' && win.isMinimized()) return true
    if (typeof win.isFocused === 'function') return !win.isFocused()
  } catch {
    return true
  }
  return true
}

function shouldShowDesktop(
  desktop: DesktopNotificationMode,
  windowUnfocused: boolean
): boolean {
  switch (desktop) {
    case 'off':
      return false
    case 'always':
      return true
    case 'unfocused':
      return windowUnfocused
    default: {
      const _exhaustive: never = desktop
      return _exhaustive
    }
  }
}

function notificationIconPath(): string | undefined {
  try {
    const candidates = [
      join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'icon.png'),
      join(app.getAppPath(), 'resources', 'icon.png'),
      join(process.resourcesPath, 'app.asar', 'resources', 'icon.png')
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
  } catch {
    /* ignore */
  }
  return undefined
}

function sendToRenderer(channel: string, payload: unknown): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(channel, payload)
}

function snapshot(): NotificationList {
  return { items: listNotificationItems() }
}

function pushChanged(): void {
  sendToRenderer(IPC.notificationsChanged, snapshot())
}

function closeLive(id: string): void {
  const live = liveNotifications.get(id)
  if (!live) return
  liveNotifications.delete(id)
  try {
    live.close()
  } catch {
    /* ignore */
  }
}

function focusMainWindow(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  if (typeof win.isMinimized === 'function' && win.isMinimized()) win.restore()
  if (typeof win.show === 'function') win.show()
  win.focus()
}

function parseActivationId(raw: string): string | undefined {
  const value = raw.trim()
  if (!value) return undefined
  if (findNotificationById(value)) return value
  const match = listNotificationItems().find((item) => value.includes(item.id))
  return match?.id
}

function handleOsActivation(id: string): void {
  if (activatingIds.has(id)) return
  activatingIds.add(id)
  setTimeout(() => {
    activatingIds.delete(id)
  }, 400)
  focusMainWindow()
  const before = findNotificationById(id)
  markNotificationItemsRead({ id })
  closeLive(id)
  pushChanged()
  const action = before?.action
  if (action) sendToRenderer(IPC.notificationsActivate, action)
}

function showOsNotification(item: NotificationItem): void {
  let supported = false
  try {
    supported = typeof Notification.isSupported === 'function' && Notification.isSupported()
  } catch {
    supported = false
  }
  if (!supported) return

  closeLive(item.id)
  const icon = notificationIconPath()
  const toast = new Notification({
    title: item.title,
    body: item.body,
    silent: true,
    id: item.id,
    groupId: item.source,
    ...(icon ? { icon } : {})
  })
  toast.on('click', () => {
    handleOsActivation(item.id)
  })
  toast.on('failed', () => {
    if (loggedOsFailed) return
    loggedOsFailed = true
    logger.warn('OS notification failed; inbox still works', { scope: 'notifications' })
  })
  liveNotifications.set(item.id, toast)
  try {
    toast.show()
  } catch (err) {
    liveNotifications.delete(item.id)
    logger.warn('Failed to show OS notification', { scope: 'notifications', err })
  }
}

function installHandleActivation(): void {
  if (handleActivationInstalled) return
  if (typeof Notification.handleActivation !== 'function') return
  handleActivationInstalled = true
  Notification.handleActivation((details) => {
    const id = parseActivationId(details.arguments)
    if (id) {
      handleOsActivation(id)
      return
    }
    focusMainWindow()
  })
}

export function publishNotification(input: NotificationPublishInput): NotificationItem | null {
  const settings = notificationSettings()
  if (!settings.enabled) return null
  if (!categoryEnabled(settings, input.kind)) return null

  const parsed = NotificationPublishInputSchema.safeParse(input)
  if (!parsed.success) {
    logger.warn('Dropped invalid notification publish payload', { scope: 'notifications' })
    return null
  }

  const title = clipText(parsed.data.title, NOTIFICATION_TITLE_MAX) || 'Vyotiq'
  const body = clipText(parsed.data.body, NOTIFICATION_BODY_MAX)
  const item = NotificationItemSchema.parse({
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    read: false,
    source: parsed.data.source,
    kind: parsed.data.kind,
    title,
    body,
    dedupeKey: parsed.data.dedupeKey,
    ...(parsed.data.action ? { action: parsed.data.action } : {})
  })

  const stored = upsertNotificationItem(item)
  pushChanged()

  const desktopOk =
    settings.desktop !== 'off' &&
    shouldShowDesktop(settings.desktop, mainWindowUnfocused())
  if (desktopOk) showOsNotification(stored)
  return stored
}

export function listNotifications(): NotificationList {
  return snapshot()
}

export function markNotificationsRead(req: NotificationMutateRequest): NotificationList {
  const next = markNotificationItemsRead(req)
  if ('id' in req) closeLive(req.id)
  else {
    for (const id of [...liveNotifications.keys()]) closeLive(id)
  }
  const result = { items: next }
  sendToRenderer(IPC.notificationsChanged, result)
  return result
}

export function dismissNotifications(req: NotificationMutateRequest): NotificationList {
  if ('id' in req) closeLive(req.id)
  else {
    for (const id of [...liveNotifications.keys()]) closeLive(id)
  }
  const next = dismissNotificationItems(req)
  const result = { items: next }
  sendToRenderer(IPC.notificationsChanged, result)
  return result
}

export function dismissNotificationsByDedupeKey(dedupeKey: string): NotificationList {
  const existing = listNotificationItems().filter((item) => item.dedupeKey === dedupeKey)
  for (const item of existing) closeLive(item.id)
  const next = dismissNotificationItemsByDedupeKey(dedupeKey)
  const result = { items: next }
  if (existing.length > 0) sendToRenderer(IPC.notificationsChanged, result)
  return result
}

export function initNotifications(): void {
  loadNotificationItems()
  installHandleActivation()
  setNotificationBus({
    publish: (input) => {
      publishNotification(input)
    },
    dismissByDedupeKey: (dedupeKey) => {
      dismissNotificationsByDedupeKey(dedupeKey)
    }
  })
}

export function resetNotificationsForTests(): void {
  for (const id of [...liveNotifications.keys()]) closeLive(id)
  liveNotifications.clear()
  activatingIds.clear()
  loggedOsFailed = false
  handleActivationInstalled = false
  setNotificationBus(null)
}
