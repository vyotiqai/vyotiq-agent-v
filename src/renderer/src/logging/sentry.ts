import * as Sentry from '@sentry/electron/renderer'
import { init as reactInit } from '@sentry/react'
import { scrubEventLike, scrubString } from '@shared/scrub'
import { sanitizeErrorForLog, sanitizeLogFields, scrubSentryEvent } from '@shared/logPolicy'
import type { LogFields } from '@shared/logger'
import { setRendererCaptureException } from './init'

let active = false

export function resolveRendererDsn(): string | undefined {
  const dsn = import.meta.env.VITE_SENTRY_DSN?.trim()
  return dsn || undefined
}

export function isRendererSentryBuildConfigured(): boolean {
  return Boolean(resolveRendererDsn())
}

function disableRendererSentry(): void {
  setRendererCaptureException(undefined)
  if (!active) return
  try {
    void Sentry.getClient()?.close()
  } catch {
    // ignore — disable path must never throw into settings
  }
  active = false
}

/**
 * Renderer Sentry + React bridge. Events only leave the machine when main
 * has initialized Sentry (DSN + telemetryEnabled).
 */
export function initRendererSentry(telemetryEnabled: boolean): void {
  const dsn = resolveRendererDsn()
  if (!dsn || !telemetryEnabled) {
    disableRendererSentry()
    return
  }
  if (active) return

  Sentry.init(
    {
      sendDefaultPii: false,
      enableLogs: true,
      tracesSampleRate: import.meta.env.DEV ? 1.0 : 0.1,
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
    },
    reactInit
  )

  setRendererCaptureException((err, fields) => {
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
  })
  active = true
}

export function captureRendererException(err: unknown, fields?: LogFields): void {
  if (!active) return
  Sentry.withScope((scope) => {
    if (fields?.correlationId) scope.setTag('correlationId', String(fields.correlationId))
    if (fields?.code) scope.setTag('code', String(fields.code))
    if (fields?.scope) scope.setTag('scope', String(fields.scope))
    Sentry.captureException(sanitizeErrorForLog(err) ?? { name: 'Error' })
  })
}
