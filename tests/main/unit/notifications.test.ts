import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_SETTINGS, type Settings } from '@shared/ipc'

const { shown, send, windowState, settingsState, MockNotification } = vi.hoisted(() => {
  const shown: Array<{ title: string; body: string; id: string }> = []
  class MockNotification {
    static isSupported = vi.fn(() => true)
    static handleActivation = vi.fn((cb: (details: { arguments: string }) => void) => {
      MockNotification.activationCb = cb
    })
    static activationCb: ((details: { arguments: string }) => void) | null = null
    static instances: MockNotification[] = []
    title: string
    body: string
    id: string
    private handlers = new Map<string, () => void>()
    constructor(opts: { title?: string; body?: string; id?: string }) {
      this.title = opts.title ?? ''
      this.body = opts.body ?? ''
      this.id = opts.id ?? ''
      MockNotification.instances.push(this)
    }
    show(): void {
      shown.push({ title: this.title, body: this.body, id: this.id })
    }
    close(): void {}
    on(event: string, cb: () => void): void {
      this.handlers.set(event, cb)
    }
    emit(event: string): void {
      this.handlers.get(event)?.()
    }
  }
  return {
    shown,
    send: vi.fn(),
    windowState: {
      focused: false,
      minimized: false
    },
    settingsState: {
      current: null as Settings | null
    },
    MockNotification
  }
})

vi.mock('electron', () => ({
  Notification: MockNotification,
  app: {
    getPath: () => join(tmpdir(), 'vyotiq-notifications-unused'),
    getAppPath: () => join(tmpdir(), 'vyotiq-notifications-unused')
  }
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: () => settingsState.current ?? { ...DEFAULT_SETTINGS }
}))

vi.mock('@main/app/window', () => ({
  getMainWindow: () => ({
    isDestroyed: () => false,
    isMinimized: () => windowState.minimized,
    isFocused: () => windowState.focused,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: {
      isDestroyed: () => false,
      send
    }
  }),
  applyTitleBarTheme: () => undefined,
  createWindow: () => {
    throw new Error('createWindow is not available in unit tests')
  }
}))

import {
  dismissNotifications,
  dismissNotificationsByDedupeKey,
  initNotifications,
  listNotifications,
  markNotificationsRead,
  publishNotification,
  resetNotificationsForTests
} from '@main/notifications/service'
import {
  resetNotificationsStoreForTests,
  setNotificationsPathForTests
} from '@main/notifications/store'
import { IPC } from '@shared/channels'
import {
  needsYouDedupeKey,
  runDoneDedupeKey,
  type NotificationPublishInput
} from '@shared/ipc'
import { setNotificationBus } from '@main/notifications/bus'
import {
  cancelPendingApprovals,
  createApprovalGate,
  registerApprovalSender,
  resetToolApprovalForTests,
  resolveToolApproval
} from '@main/agent/toolApproval'

function basePublish(
  override: Partial<NotificationPublishInput> = {}
): NotificationPublishInput {
  return {
    source: 'agent',
    kind: 'run_done',
    title: 'Finished: Fix tests',
    body: 'Agent run finished',
    dedupeKey: runDoneDedupeKey('run-1'),
    action: { type: 'open_run', workspacePath: '/ws', runId: 'run-1' },
    ...override
  }
}

