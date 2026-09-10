import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_SETTINGS, runDoneDedupeKey, runErrorDedupeKey, type Settings } from '@shared/ipc'

const { send, windowState, settingsState, MockNotification, isActiveMock } = vi.hoisted(() => {
  class MockNotification {
    static isSupported = vi.fn(() => true)
    static handleActivation = vi.fn()
    static instances: MockNotification[] = []
    title: string
    body: string
    id: string
    constructor(opts: { title?: string; body?: string; id?: string }) {
      this.title = opts.title ?? ''
      this.body = opts.body ?? ''
      this.id = opts.id ?? ''
      MockNotification.instances.push(this)
    }
    show(): void {}
    close(): void {}
    on(): void {}
  }
  return {
    send: vi.fn(),
    windowState: { focused: false, minimized: false },
    settingsState: { current: null as Settings | null },
    MockNotification,
    isActiveMock: vi.fn<typeof import('@main/agent/runRegistry').isActive>()
  }
})

const userData = join(tmpdir(), `vyotiq-del-run-ud-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  Notification: MockNotification,
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      return join(tmpdir(), 'vyotiq-del-run-unused')
    },
    getAppPath: () => join(tmpdir(), 'vyotiq-del-run-unused')
  }
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: () => settingsState.current ?? { ...DEFAULT_SETTINGS }
}))

vi.mock('@main/agent/runRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/runRegistry')>()
  return {
    ...actual,
    isActive: isActiveMock
  }
})

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
  })
}))

import { createRun, deleteRun } from '@main/agent/state'
import { resolveRunDir } from '@main/storage/paths'
import {
  initNotifications,
  listNotifications,
  publishNotification,
  resetNotificationsForTests
} from '@main/notifications/service'
import {
  resetNotificationsStoreForTests,
  setNotificationsPathForTests
} from '@main/notifications/store'

describe('deleteRun dismisses run inbox items', () => {
  let dir: string
  let workspace: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-del-run-notif-'))
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-del-run-ws-'))
    setNotificationsPathForTests(join(dir, 'notifications.json'))
    settingsState.current = {
      ...DEFAULT_SETTINGS,
      notifications: { ...DEFAULT_SETTINGS.notifications, desktop: 'off' }
    }
    send.mockReset()
    MockNotification.instances = []
    resetNotificationsForTests()
    initNotifications()
  })

  afterEach(() => {
    resetNotificationsForTests()
    resetNotificationsStoreForTests()
    rmSync(dir, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
  })

  it('removes run:id:done and run:id:error after delete', async () => {
    const runId = 'run-delete-inbox'
    createRun(workspace, runId, 'Fix tests')
    publishNotification({
      source: 'agent',
      kind: 'run_error',
      title: 'Failed: Fix tests',
      body: 'Agent run failed',
      dedupeKey: runErrorDedupeKey(runId),
      action: { type: 'open_run', workspacePath: workspace, runId }
    })
    publishNotification({
      source: 'agent',
      kind: 'run_done',
      title: 'Finished: other',
      body: 'Other run finished',
      dedupeKey: runDoneDedupeKey('other-run'),
      action: { type: 'open_run', workspacePath: workspace, runId: 'other-run' }
    })
    expect(listNotifications().items.map((item) => item.dedupeKey).sort()).toEqual([
      runDoneDedupeKey('other-run'),
      runErrorDedupeKey(runId)
    ])

    const deleted = await deleteRun(workspace, runId)
    expect(deleted.ok).toBe(true)
    expect(listNotifications().items.map((item) => item.dedupeKey)).toEqual([
      runDoneDedupeKey('other-run')
    ])
  })

  it('dismisses child instance inbox keys when deleting the parent', async () => {
    const parentId = 'parent-run'
    const childId = 'child-run'
    createRun(workspace, parentId, 'Parent')
    createRun(workspace, childId, 'Child', {
      mode: 'agent',
      parentRunId: parentId,
      inlineInstance: true
    })
    publishNotification({
      source: 'agent',
      kind: 'run_error',
      title: 'Failed: Child',
      body: 'Instance failed',
      dedupeKey: runErrorDedupeKey(childId),
      action: { type: 'open_run', workspacePath: workspace, runId: childId }
    })
    publishNotification({
      source: 'agent',
      kind: 'run_done',
      title: 'Finished: Parent',
      body: 'Parent finished',
      dedupeKey: runDoneDedupeKey(parentId),
      action: { type: 'open_run', workspacePath: workspace, runId: parentId }
    })

    const deleted = await deleteRun(workspace, parentId)
    expect(deleted.ok).toBe(true)
    expect(listNotifications().items).toHaveLength(0)
  })

  it('does not delete a run that becomes active during deletion', async () => {
    const runId = 'run-active-mid-delete'
    createRun(workspace, runId, 'Becomes active mid-delete')
    const runDir = resolveRunDir(workspace, runId)
    expect(existsSync(runDir)).toBe(true)

    // Call 1 = deleteRun's entry guard; call 2 = the isActive re-check added
    // immediately before rmSync. tryRegisterRunAbort (runRegistry.ts:150) can
    // admit the same runId during the awaits between the two checks.
    isActiveMock
      .mockImplementationOnce(() => false)
      .mockImplementationOnce(() => true)

    const result = await deleteRun(workspace, runId)

    expect(result).toEqual({ ok: false, error: 'Cancel run first' })
    expect(existsSync(runDir)).toBe(true)
  })
})
