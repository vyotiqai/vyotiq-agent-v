import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { app } from 'electron'
import log from 'electron-log/main'
import { logger, setLoggerBackend, type LogFields, type LogLevel } from '../../shared/logger'
import { initSentryMain, captureExceptionMain } from './sentry'
import { crashDumpsDirectory, isCrashReporterStarted } from './crashReporter'
import {
  countCrashpadReports,
  formatWindowsExitCode,
  markRendererRecoveryPending,
  recordCrashSnippet,
  sanitizeCrashUrl,
  shouldReloadRendererAfterCrash,
  planRendererReload,
  RENDERER_HEALTHY_RESET_MS,
  backfillCrashSnippetsFromLog
} from './crashDiagnostics'
import { isAbortError } from '../../shared/errors'
import { isIgnorablePipeError, isIgnorableUncaught } from './pipeErrors'

export { isIgnorablePipeError, isIgnorableUncaught } from './pipeErrors'

export function logsDirectory(): string {
  return join(app.getPath('userData'), 'logs')
}

function ensureLogsDirectory(): string {
  const dir = logsDirectory()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * electron-log v5 only creates the log directory when its File transport is
 * first registered (the File is cached in a module-global store), so it never
 * re-creates a directory deleted mid-run. It invokes resolvePathFn on every
 * message write — re-ensure the logs dir here so a missing
 * `%APPDATA%\vyotiq\logs` is self-healed before each write instead of failing
 * with ENOENT forever.
 */
export function resolvePathFn(): string {
  return join(ensureLogsDirectory(), 'vyotiq.log')
}

function mapLevel(level: LogLevel): 'debug' | 'info' | 'warn' | 'error' {
  if (level === 'fatal') return 'error'
  return level
}

/**
 * Configure rotating file logs under userData/logs and bridge renderer → main.
 * Call after any userData path changes and before registerIpc / windows.
 */
export function initMainLogging(): void {
  const logsDir = ensureLogsDirectory()
  // One-shot: populate Settings crash history from prior RENDERER/CHILD log lines.
  backfillCrashSnippetsFromLog(join(logsDir, 'vyotiq.log'))
  const isDev = !app.isPackaged

  log.initialize()
  log.transports.file.resolvePathFn = resolvePathFn
  log.transports.file.maxSize = 5 * 1024 * 1024 // 5 MB then rotate
  log.transports.file.level = isDev ? 'debug' : 'info'
  // Console writes to a closed pipe raise EPIPE; packaged / non-TTY runs skip console.
  const consoleWritable =
    isDev && Boolean(process.stdout?.writable) && process.stdout.isTTY !== false
  log.transports.console.level = consoleWritable ? 'debug' : false

  setLoggerBackend({
    log: (level, message, fields) => {
      const scope = fields?.scope ? `[${fields.scope}] ` : ''
      const cid = fields?.correlationId ? `{${fields.correlationId}} ` : ''
      // Shared logger already scrubbed fields (including Error → { name, message, stack, ... }).
      const { scope: _s, correlationId: _c, ...rest } = fields ?? {}
      const line = `${scope}${cid}${message}`
      const fn = log[mapLevel(level)].bind(log)
      if (Object.keys(rest).length) fn(line, rest)
      else fn(line)
    },
    captureException: (err, fields) => {
      captureExceptionMain(err, fields)
    }
  })

  // Optional Sentry (DSN + telemetryEnabled). Safe no-op when gated off.
  // crashReporter is started earlier in main/index.ts (before ready).
  initSentryMain()

  installProcessHandlers()
  installChildProcessCrashLogging()
  const crashDumpsPath = resolveCrashDumpsPath()
  logger.info('Logging initialized', {
    scope: 'main',
    logsDir,
    ...(crashDumpsPath ? { crashDumpsPath } : {}),
    crashReporterStarted: isCrashReporterStarted(),
    ...(crashDumpsPath ? { crashDumpCount: countCrashpadReports(crashDumpsPath) } : {})
  })
}

function installChildProcessCrashLogging(): void {
  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || details.reason === 'killed') {
      logger.info('Child process gone', {
        scope: 'main',
        processType: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        ...(details.name ? { name: details.name } : {}),
        ...(details.serviceName ? { serviceName: details.serviceName } : {})
      })
      return
    }
    const exitCodeHex = formatWindowsExitCode(details.exitCode)
    logger.error('Child process gone', {
      scope: 'main',
      code: 'CHILD_PROCESS_CRASH',
      processType: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      ...(exitCodeHex ? { exitCodeHex } : {}),
      ...(details.name ? { name: details.name } : {}),
      ...(details.serviceName ? { serviceName: details.serviceName } : {})
    })
    recordCrashSnippet({
      at: new Date().toISOString(),
      kind: 'child',
      reason: details.reason,
      exitCode: details.exitCode,
      ...(exitCodeHex ? { exitCodeHex } : {}),
      processType: details.type,
      ...(details.name ? { name: details.name } : {})
    })
  })
}

function swallowStreamPipeError(err: Error): void {
  if (isIgnorablePipeError(err)) return
}