describe('notification service', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-notifications-'))
    setNotificationsPathForTests(join(dir, 'notifications.json'))
    settingsState.current = {
      ...DEFAULT_SETTINGS,
      notifications: { ...DEFAULT_SETTINGS.notifications }
    }
    windowState.focused = false
    windowState.minimized = false
    shown.length = 0
    send.mockReset()
    MockNotification.isSupported.mockReturnValue(true)
    MockNotification.instances = []
    MockNotification.activationCb = null
    resetNotificationsForTests()
    initNotifications()
  })

  afterEach(() => {
    resetNotificationsForTests()
    resetNotificationsStoreForTests()
    setNotificationBus(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('no-ops publish when master switch is off', () => {
    settingsState.current!.notifications.enabled = false
    expect(publishNotification(basePublish())).toBeNull()
    expect(listNotifications().items).toHaveLength(0)
    expect(shown).toHaveLength(0)
  })

  it('skips a disabled category but still allows other kinds', () => {
    settingsState.current!.notifications.agentRunFinished = false
    expect(publishNotification(basePublish())).toBeNull()
    const failed = publishNotification(
      basePublish({
        kind: 'run_error',
        title: 'Failed: Fix tests',
        dedupeKey: 'run:run-1:error'
      })
    )
    expect(failed?.kind).toBe('run_error')
    expect(listNotifications().items).toHaveLength(1)
  })

  it('skips OS show when desktop is off, unsupported, or focused in unfocused mode', () => {
    settingsState.current!.notifications.desktop = 'off'
    publishNotification(basePublish({ dedupeKey: 'a' }))
    expect(shown).toHaveLength(0)

    settingsState.current!.notifications.desktop = 'unfocused'
    MockNotification.isSupported.mockReturnValue(false)
    publishNotification(basePublish({ dedupeKey: 'b' }))
    expect(shown).toHaveLength(0)

    MockNotification.isSupported.mockReturnValue(true)
    windowState.focused = true
    publishNotification(basePublish({ dedupeKey: 'c' }))
    expect(shown).toHaveLength(0)

    settingsState.current!.notifications.desktop = 'always'
    publishNotification(basePublish({ dedupeKey: 'd' }))
    expect(shown).toHaveLength(1)
  })

  it('replaces an existing item in place for the same dedupe key', () => {
    publishNotification(basePublish({ title: 'Needs your input', kind: 'needs_you' }))
    const firstId = listNotifications().items[0]!.id
    publishNotification(
      basePublish({
        title: 'Needs your input',
        body: 'edit a.ts',
        kind: 'needs_you',
        dedupeKey: runDoneDedupeKey('run-1')
      })
    )
    const items = listNotifications().items
    expect(items).toHaveLength(1)
    expect(items[0]!.id).toBe(firstId)
    expect(items[0]!.body).toBe('edit a.ts')
  })

  it('caps the inbox at 50, dropping oldest read first', () => {
    settingsState.current!.notifications.desktop = 'off'
    for (let i = 0; i < 50; i++) {
      publishNotification(
        basePublish({
          title: `Item ${i}`,
          dedupeKey: `item:${i}`
        })
      )
    }
    const victim = listNotifications().items[10]
    expect(victim).toBeTruthy()
    markNotificationsRead({ id: victim!.id })
    publishNotification(basePublish({ title: 'Item 50', dedupeKey: 'item:50' }))
    const after = listNotifications().items
    expect(after).toHaveLength(50)
    expect(after.some((item) => item.id === victim!.id)).toBe(false)
    expect(after.some((item) => item.title === 'Item 50')).toBe(true)
  })

  it('sends activate payload on OS click', () => {
    const item = publishNotification(basePublish())
    expect(item).toBeTruthy()
    const toast = MockNotification.instances[0]!
    toast.emit('click')
    expect(send).toHaveBeenCalledWith(IPC.notificationsActivate, {
      type: 'open_run',
      workspacePath: '/ws',
      runId: 'run-1'
    })
    expect(listNotifications().items[0]!.read).toBe(true)
  })

  it('sends activate payload from Windows handleActivation', () => {
    const item = publishNotification(basePublish({ dedupeKey: 'win-activate' }))
    expect(item).toBeTruthy()
    expect(MockNotification.activationCb).toBeTruthy()
    MockNotification.activationCb?.({ arguments: item!.id })
    expect(send).toHaveBeenCalledWith(IPC.notificationsActivate, {
      type: 'open_run',
      workspacePath: '/ws',
      runId: 'run-1'
    })
    expect(listNotifications().items.find((entry) => entry.id === item!.id)?.read).toBe(true)
  })

  it('dismisses needs-you on tool approval resolve', async () => {
    resetToolApprovalForTests()
    const seen: Array<{ requestId: string }> = []
    registerApprovalSender('run-1', (request) => {
      seen.push(request)
    })
    const gate = createApprovalGate({
      runId: 'run-1',
      mode: 'mutating',
      workspaceAllowlist: [],
      signal: new AbortController().signal
    })
    const pending = gate.authorize({
      id: 'c2',
      name: 'edit',
      arguments: '{"path":"a.ts","contents":"x"}'
    })
    await Promise.resolve()
    publishNotification({
      source: 'agent',
      kind: 'needs_you',
      title: 'Needs your input',
      body: 'edit a.ts',
      dedupeKey: needsYouDedupeKey('run-1'),
      action: { type: 'open_run', workspacePath: '/ws', runId: 'run-1' }
    })
    expect(listNotifications().items).toHaveLength(1)
    expect(seen.length).toBeGreaterThan(0)
    expect(
      resolveToolApproval({ requestId: seen[0]!.requestId, runId: 'run-1', decision: 'once' })
    ).toBe(true)
    await pending
    expect(listNotifications().items).toHaveLength(0)
  })

  it('dismisses needs-you when pending approvals are cancelled', () => {
    publishNotification({
      source: 'agent',
      kind: 'needs_you',
      title: 'Needs your input',
      body: 'edit a.ts',
      dedupeKey: needsYouDedupeKey('run-1')
    })
    cancelPendingApprovals('run-1')
    expect(listNotifications().items).toHaveLength(0)
  })

  it('markRead and dismiss mutate the inbox snapshot', () => {
    publishNotification(basePublish({ dedupeKey: 'one' }))
    publishNotification(basePublish({ title: 'Other', dedupeKey: 'two' }))
    const id = listNotifications().items[0]!.id
    expect(markNotificationsRead({ id }).items.find((item) => item.id === id)?.read).toBe(true)
    expect(dismissNotifications({ id }).items.some((item) => item.id === id)).toBe(false)
    expect(dismissNotifications({ all: true }).items).toHaveLength(0)
  })

  it('dismiss by dedupe key is a no-op when missing', () => {
    expect(dismissNotificationsByDedupeKey('missing').items).toHaveLength(0)
  })
})
