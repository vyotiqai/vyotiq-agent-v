import { app } from 'electron'
import * as Sentry from '@sentry/electron/main'
import { scrubEventLike, scrubString } from '../../shared/scrub'
import { sanitizeErrorForLog, sanitizeLogFields, scrubSentryEvent } from '../../shared/logPolicy'
import type { LogFields } from '../../shared/logger'
import { getSettings } from '@main/settings/settings'
import { getWorkspaces } from '@main/workspace/workspaces'
import { crashReporterVersionTag } from './crashReporter'

let active = false

function resolveDsn(): string | undefined {
  const dsn = (process.env.SENTRY_DSN ?? process.env.VITE_SENTRY_DSN)?.trim()
  return dsn || undefined
}

export function isSentryBuildConfigured(): boolean {
  return Boolean(resolveDsn())
}

function workspaceCountTag(): number {
  try {
    return getWorkspaces().openPaths.length
  } catch {
    return 0
  }
}

function startSentry(dsn: string): void {
  if (active) return
  const isDev = !app.isPackaged
  Sentry.init({
    dsn,
    release: `vyotiq@${crashReporterVersionTag()}`,
    environment: isDev ? 'development' : 'production',
    sendDefaultPii: false,
    enableLogs: true,
    tracesSampleRate: isDev ? 1.0 : 0.1,
    beforeSend(event) {
      return scrubSentryEvent(scrubEventLike(event as unknown as Record<string, unknown>)) as unknown as typeof event
    },
    beforeSendLog(log) {
      if (log.message) log.message = scrubString(String(log.message))
      if (log.attributes) {
        log.attributes = sanitizeLogFields(log.attributes as Record<string, unknown>) as typeof log.attributes
      }
      return log
    }
  })
  Sentry.setTag('workspaceCount', String(workspaceCountTag()))
  active = true
}

async function stopSentry(): Promise<void> {
  if (!active) return
  // Clear before await so a concurrent re-init is not wiped when close finishes.
  active = false
  try {
    await Sentry.close(2000)
  } catch {
    // ignore
  }
}

/**
 * Init Sentry only when DSN exists AND settings.telemetryEnabled === true.
 * Safe to call multiple times (re-init / close on toggle).
 */
export function initSentryMain(): void {
  const dsn = resolveDsn()
  if (!dsn) {
    void stopSentry()
    return
  }

  let telemetryEnabled = false
  try {
    telemetryEnabled = getSettings().telemetryEnabled === true
  } catch {
    telemetryEnabled = false
  }

  if (!telemetryEnabled) {
    void stopSentry()
    return
  }

  startSentry(dsn)
}

/** Enable or disable Sentry after settings.telemetryEnabled changes. */
export function applySentryTelemetry(enabled: boolean): void {
  const dsn = resolveDsn()
  if (!dsn || !enabled) {
    void stopSentry()
    return
  }
  startSentry(dsn)
}

export function captureExceptionMain(err: unknown, fields?: LogFields): void {
  if (!active) return
  Sentry.withScope((scope) => {
    if (fields?.correlationId) scope.setTag('correlationId', String(fields.correlationId))
    if (fields?.code) scope.setTag('code', String(fields.code))
    if (fields?.scope) scope.setTag('scope', String(fields.scope))
    const scrubbed = fields ? sanitizeLogFields(fields as Record<string, unknown>) : undefined
    if (scrubbed) {
      const { err: _e, ...rest } = scrubbed
      scope.setExtras(rest)
    }
    Sentry.captureException(sanitizeErrorForLog(err) ?? { name: 'Error' })
  })
}
