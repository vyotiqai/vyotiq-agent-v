import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron'
import { join } from 'path'
import { electronApp } from '@electron-toolkit/utils'
import { watchWindowShortcuts } from '@main/app/windowShortcuts'
import { createWindow, applyWindowChrome, getMainWindow } from '@main/app/window'
import { createTray, destroyTray } from '@main/app/tray'
import { planSecondInstanceAction } from '@main/app/secondInstance'
import { handleDeepLinkArgv, registerDeepLinks } from '@main/app/deepLinks'
import { applyBadgeNow, notifyBadgeChange, setBadgeProvider } from '@main/app/badges'
import { initCustomCssWatchFromSettings } from '@main/appearance/customCss'
import { configureChromiumDiskCache } from '@main/app/chromiumProfile'
import { applyCertificateLogging, applyCsp } from '@main/app/security'
import { widenHappyEyeballsWindow } from '@main/net/happyEyeballs'
import { closeAgentBrowser } from '@main/app/agentBrowser'
import { disposeAllPtySessions, replayPtySessionsToWindow } from '@main/app/ptySessions'
import { disposeAllTerminalSessions } from '@main/agent/tools/terminalSessions'
import { registerIpc } from './ipc/register'
import { resumeActiveGoalsAndLoops } from './agent/resumeActiveGoals'
import { resumeTasksForWorkspaces } from './agent/taskScheduler'
import { initAutoUpdater, applyUpdateCheckSchedule } from '@main/updater'
import { initNotifications, unreadNotificationCount } from './notifications/service'
import { shutdownMcpServers, syncMcpServers } from '@main/agent/mcp'
import { primeLoginShellPath } from '@main/agent/mcp/binaries'
import { resolveEffectiveMcpServers, repairMissingPackageDependencies, syncMarketplaceMcpIntoSettings, purgeOrphanMarketplacePackageDirs } from '@main/marketplace'
import { getSettings } from '@main/settings/settings'
import { migrateLegacySessions } from '@main/storage/migrations/migrateSessions'
import { migrateWorkspaceRuns } from './storage/migrateWorkspaceRuns'
import { sweepRetentionAuto } from '@main/storage/retention'
import { purgeLegacyProjectHarness } from '@main/agent/harness'
import { warmWorkspaceIndexes } from '@main/agent/workspaceIndex'
import { compactModelCacheOnBoot } from '@main/agent/providers/modelCache'
import {
  collectProtectedInstanceRunIds,
  flushEventAppends,
  flushMessageAppends,
  flushStatusWrites
} from '@main/agent/state'
import { flushBeforeQuit, type EditorFlushStatus } from '@main/quitFlush'
import { shutdownTokenizerPool } from '@main/agent/context/tokenizerPool'
import { getDictationUtilityClient } from '@main/dictation/whisperUtilityClient'
import {
  getWorkspaces,
  interruptOrphanRunsForWorkspaces
} from '@main/workspace/workspaces'
import { cancelAndWaitActiveRuns, listActiveRuns } from '@main/agent/runRegistry'
import { countPendingToolApprovals } from '@main/agent/toolApproval'
import { countPendingAgentQuestions } from '@main/agent/agentQuestion'
import { pruneStaleInstanceWorktreesBestEffort } from '@main/git/instanceWorktree'
import { initMainLogging, rendererUnresponsiveForMs } from './logging/init'
import { flushEgressRunLedgers, startEgressRunLedger } from './agent/egressRunLedger'
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
/** Bound on awaiting child-process teardown in before-quit (fatal path). */
const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000
// Goal/loop resume adds provider+indexer load at window load; let first paint
// and renderer hydration win first.
const RESUME_AFTER_FIRST_PAINT_MS = 2_000

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

/** Editor-flush result captured while the window still existed (close path). */
let editorFlushFromClose: EditorFlushStatus | null = null
/** Windows already flushed by their own `close` handler. */
const flushedOnClose = new WeakSet<BrowserWindow>()

/**
 * Flush renderer editor state while the window can still answer.
 *
 * On Windows/Linux the X button destroys the window, `closed` nulls
 * `mainWindow`, and only then does `window-all-closed` reach `before-quit` —
 * by which point there is nothing left to ask, and the quit path used to
 * report a clean 'acknowledged' without the renderer ever having been asked to
 * save. Ask here, before teardown, and remember the answer for `before-quit`.
 */