function installProcessHandlers(): void {
  process.stdout?.on?.('error', swallowStreamPipeError)
  process.stderr?.on?.('error', swallowStreamPipeError)

  function exitAfterFlush(): void {
    // Give the log transport a tick to flush the fatal message, then terminate.
    setTimeout(() => {
      process.exit(1)
    }, 250)
  }

  process.on('uncaughtException', (err) => {
    // Logging an EPIPE via console transport re-triggers write → infinite storm.
    if (isIgnorableUncaught(err)) {
      if (isAbortError(err)) {
        logger.warn('Ignored abort-shaped uncaught exception', { scope: 'main', err })
      }
      return
    }
    logger.fatal('Uncaught exception', {
      scope: 'main',
      code: 'UNCAUGHT',
      err
    })
    exitAfterFlush()
  })

  process.on('unhandledRejection', (reason) => {
    if (isIgnorableUncaught(reason)) {
      if (isAbortError(reason)) {
        logger.warn('Ignored abort-shaped unhandled rejection', { scope: 'main', err: reason })
      }
      return
    }
    logger.fatal('Unhandled rejection', {
      scope: 'main',
      code: 'UNCAUGHT',
      err: reason instanceof Error ? reason : new Error(String(reason))
    })
    exitAfterFlush()
  })
}

export function logWithFields(level: LogLevel, message: string, fields?: LogFields): void {
  logger[level](message, fields)
}

let rendererReloadCount = 0
let lastRendererReloadAt = 0
let rendererReloadTimer: ReturnType<typeof setTimeout> | null = null
let rendererHealthyTimer: ReturnType<typeof setTimeout> | null = null

function resolveCrashDumpsPath(): string | undefined {
  return crashDumpsDirectory() ?? (() => {
    try {
      return app.getPath('crashDumps')
    } catch {
      return undefined
    }
  })()
}

function logRendererProcessGone(
  webContents: Electron.WebContents,
  details: Electron.RenderProcessGoneDetails
): void {
  const crashDumpsPath = resolveCrashDumpsPath()
  const exitCodeHex = formatWindowsExitCode(details.exitCode)
  const crashDumpCount = crashDumpsPath ? countCrashpadReports(crashDumpsPath) : undefined
  let url: string | undefined
  try {
    url = sanitizeCrashUrl(webContents.getURL())
  } catch {
    url = undefined
  }
  logger.error('Renderer process gone', {
    scope: 'main',
    code: 'RENDERER_CRASH',
    reason: details.reason,
    exitCode: details.exitCode,
    ...(exitCodeHex ? { exitCodeHex } : {}),
    ...(crashDumpsPath ? { crashDumpsPath } : {}),
    ...(crashDumpCount != null ? { crashDumpCount } : {}),
    ...(url ? { url } : {})
  })
  recordCrashSnippet({
    at: new Date().toISOString(),
    kind: 'renderer',
    reason: details.reason,
    exitCode: details.exitCode,
    ...(exitCodeHex ? { exitCodeHex } : {}),
    ...(url ? { url } : {}),
    ...(crashDumpCount != null ? { crashDumpCount } : {})
  })
}

function maybeReloadRendererAfterCrash(
  webContents: Electron.WebContents,
  details: Electron.RenderProcessGoneDetails
): void {
  if (!shouldReloadRendererAfterCrash(details.reason)) return
  const plan = planRendererReload({
    now: Date.now(),
    lastReloadAt: lastRendererReloadAt,
    reloadCount: rendererReloadCount,
    pending: rendererReloadTimer != null
  })
  if (plan.action === 'give-up') {
    logger.warn('Renderer reload limit reached after repeated crashes', {
      scope: 'main',
      reloadCount: rendererReloadCount
    })
    return
  }
  if (plan.action === 'skip-pending') return

  const fire = (): void => {
    rendererReloadTimer = null
    if (webContents.isDestroyed()) return
    lastRendererReloadAt = Date.now()
    rendererReloadCount += 1
    const exitCodeHex = formatWindowsExitCode(details.exitCode)
    markRendererRecoveryPending({
      at: new Date().toISOString(),
      reason: details.reason,
      exitCode: details.exitCode,
      ...(exitCodeHex ? { exitCodeHex } : {})
    })
    try {
      webContents.reload()
      logger.info('Reloading renderer after crash', {
        scope: 'main',
        reason: details.reason,
        reloadCount: rendererReloadCount
      })
    } catch (err) {
      logger.warn('Failed to reload renderer after crash', { scope: 'main', err })
    }
    if (rendererHealthyTimer) clearTimeout(rendererHealthyTimer)
    rendererHealthyTimer = setTimeout(() => {
      rendererReloadCount = 0
      lastRendererReloadAt = 0
      rendererHealthyTimer = null
    }, RENDERER_HEALTHY_RESET_MS)
  }

  if (plan.waitMs <= 0) {
    fire()
    return
  }
  rendererReloadTimer = setTimeout(fire, plan.waitMs)
}

export function attachWebContentsCrashLogging(
  webContents: Electron.WebContents
): void {
  webContents.on('render-process-gone', (_event, details) => {
    // Dev rebuild / intentional teardown — not a crash.
    if (details.reason === 'killed' || details.reason === 'clean-exit') {
      logger.info('Renderer process gone', {
        scope: 'main',
        reason: details.reason,
        exitCode: details.exitCode
      })
      return
    }
    logRendererProcessGone(webContents, details)
    maybeReloadRendererAfterCrash(webContents, details)
  })
  webContents.on('unresponsive', () => {
    logger.warn('Renderer unresponsive', { scope: 'main' })
  })
  webContents.on('responsive', () => {
    logger.info('Renderer responsive again', { scope: 'main' })
  })
}
