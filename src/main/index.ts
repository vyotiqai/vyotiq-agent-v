import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron'
import { join } from 'path'
import { electronApp } from '@electron-toolkit/utils'
import { watchWindowShortcuts } from '@main/app/windowShortcuts'
import { createWindow, applyWindowChrome, getMainWindow } from '@main/app/window'
import { initCustomCssWatchFromSettings } from '@main/appearance/customCss'
import { configureChromiumDiskCache } from '@main/app/chromiumProfile'
import { applyCertificateLogging, applyCsp } from '@main/app/security'
import { closeAgentBrowser } from '@main/app/agentBrowser'
import { disposeAllPtySessions, replayPtySessionsToWindow } from '@main/app/ptySessions'
import { disposeAllTerminalSessions } from '@main/agent/tools/terminalSessions'
import { registerIpc } from './ipc/register'
import { resumeActiveGoalsAndLoops } from './agent/resumeActiveGoals'
import { initAutoUpdater, scheduleStartupUpdateCheck } from '@main/updater'
import { initNotifications } from './notifications/service'
import { shutdownMcpServers, syncMcpServers } from '@main/agent/mcp'
import { resolveEffectiveMcpServers, syncMarketplaceMcpIntoSettings, purgeOrphanMarketplacePackageDirs } from '@main/marketplace'
import { getSettings } from '@main/settings/settings'
import { migrateLegacySessions } from '@main/storage/migrations/migrateSessions'
import { migrateWorkspaceRuns } from './storage/migrateWorkspaceRuns'
import { purgeLegacyProjectHarness } from '@main/agent/harness'
import { warmWorkspaceIndexes } from '@main/agent/workspaceIndex'
import { compactModelCacheOnBoot } from '@main/agent/providers/modelCache'
import {
  flushEventAppends,
  flushMessageAppends,
  flushStatusWrites
} from '@main/agent/state'
import { flushBeforeQuit, type EditorFlushStatus } from '@main/quitFlush'
import { shutdownTokenizerPool } from '@main/agent/context/tokenizerPool'
import { getEmbedUtilityClient } from '@main/agent/codeindex/embedUtilityClient'
import { getDictationUtilityClient } from '@main/dictation/whisperUtilityClient'
import {
  getWorkspaces,
  interruptOrphanRunsForWorkspaces
} from '@main/workspace/workspaces'
import { cancelAndWaitActiveRuns, listActiveRuns } from '@main/agent/runRegistry'
import { pruneStaleInstanceWorktreesBestEffort } from '@main/git/instanceWorktree'
import { initMainLogging } from './logging/init'
import { initTraceAutoCapture } from './perf/traceAutoCapture'
import { initCrashReporter } from './logging/crashReporter'
import { logger } from '../shared/logger'
import { IPC } from '../shared/channels'
import { startLoadPerfMonitor } from './perf/loadSnapshot'

// Keep Chromium caches under userData so concurrent/dev instances do not
// fight over the default Windows profile cache (Access denied / Gpu Cache).
// Fingerprint the main bundle so rebuilds do not reuse stale disk cache.
try {
  configureChromiumDiskCache(join(__dirname, 'index.js'))
} catch {
  // getPath can fail in odd launch contexts; ignore
}

// Crashpad must start before any renderer is created; prefer before ready.
initCrashReporter()

// Windows: GPU sandbox re-enabled — Chromium uses default GPU path on Win 11 26200+.
// If startup crashes return, bisect flags here (do not leave permanent disable-gpu-sandbox).

let quitting = false
let editorFlushSequence = 0
const EDITOR_FLUSH_TIMEOUT_MS = 4_500

// Route console/process termination signals into the existing graceful
// shutdown. Without this, Ctrl+C on `pnpm start` kills the launcher but orphans
// the Electron child, leaving instance-worktree files locked (EPERM) on the next
// launch. app.quit() runs the before-quit handler that releases those handles.
function requestGracefulQuit(): void {
  if (app.isReady()) {
    app.quit()
  } else {
    process.exit(0)
  }
}

process.on('SIGINT', requestGracefulQuit)
process.on('SIGTERM', requestGracefulQuit)
if (process.platform === 'win32') {
  process.on('SIGBREAK', requestGracefulQuit)
}

