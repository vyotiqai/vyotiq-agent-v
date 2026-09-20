import { scrubEventLike, scrubString } from '@shared/scrub'
import { sanitizeErrorForLog, sanitizeLogFields, scrubSentryEvent } from '@shared/logPolicy'
import { logger, type LogFields } from '@shared/logger'
import { setRendererCaptureException } from './init'

type SentryRenderer = typeof import('@sentry/electron/renderer')
/** The entry points used after init — kept narrow so the lazy chunk stays tree-shaken. */
type SentryApi = Pick<SentryRenderer, 'withScope' | 'captureException' | 'getClient'>

/**
 * The SDK is loaded on demand. Imported statically it sat in the renderer
 * entry chunk and was parsed on every launch, telemetry on or off — and
 * events only ever leave the machine when main has initialized Sentry (DSN +
 * telemetryEnabled), so a telemetry-off launch never needs the code at all.
 */
let sentry: SentryApi | null = null
let active = false
/** Bumped by every init/disable so a load still in flight cannot revive a client that was just switched off. */
let generation = 0

export function resolveRendererDsn(): string | undefined {
  const dsn = import.meta.env.VITE_SENTRY_DSN?.trim()
  return dsn || undefined
}

export function isRendererSentryBuildConfigured(): boolean {
  return Boolean(resolveRendererDsn())
}

/**
 * Names are destructured straight off each `import()` so Rollup keeps only
 * these exports. A module namespace held in a variable is opaque to it and
 * drags replay, feedback and every other integration into the chunk (448 kB
 * instead of ~100 kB, measured on the first cut of this loader).
 */
async function loadSdk(): Promise<{
  init: SentryRenderer['init']
  reactInit: (typeof import('@sentry/react'))['init']
  api: SentryApi
}> {
  const { init, withScope, captureException, getClient } = await import(
    '@sentry/electron/renderer'
  )
  const { init: reactInit } = await import('@sentry/react')
  return { init, reactInit, api: { withScope, captureException, getClient } }
}

function disableRendererSentry(): void {
  setRendererCaptureException(undefined)
  if (!active) return
  try {
    void sentry?.getClient()?.close()
  } catch {
    // ignore — disable path must never throw into settings
  }
  active = false
}

/**
 * Renderer Sentry + React bridge. Events only leave the machine when main
 * has initialized Sentry (DSN + telemetryEnabled). Resolves once the client
 * is live (or at once when telemetry is off), so boot can render behind it.
 */
export async function initRendererSentry(telemetryEnabled: boolean): Promise<void> {
  const gen = ++generation
  const dsn = resolveRendererDsn()
  if (!dsn || !telemetryEnabled) {
    disableRendererSentry()
    return
  }
  if (active) return

  let sdk: Awaited<ReturnType<typeof loadSdk>>
  try {
    sdk = await loadSdk()
  } catch (err) {
    logger.warn('Sentry renderer SDK failed to load — telemetry stays off', {
      scope: 'renderer',
      err
    })
    return
  }
  // Telemetry was switched off, or another init won, while the SDK loaded.
  if (gen !== generation || active) return
  const { api } = sdk
  sentry = api

  sdk.init(
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
    sdk.reactInit
  )

  setRendererCaptureException((err, fields) => {
    api.withScope((scope) => {
      if (fields?.correlationId) scope.setTag('correlationId', String(fields.correlationId))
      if (fields?.code) scope.setTag('code', String(fields.code))
      if (fields?.scope) scope.setTag('scope', String(fields.scope))
      const scrubbed = fields ? sanitizeLogFields(fields as Record<string, unknown>) : undefined
      if (scrubbed) {
        const { err: _e, ...rest } = scrubbed
        scope.setExtras(rest)
      }
      api.captureException(sanitizeErrorForLog(err) ?? { name: 'Error' })
    })
  })
  active = true
}

export function captureRendererException(err: unknown, fields?: LogFields): void {
  const api = sentry
  if (!active || !api) return
  api.withScope((scope) => {
    if (fields?.correlationId) scope.setTag('correlationId', String(fields.correlationId))
    if (fields?.code) scope.setTag('code', String(fields.code))
    if (fields?.scope) scope.setTag('scope', String(fields.scope))
    api.captureException(sanitizeErrorForLog(err) ?? { name: 'Error' })
  })
}
