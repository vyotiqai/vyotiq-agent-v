import { app, BrowserWindow } from 'electron'
import {
  autoUpdater,
  type ProgressInfo,
  type UpdateInfo as ElectronUpdateInfo
} from 'electron-updater'
import { IPC } from '../../shared/channels'
import type { UpdateInfo, UpdaterStatePayload } from '../../shared/ipc'
import { parseReleaseNotes } from '../../shared/utils/releaseNotes'
import { logger } from '../../shared/logger'

/** Idle delay after app ready before the one-shot startup update check. */
export const STARTUP_CHECK_DELAY_MS = 10_000

let current: UpdaterStatePayload = { status: 'idle' }
let lastInfo: UpdateInfo | null = null
let initialized = false
let checkInFlight = false
let startupTimer: NodeJS.Timeout | null = null

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** electron-updater info → exact contract shape (markdown release body parsed). */
function toUpdateInfo(info: ElectronUpdateInfo): UpdateInfo {
  const parsed = parseReleaseNotes(info.releaseNotes)
  return {
    version: info.version ?? '',
    releaseDate: info.releaseDate ?? '',
    releaseName: info.releaseName || `Version ${info.version ?? ''}`,
    notesText: parsed.notesText,
    notesSections: parsed.notesSections
  }
}

function broadcast(next: UpdaterStatePayload): void {
  current = next
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(IPC.updaterState, next)
    } catch (err) {
      // A destroyed-mid-send window races the isDestroyed() check routinely;
      // record it instead of swallowing silently.
      logger.debug('[updater] broadcast to window failed', {
        error: errorMessage(err)
      })
    }
  }
}

/** Current updater state (same payload the renderer receives on `updater:state`). */
export function updaterState(): UpdaterStatePayload {
  return current
}

/**
 * Attach the event-driven state machine. No polling: transitions only happen
 * from autoUpdater events or an explicit check/download/install call, and
 * updates are never fetched automatically (autoDownload=false).
 */
export function initAutoUpdater(): void {
  if (initialized) return
  initialized = true
  // Updates are opt-in: the renderer shows release notes and the user picks
  // download / install explicitly. Full NSIS installers only.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.disableWebInstaller = true
  autoUpdater.logger = {
    info: (m) => logger.info(`[updater] ${m}`),
    warn: (m) => logger.warn(`[updater] ${m}`),
    error: (m) => logger.error(`[updater] ${m}`),
    debug: (m) => logger.debug(`[updater] ${m}`)
  } as typeof autoUpdater.logger

  autoUpdater.on('checking-for-update', () => {
    broadcast({ status: 'checking' })
  })
  autoUpdater.on('update-available', (info) => {
    lastInfo = toUpdateInfo(info)
    broadcast({ status: 'available', info: lastInfo })
  })
  autoUpdater.on('update-not-available', () => {
    broadcast({ status: 'not-available' })
  })
  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    broadcast({
      status: 'downloading',
      progress: {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total
      }
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    lastInfo = toUpdateInfo(info)
    broadcast({ status: 'downloaded', info: lastInfo })
  })
  autoUpdater.on('error', (err) => {
    broadcast({ status: 'error', error: errorMessage(err) })
  })
}

/**
 * Deferred one-shot startup check: after app ready + a short idle delay so it
 * never blocks first paint. Skipped entirely in dev (!app.isPackaged).
 * There is deliberately no interval — later checks only happen when the
 * renderer invokes `updater:check`.
 */
export function scheduleStartupUpdateCheck(
  options?: { autoCheckEnabled?: boolean }
): void {
  if (!app.isPackaged) return
  // The Settings "Check for updates automatically" switch gates the startup
  // check (absent setting = enabled).
  if (options?.autoCheckEnabled === false) return
  if (startupTimer) return
  const run = (): void => {
    startupTimer = null
    void checkForAppUpdates().catch((err) => {
      logger.warn('[updater] startup check failed', { error: errorMessage(err) })
    })
  }
  if (app.isReady()) {
    startupTimer = setTimeout(run, STARTUP_CHECK_DELAY_MS)
  } else {
    app.once('ready', () => {
      startupTimer = setTimeout(run, STARTUP_CHECK_DELAY_MS)
    })
  }
}

/**
 * `updater:check` — returns the current UpdateInfo when an update is already
 * available/downloaded, otherwise runs a check. Resolves null when up to
 * date, in dev, or on failure (failure also broadcasts status 'error').
 */
export async function checkForAppUpdates(): Promise<UpdateInfo | null> {
  if (lastInfo && (current.status === 'available' || current.status === 'downloaded')) {
    return lastInfo
  }
  if (!app.isPackaged) return null
  // Concurrent invokes share one in-flight check so autoUpdater events cannot
  // interleave between two overlapping requests.
  if (checkInFlight) {
    return current.status === 'available' && lastInfo ? lastInfo : null
  }
  checkInFlight = true
  try {
    await autoUpdater.checkForUpdates()
    return lastInfo && (current.status === 'available' || current.status === 'downloaded')
      ? lastInfo
      : null
  } catch (err) {
    broadcast({ status: 'error', error: errorMessage(err) })
    return null
  } finally {
    checkInFlight = false
  }
}

/** `updater:download` — download failures surface as status 'error'. */
export async function downloadAppUpdate(): Promise<void> {
  if (
    !app.isPackaged ||
    (current.status !== 'available' && current.status !== 'downloading')
  ) {
    broadcast({
      status: 'error',
      error: 'No update is available to download. Check for updates first.'
    })
    return
  }
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    broadcast({ status: 'error', error: errorMessage(err) })
  }
}

/** `updater:install` — quit and install only after a completed download. */
export function installAppUpdate(): void {
  if (current.status !== 'downloaded' || !lastInfo) {
    broadcast({
      status: 'error',
      error: 'Download the update before restarting to install.'
    })
    return
  }
  autoUpdater.quitAndInstall()
}
