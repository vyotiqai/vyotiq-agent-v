import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { EventEmitter } from 'node:events'
import { IPC } from '@shared/channels'
import { app as electronApp, BrowserWindow } from 'electron'
import { autoUpdater as autoUpdaterModule } from 'electron-updater'

interface AutoUpdaterMock extends EventEmitter {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  disableWebInstaller: boolean
  checkForUpdates: Mock
  downloadUpdate: Mock
  quitAndInstall: Mock
}

// vi.mock factories below are hoisted above these imports, so these bindings
// are the mocks. Their instances survive vi.resetModules() (only non-mocked
// modules are re-evaluated), so beforeEach resets their state explicitly.
const autoUpdater = autoUpdaterModule as unknown as AutoUpdaterMock
const electronAppMock = electronApp as unknown as {
  isPackaged: boolean
  isReady: () => boolean
  once: Mock
}
const getAllWindows = BrowserWindow.getAllWindows as unknown as Mock

const STARTUP_DELAY_MS = 10_000
const PERIODIC_INTERVAL_MS = 6 * 60 * 60 * 1000

vi.mock('electron-updater', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  class AutoUpdater extends Emitter {
    autoDownload = false
    autoInstallOnAppQuit = false
    disableWebInstaller = false
    logger: unknown = null
    checkForUpdates = vi.fn(async () => null)
    downloadUpdate = vi.fn(async () => null)
    quitAndInstall = vi.fn()
  }
  return { autoUpdater: new AutoUpdater() }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    isReady: () => true,
    getVersion: () => '1.2.0',
    once: vi.fn()
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

vi.mock('@shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

async function loadUpdater(): Promise<typeof import('@main/updater')> {
  return import('@main/updater')
}

describe('updater service', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    autoUpdater.removeAllListeners()
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.disableWebInstaller = false
    autoUpdater.checkForUpdates.mockReset()
    autoUpdater.checkForUpdates.mockImplementation(async () => null)
    autoUpdater.downloadUpdate.mockReset()
    autoUpdater.downloadUpdate.mockImplementation(async () => null)
    autoUpdater.quitAndInstall.mockReset()
    getAllWindows.mockReset()
    getAllWindows.mockImplementation(() => [])
    electronAppMock.isPackaged = true
    electronAppMock.isReady = () => true
    electronAppMock.once.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('disables auto-download / auto-install and rejects web installers', async () => {
    const updater = await loadUpdater()
    updater.initAutoUpdater()
    expect(autoUpdater.autoDownload).toBe(false)
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false)
    expect(autoUpdater.disableWebInstaller).toBe(true)
  })

  it('defers the startup check past ready + idle delay', async () => {
    const updater = await loadUpdater()
    updater.initAutoUpdater()
    updater.applyUpdateCheckSchedule(true)
    expect(electronAppMock.once).not.toHaveBeenCalled()
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS - 1)
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('keeps re-checking on the periodic interval so a long session sees a release', async () => {
    const updater = await loadUpdater()
    updater.initAutoUpdater()
    updater.applyUpdateCheckSchedule(true)

    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(PERIODIC_INTERVAL_MS)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(PERIODIC_INTERVAL_MS)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('stops every background check when automatic checks are switched off', async () => {
    const updater = await loadUpdater()
    updater.initAutoUpdater()
    updater.applyUpdateCheckSchedule(true)

    // Off before the deferred startup check has even fired.
    updater.applyUpdateCheckSchedule(false)
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + PERIODIC_INTERVAL_MS * 10)
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()

    // An explicit user check is still honoured with the switch off.
    await updater.checkForAppUpdates({ force: true })
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('re-arms the schedule live, without stacking timers on repeat calls', async () => {
    const updater = await loadUpdater()
    updater.initAutoUpdater()
    updater.applyUpdateCheckSchedule(true)
    updater.applyUpdateCheckSchedule(true)
    updater.applyUpdateCheckSchedule(true)

    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(PERIODIC_INTERVAL_MS)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)

    // Switching back on re-arms the short startup check too, so the user
    // learns about a release promptly instead of waiting a full interval.
    updater.applyUpdateCheckSchedule(false)
    updater.applyUpdateCheckSchedule(true)
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(PERIODIC_INTERVAL_MS)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(4)
  })

  it('skips the startup check entirely in dev (!app.isPackaged)', async () => {
    const updater = await loadUpdater()
    electronAppMock.isPackaged = false
    updater.initAutoUpdater()
    updater.applyUpdateCheckSchedule(true)
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS * 10)
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    await expect(updater.checkForAppUpdates()).resolves.toBeNull()
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('broadcasts every state transition on updater:state with structured notes', async () => {
    const updater = await loadUpdater()
    updater.initAutoUpdater()
    const send = vi.fn()
    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, webContents: { send } }
    ])

    autoUpdater.emit('checking-for-update')
    expect(send).toHaveBeenNthCalledWith(1, IPC.updaterState, { status: 'checking' })

    autoUpdater.emit('update-available', {
      version: '1.3.0',
      releaseDate: '2026-09-01T00:00:00.000Z',
      releaseName: 'Vyotiq 1.3.0',
      releaseNotes: '## Fixed\n- Crash on save\n- Wrong icon\n## Added\n- Pinned chats'
    })
    expect(send).toHaveBeenNthCalledWith(2, IPC.updaterState, {
      status: 'available',
      info: {
        version: '1.3.0',
        releaseDate: '2026-09-01T00:00:00.000Z',
        releaseName: 'Vyotiq 1.3.0',
        notesText: '## Fixed\n- Crash on save\n- Wrong icon\n## Added\n- Pinned chats',
        notesSections: [
          { heading: 'Fixed', items: ['Crash on save', 'Wrong icon'] },
          { heading: 'Added', items: ['Pinned chats'] }
        ],
        releaseUrl:
          'https://github.com/vyotiqai/vyotiq-agent-v-releases/releases/tag/v1.3.0'
      }
    })

    autoUpdater.emit('download-progress', { percent: 42.5, transferred: 850, total: 2000 })
    expect(send).toHaveBeenNthCalledWith(3, IPC.updaterState, {
      status: 'downloading',
      progress: { percent: 42.5, transferred: 850, total: 2000 }
    })

    autoUpdater.emit('update-downloaded', {
      version: '1.3.0',
      releaseNotes: '## Fixed\n- Crash on save'
    })
    expect(send).toHaveBeenNthCalledWith(4, IPC.updaterState, {
      status: 'downloaded',
      info: expect.objectContaining({ version: '1.3.0' })
    })

    autoUpdater.emit('error', new Error('network down'))
    expect(send).toHaveBeenNthCalledWith(5, IPC.updaterState, {
      status: 'error',
      error: 'network down'
    })

    expect(updater.updaterState()).toEqual({ status: 'error', error: 'network down' })
  })

  it('adds the update-ready row to the inbox when the download finishes, and only then', async () => {
    const { setNotificationBus } = await import('@main/notifications/bus')
    const publish = vi.fn()
    setNotificationBus({ publish, dismissByDedupeKey: vi.fn() })
    const updater = await loadUpdater()
    updater.initAutoUpdater()
    getAllWindows.mockReturnValue([])
    autoUpdater.emit('update-available', { version: '1.3.0' })
    autoUpdater.emit('download-progress', { percent: 50, transferred: 1, total: 2 })
    expect(publish).not.toHaveBeenCalled()
    autoUpdater.emit('update-downloaded', { version: '1.3.0' })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      source: 'system',
      kind: 'update_ready',
      title: 'Agent V 1.3.0 is ready',
      body: 'Restart to install',
      dedupeKey: 'update_ready',
      action: { type: 'open_update' }
    })
    // Still never downloads or installs by itself.
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    setNotificationBus(null)
  })

  it('emits not-available when up to date', async () => {
    const updater = await loadUpdater()
    updater.initAutoUpdater()
    const send = vi.fn()
    getAllWindows.mockReturnValue([
      { isDestroyed: () => false, webContents: { send } }
    ])
    autoUpdater.emit('update-not-available')
    expect(send).toHaveBeenCalledWith(IPC.updaterState, { status: 'not-available' })
  })

  it('check returns the current info once an update is available (no re-check)', async () => {
    const updater = await loadUpdater()
    updater.initAutoUpdater()
    autoUpdater.emit('update-available', { version: '1.3.0', releaseNotes: null })
    await expect(updater.checkForAppUpdates()).resolves.toMatchObject({
      version: '1.3.0',
      notesSections: []
    })
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('force re-checks past the cached result so a second release is visible', async () => {
    const updater = await loadUpdater()
    updater.initAutoUpdater()
    autoUpdater.emit('update-available', { version: '1.3.0', releaseNotes: null })

    // Without force the cached answer is returned forever, which would hide
    // 1.4.0 until the app restarts.
    autoUpdater.checkForUpdates.mockImplementationOnce(async () => {
      autoUpdater.emit('update-available', { version: '1.4.0', releaseNotes: null })
      return null
    })
    await expect(updater.checkForAppUpdates({ force: true })).resolves.toMatchObject({
      version: '1.4.0'
    })
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('a silent background failure leaves the last good status alone', async () => {
    const updater = await loadUpdater()
    updater.initAutoUpdater()
    autoUpdater.emit('update-available', { version: '1.3.0', releaseNotes: null })
    expect(updater.updaterState().status).toBe('available')

    autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('offline'))
    await expect(
      updater.checkForAppUpdates({ force: true, silent: true })
    ).resolves.toBeNull()

    // An offline poll must not replace a real update with "check failed".
    expect(updater.updaterState()).toMatchObject({ status: 'available' })
  })

  it('does not start a second download while one is in flight', async () => {
    const updater = await loadUpdater()
    updater.initAutoUpdater()
    autoUpdater.emit('update-available', { version: '1.3.0' })
    autoUpdater.emit('download-progress', { percent: 42, transferred: 42, total: 100 })
    expect(updater.updaterState().status).toBe('downloading')

    await updater.downloadAppUpdate()
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
    // Progress is preserved rather than flipped to an error.
    expect(updater.updaterState().status).toBe('downloading')
  })

  it('check runs once when idle and resolves null when up to date', async () => {
    const updater = await loadUpdater()
    updater.initAutoUpdater()
    await expect(updater.checkForAppUpdates()).resolves.toBeNull()
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(updater.updaterState()).toEqual({ status: 'idle' })
  })

  it('check surfaces failures as status error and resolves null', async () => {
    const updater = await loadUpdater()
    updater.initAutoUpdater()
    autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('offline'))
    await expect(updater.checkForAppUpdates()).resolves.toBeNull()
    expect(updater.updaterState()).toEqual({ status: 'error', error: 'offline' })
  })

  it('download refuses without an available update and surfaces failures as error', async () => {
    const updater = await loadUpdater()
    updater.initAutoUpdater()
    await updater.downloadAppUpdate()
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.updaterState().status).toBe('error')

    autoUpdater.emit('update-available', { version: '1.3.0' })
    await updater.downloadAppUpdate()
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)

    autoUpdater.downloadUpdate.mockRejectedValueOnce(new Error('disk full'))
    await updater.downloadAppUpdate()
    expect(updater.updaterState()).toEqual({ status: 'error', error: 'disk full' })
  })

  it('install only quits and installs after a completed download', async () => {
    const updater = await loadUpdater()
    updater.initAutoUpdater()
    updater.installAppUpdate()
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(updater.updaterState().status).toBe('error')

    autoUpdater.emit('update-downloaded', { version: '1.3.0' })
    updater.installAppUpdate()
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })
})