function attachEditorFlushOnClose(win: BrowserWindow): BrowserWindow {
  editorFlushFromClose = null
  win.on('close', (event) => {
    // `before-quit` owns the flush on the quit path, and our own second close
    // must fall through.
    if (quitting || flushedOnClose.has(win) || win.isDestroyed()) return
    event.preventDefault()
    flushedOnClose.add(win)
    void (async () => {
      editorFlushFromClose = await requestRendererEditorFlush(win)
      if (!win.isDestroyed()) win.close()
    })()
  })
  return win
}

function requestRendererEditorFlush(win: BrowserWindow | null): Promise<EditorFlushStatus> {
  // No window to ask. A flush done on the way out stands; otherwise we do not
  // know whether the renderer saved, and must not claim that it did.
  if (!win || win.isDestroyed()) return Promise.resolve(editorFlushFromClose ?? 'timeout')
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
  // Logging is not initialized this early; the shared logger falls back to
  // console so a rejected relaunch is no longer a silent no-op.
  logger.warn('Single-instance lock denied; another instance owns the app - quitting', {
    scope: 'main'
  })
  app.quit()
} else {
  registerDeepLinks()
  app.on('second-instance', (_event, argv) => {
    // Windows/Linux: a vyotiq:// activation arrives in the second instance's
    // argv. Handle it before focusing so the link survives a wedged-window
    // recreate (the pending slot is drained by the renderer on mount).
    handleDeepLinkArgv(argv)
    const win = getMainWindow() ?? BrowserWindow.getAllWindows()[0]
    const unresponsiveForMs = rendererUnresponsiveForMs()
    const plan = planSecondInstanceAction({ hasWindow: !!win, unresponsiveForMs })
    logger.info('Second instance launched', { scope: 'main', action: plan.action, unresponsiveForMs })
    if (!win) return
    if (plan.action === 'recreate-window') {
      logger.warn('Recreating window unresponsive beyond threshold', {
        scope: 'main',
        unresponsiveForMs
      })
      // Create the replacement BEFORE destroying the wedged window:
      // window-all-closed quits the app once the window count hits zero.
      const fresh = attachEditorFlushOnClose(createWindow())
      applyWindowChrome(getSettings().theme, getSettings().skinId)
      applyBadgeNow()
      fresh.webContents.once('did-finish-load', () => {
        replayPtySessionsToWindow(fresh)
        // Same rationale as boot resume: let first paint and hydration win.
        setTimeout(() => {
          if (!fresh.isDestroyed()) resumeActiveGoalsAndLoops(fresh.webContents)
          // Queued tasks held for a missing window can start again now.
          void resumeTasksForWorkspaces(getWorkspaces().openPaths)
        }, RESUME_AFTER_FIRST_PAINT_MS)
      })
      win.destroy()
      return
    }
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  // Before anything dials out. The runtime's 250ms per-address connect window
  // is shorter than a transcontinental round trip, which stops a multi-homed
  // host being reachable at all rather than merely being slow.
  widenHappyEyeballsWindow()

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
    // Subscribe before anything can egress, so a run's outbound origins are
    // recorded from its first request rather than from whenever this ran.
    startEgressRunLedger()

    electronApp.setAppUserModelId('com.vyotiq.agent')
    applyCsp()
    applyCertificateLogging()
    // Recover the user's real PATH before any MCP server is spawned. A macOS app
    // launched from Finder inherits only /usr/bin:/bin:/usr/sbin:/sbin, which
    // hides nvm's node and uv. Bounded and best-effort; no-op off macOS.
    await primeLoginShellPath()
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
        // Identify protected instance checkouts BEFORE pruning. `liveIds` holds
        // only runs live in this process, and at boot that is empty — every
        // resumable instance's checkout would otherwise look stale and be
        // deleted right after the interrupt pass promised it a resume.
        const keep = collectProtectedInstanceRunIds(root)
        for (const id of liveIds) keep.add(id)
        pruneStaleInstanceWorktreesBestEffort(root, keep)
      }
      compactModelCacheOnBoot()
      // Storage retention boot sweep (audit H4/H5): free resolved/undone
      // checkpoint pass (+ full policy after §8.1 ack). Fire-and-forget —
      // never blocks first paint; the sweep itself is skip-and-log.
      void sweepRetentionAuto().catch(() => {
        /* sweepRetentionAuto already logs internally; nothing more to do */
      })
    } catch (err) {
      logger.warn('Failed startup workspace maintenance', { scope: 'main', err })
    }
    initNotifications()
    registerIpc()
    // Taskbar badge: main-only computation over live stores; the stores push
    // notifyBadgeChange() on their own mutations.
    setBadgeProvider(() => ({
      pendingApprovals: countPendingToolApprovals(),
      pendingQuestions: countPendingAgentQuestions(),
      unreadNotifications: unreadNotificationCount(),
      activeRuns: listActiveRuns().length
    }))
    notifyBadgeChange()
    // Updater listeners + the background check schedule (deferred startup
    // one-shot plus the periodic re-check, packaged builds only). Never blocks
    // first paint. The Settings "Automatic checks" switch gates both, and
    // re-applies live from the setSettings handler.
    initAutoUpdater()
    applyUpdateCheckSchedule(getSettings().autoCheckUpdates !== false)
    startLoadPerfMonitor()
    try {
      const orphan = purgeOrphanMarketplacePackageDirs()
      if (orphan.removed > 0) {
        logger.info('Purged orphan marketplace package directories', {
          scope: 'main',
          removed: orphan.removed
        })
      }
      // Before the MCP sync: a dependency restored here may itself be an MCP
      // package that then needs a settings entry.
      const restored = await repairMissingPackageDependencies()
      if (restored.length > 0) {
        logger.info('Restored missing marketplace dependencies', {
          scope: 'main',
          packages: restored
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

    attachEditorFlushOnClose(createWindow())
    applyWindowChrome(getSettings().theme, getSettings().skinId)
    applyBadgeNow()
    // The tray polls the run registry rather than being pushed at: run starts
    // and finishes are already chatty, and the tray only needs a count.
    createTray({ getActiveRunCount: () => listActiveRuns().length })
    initCustomCssWatchFromSettings()
    // Windows/Linux cold start: the OS launches us with the URL in our own argv.
    handleDeepLinkArgv(process.argv)
    const bootWindow = getMainWindow()
    bootWindow?.webContents.once('did-finish-load', () => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        // Goal/loop resume adds provider+indexer load at window load; let
        // first paint and renderer hydration win first.
        setTimeout(() => {
          if (!win.isDestroyed()) resumeActiveGoalsAndLoops(win.webContents)
          // Delegated tasks re-arm after goals: queued tasks need a free window
          // to stream into, and scheduling must not stampede boot.
          void resumeTasksForWorkspaces(getWorkspaces().openPaths)
        }, RESUME_AFTER_FIRST_PAINT_MS)
      }
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
        const win = attachEditorFlushOnClose(createWindow())
        applyWindowChrome(getSettings().theme, getSettings().skinId)
        applyBadgeNow()
        win.webContents.once('did-finish-load', () => {
          replayPtySessionsToWindow(win)
          // Goal/loop resume adds provider+indexer load at window load; let
          // first paint and renderer hydration win first.
          setTimeout(() => {
            if (!win.isDestroyed()) resumeActiveGoalsAndLoops(win.webContents)
            // Window recreation must re-pump queued tasks held while no
            // window existed — same contract as the boot path above.
            void resumeTasksForWorkspaces(getWorkspaces().openPaths)
          }, RESUME_AFTER_FIRST_PAINT_MS)
        })
      }
    })
  }).catch((err: unknown) => {
    // Boot steps outside the inner try/catch must not become an unhandled
    // rejection: surface the failure and quit instead of a silent dead boot.
    logger.error('Fatal error during app boot', { scope: 'main', err })
    void dialog
      .showMessageBox({
        type: 'error',
        title: 'Vyotiq failed to start',
        message: 'Vyotiq failed to start. Check the logs for details.',
        buttons: ['Quit'],
        defaultId: 0
      })
      .then(() => app.quit())
      .catch(() => app.quit())
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

      destroyTray()
      closeAgentBrowser()
      disposeAllTerminalSessions()
      disposeAllPtySessions()
      shutdownTokenizerPool()
      // Await child-process teardown so quit cannot land mid-shutdown, but bound
      // each wait so a stuck child cannot hang quit on the fatal path. Bounded
      // best-effort flushes ride here too: user data is flushed by
      // flushBeforeQuit below, which may ask the user to keep waiting, and a
      // diagnostic write must never be the reason for that prompt.
      const shutdowns: Array<[string, Promise<void>]> = [
        // Pending egress writes are debounced by a second, so a quit inside
        // that window would drop the tail of a run's record — usually the part
        // worth reading, since it covers whatever the run was doing when it
        // stopped.
        ['egress ledger', flushEgressRunLedgers()],
        ['MCP servers', shutdownMcpServers()],
        ['dictation utility', getDictationUtilityClient().shutdown()]
      ]
      for (const [label, task] of shutdowns) {
        try {
          await Promise.race([
            task,
            new Promise<void>((resolve) => setTimeout(resolve, CHILD_SHUTDOWN_TIMEOUT_MS))
          ])
        } catch (err) {
          logger.warn(`Failed to shut down ${label} before quit`, { scope: 'main', err })
        }
      }

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