function requestRendererEditorFlush(win: BrowserWindow | null): Promise<EditorFlushStatus> {
  if (!win || win.isDestroyed()) return Promise.resolve('acknowledged')
  const requestId = `editor-flush-${Date.now()}-${++editorFlushSequence}`
  return new Promise<EditorFlushStatus>((resolve) => {
    let finished = false
    let timeout: NodeJS.Timeout
    const finish = (status: EditorFlushStatus): void => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      ipcMain.removeListener(IPC.workspaceEditorFlushResponse, onResponse)
      win.removeListener('closed', onClosed)
      resolve(status)
    }
    const onResponse = (event: Electron.IpcMainEvent, raw: unknown): void => {
      if (event.sender.id !== win.webContents.id) return
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
      const response = raw as { requestId?: unknown; ok?: unknown }
      if (response.requestId !== requestId) return
      if (response.ok !== true) {
        logger.warn('Renderer editor flush reported incomplete state', {
          scope: 'main',
          requestId
        })
      }
      finish(response.ok === true ? 'acknowledged' : 'failed')
    }
    const onClosed = (): void => finish('timeout')
    ipcMain.on(IPC.workspaceEditorFlushResponse, onResponse)
    win.once('closed', onClosed)
    timeout = setTimeout(() => {
      logger.warn('Renderer editor flush did not acknowledge before quit', {
        scope: 'main',
        requestId,
        timeoutMs: EDITOR_FLUSH_TIMEOUT_MS
      })
      finish('timeout')
    }, EDITOR_FLUSH_TIMEOUT_MS)
    try {
      win.webContents.send(IPC.workspaceEditorFlushRequest, { requestId })
    } catch {
      finish('failed')
    }
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = getMainWindow() ?? BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    // Accessibility is no longer forced on: Chromium auto-detects assistive
    // tech (WM_GETOBJECT) when unforced, and the forced tree cost every
    // renderer CPU even with no screen reader attached. The terminal reads
    // the detected state over IPC (accessibilitySupportState) instead.
    app.on('accessibility-support-changed', (_event, accessibilitySupportEnabled) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(IPC.accessibilitySupportChanged, { enabled: accessibilitySupportEnabled })
      }
    })
    // Flight recorder first: registers the fatal-path dump listeners before
    // logging's exit handlers and starts the always-on ring buffer.
    initTraceAutoCapture()
    // After userData path switches; before IPC / windows (Sentry + electron-log).
    initMainLogging()

    electronApp.setAppUserModelId('com.vyotiq.agent')
    applyCsp()
    applyCertificateLogging()
    try {
      const migration = migrateLegacySessions()
      if (migration.migrated > 0) {
        logger.info(`Migrated ${migration.migrated} legacy session(s)`, { scope: 'main' })
      }
      const runsMigration = migrateWorkspaceRuns()
      if (runsMigration.migrated > 0) {
        logger.info(`Migrated ${runsMigration.migrated} workspace run(s) to AppData`, {
          scope: 'main'
        })
      }
      const workspaces = getWorkspaces()
      const seen = new Set<string>()
      for (const root of [...workspaces.openPaths, ...workspaces.recentPaths]) {
        if (!root) continue
        const key = process.platform === 'win32' ? root.toLowerCase() : root
        if (seen.has(key)) continue
        seen.add(key)
        purgeLegacyProjectHarness(root)
      }
      // Warm the code (embedding) index for the active workspace at boot so it is
      // dense-ready on the agent's first codebase_search — a cold first search
      // would otherwise run a full walk+embed (and a first-use model download)
      // inside the tool call. Warm runs as a background job (concurrency-1 queue,
      // embedding in the utility process) and the embedder unloads after 5 idle
      // minutes, so startup stays responsive and steady-state memory bounded.
      const active = workspaces.activePath
      if (active) warmWorkspaceIndexes(active)
      const n = await interruptOrphanRunsForWorkspaces(workspaces)
      if (n > 0) {
        logger.info(`Interrupted ${n} orphan run(s)`, { scope: 'main' })
      }
      const liveIds = new Set(listActiveRuns().map((run) => run.runId))
      const pruneSeen = new Set<string>()
      for (const root of [...workspaces.openPaths, ...workspaces.recentPaths]) {
        if (!root) continue
        const key = process.platform === 'win32' ? root.toLowerCase() : root
        if (pruneSeen.has(key)) continue
        pruneSeen.add(key)
        pruneStaleInstanceWorktreesBestEffort(root, liveIds)
      }
      compactModelCacheOnBoot()
    } catch (err) {
      logger.warn('Failed startup workspace maintenance', { scope: 'main', err })
    }
    initNotifications()
    registerIpc()
    // Updater listeners + the deferred one-shot startup check (ready + idle
    // delay, packaged builds only). Never blocks first paint. The Settings
    // "Check for updates automatically" switch gates the startup check.
    initAutoUpdater()
    scheduleStartupUpdateCheck({ autoCheckEnabled: getSettings().autoCheckUpdates !== false })
    startLoadPerfMonitor()
    try {
      const orphan = purgeOrphanMarketplacePackageDirs()
      if (orphan.removed > 0) {
        logger.info('Purged orphan marketplace package directories', {
          scope: 'main',
          removed: orphan.removed
        })
      }
      await syncMarketplaceMcpIntoSettings()
      void syncMcpServers(resolveEffectiveMcpServers()).catch((err) => {
        logger.warn('MCP sync on startup failed', { scope: 'main', err })
      })
    } catch (err) {
      logger.warn('Marketplace MCP settings sync failed', { scope: 'main', err })
    }

    app.on('browser-window-created', (_, window) => {
      watchWindowShortcuts(window)
    })

    createWindow()
    applyWindowChrome(getSettings().theme, getSettings().skinId)
    initCustomCssWatchFromSettings()
    const bootWindow = getMainWindow()
    bootWindow?.webContents.once('did-finish-load', () => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) resumeActiveGoalsAndLoops(win.webContents)
    })

    const pushNativeTheme = (): void => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.themeChanged, nativeTheme.shouldUseDarkColors)
      }
      const settings = getSettings()
      applyWindowChrome(settings.theme, settings.skinId)
    }
    nativeTheme.on('updated', pushNativeTheme)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const win = createWindow()
        applyWindowChrome(getSettings().theme, getSettings().skinId)
        win.webContents.once('did-finish-load', () => {
          replayPtySessionsToWindow(win)
          resumeActiveGoalsAndLoops(win.webContents)
        })
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true

    void (async () => {
      try {
        const quiesced = await cancelAndWaitActiveRuns()
        if (quiesced.timedOut.length > 0) {
          logger.warn('Timed out waiting for active runs to stop before quit', {
            scope: 'main',
            timedOut: quiesced.timedOut
          })
        }
      } catch (err) {
        logger.warn('Failed to cancel active runs before quit', { scope: 'main', err })
      }

      closeAgentBrowser()
      disposeAllTerminalSessions()
      disposeAllPtySessions()
      void shutdownMcpServers()
      shutdownTokenizerPool()
      void getEmbedUtilityClient().shutdown()
      void getDictationUtilityClient().shutdown()

      const win = BrowserWindow.getFocusedWindow() ?? getMainWindow()
      const showQuitAnywayDialog = async (): Promise<'wait' | 'quit'> => {
        const message =
          'Vyotiq is still saving run data. Quit anyway? Unsaved data may be lost.'
        const result = win
          ? await dialog.showMessageBox(win, {
              type: 'warning',
              buttons: ['Wait', 'Quit anyway'],
              defaultId: 0,
              cancelId: 0,
              title: 'Saving run data',
              message
            })
          : await dialog.showMessageBox({
              type: 'warning',
              buttons: ['Wait', 'Quit anyway'],
              defaultId: 0,
              cancelId: 0,
              title: 'Saving run data',
              message
            })
        return result.response === 1 ? 'quit' : 'wait'
      }

      try {
        await flushBeforeQuit({
          flushMessageAppends,
          flushEventAppends,
          flushStatusWrites,
          flushEditorState: () => requestRendererEditorFlush(win),
          logger,
          showQuitAnywayDialog
        })
      } catch (err) {
        logger.warn('Failed to flush pending writes before quit', { scope: 'main', err })
        const choice = await showQuitAnywayDialog()
        if (choice === 'wait') {
          try {
            await flushBeforeQuit({
              flushMessageAppends,
              flushEventAppends,
              flushStatusWrites,
              flushEditorState: () => requestRendererEditorFlush(win),
              logger,
              showQuitAnywayDialog
            })
          } catch (retryErr) {
            logger.warn('Retry flush before quit also failed', { scope: 'main', err: retryErr })
          }
        }
      }
      app.quit()
    })()
  })
}
