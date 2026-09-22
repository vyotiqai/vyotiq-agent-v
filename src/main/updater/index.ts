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

/** Interval between background update checks while the app keeps running. */
export const PERIODIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

let current: UpdaterStatePayload = { status: 'idle' }
let lastInfo: UpdateInfo | null = null
let initialized = false
let checkInFlight = false
let startupTimer: NodeJS.Timeout | null = null
let periodicTimer: NodeJS.Timeout | null = null

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** electron-updater info → exact contract shape (markdown release body parsed). */
function toUpdateInfo(info: ElectronUpdateInfo): UpdateInfo {
  const parsed = parseReleaseNotes(info.releaseNotes)
  const version = info.version ?? ''
  return {
    version,
    releaseDate: info.releaseDate ?? '',
    releaseName: info.releaseName || `Version ${version}`,
    notesText: parsed.notesText,
    notesSections: parsed.notesSections,
    releaseUrl: version
      ? `https://github.com/vyotiqai/vyotiq-agent-v-releases/releases/tag/v${version}`
      : ''
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
        scope: 'updater',
        err
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
 * Arm or disarm every background update check. Idempotent: safe to call on
 * boot and again whenever the Settings "Automatic checks" switch changes, so
 * the setting takes effect live instead of only at the next launch.
 *
 * - Dev (`!app.isPackaged`) has no release feed, so nothing is ever armed.
 * - `enabled === false` clears both timers: off means no background network
 *   calls at all. An explicit `updater:check` still works — a manual action is
 *   always honoured.
 * - `enabled === true` arms the deferred one-shot startup check (app ready +
 *   a short idle delay so it never blocks first paint) and the periodic check
 *   that lets a long-running session learn about a release without a restart.
 *   The interval is unref'd so it never keeps the process alive on shutdown.
 */
export function applyUpdateCheckSchedule(enabled: boolean): void {
  if (!enabled || !app.isPackaged) {
    if (startupTimer) {
      clearTimeout(startupTimer)
      startupTimer = null
    }
    if (periodicTimer) {
      clearInterval(periodicTimer)
      periodicTimer = null
    }
    return
  }

  const check = (label: string): void => {
    void checkForAppUpdates({ silent: true }).catch((err) => {
      logger.warn(`[updater] ${label} check failed`, { scope: 'updater', err })
    })
  }

  if (!startupTimer) {
    const armStartup = (): void => {
      startupTimer = setTimeout(() => {
        startupTimer = null
        check('startup')
      }, STARTUP_CHECK_DELAY_MS)
    }
    if (app.isReady()) armStartup()
    else app.once('ready', armStartup)
  }

  if (!periodicTimer) {
    periodicTimer = setInterval(() => check('periodic'), PERIODIC_CHECK_INTERVAL_MS)
    periodicTimer.unref?.()
  }
}

/**
 * `updater:check` — returns the current UpdateInfo when an update is already
 * available/downloaded, otherwise runs a check. Resolves null when up to
 * date, in dev, or on failure.
 *
 * - `force` skips the cached-info short-circuit. Without it, once one update
 *   has been found the cached answer is returned forever and a newer release
 *   is invisible until the app restarts — so the Settings button forces.
 * - `silent` logs a failure instead of broadcasting `status: 'error'`. A
 *   background poll that happens to run offline must not overwrite a
 *   perfectly good `available` state with "Update check failed".
 */
export async function checkForAppUpdates(
  options?: { force?: boolean; silent?: boolean }
): Promise<UpdateInfo | null> {
  if (
    !options?.force &&
    lastInfo &&
    (current.status === 'available' || current.status === 'downloaded')
  ) {
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
    if (options?.silent) {
      logger.warn('[updater] background check failed', { scope: 'updater', err })
    } else {
      broadcast({ status: 'error', error: errorMessage(err) })
    }
    return null
  } finally {
    checkInFlight = false
  }
}

/** `updater:download` — download failures surface as status 'error'. */
export async function downloadAppUpdate(): Promise<void> {
  // Already downloading: report progress, never start a second transfer.
  if (current.status === 'downloading') return
  if (!app.isPackaged || current.status !== 'available') {
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
