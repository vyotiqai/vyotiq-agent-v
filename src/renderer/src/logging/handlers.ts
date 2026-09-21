import { logger } from '@shared/logger'
import { logErrorSummary } from '@shared/logPolicy'
import { captureRendererException } from './sentry'
import { shouldLogErrorSignature } from './errorLogRateLimiter'
import {
  componentStackFromUnknown,
  errorMessageFromUnknown,
  isReactMaxUpdateDepth
} from './reactMaxUpdateDepth'
import { handleStaleChunkFailure, recoverFromStaleChunk } from '@renderer/lib/staleChunk'

let installed = false

function isBenignScriptError(message: string): boolean {
  return (
    message.includes('ResizeObserver loop') ||
    message.includes('ResizeObserver loop limit exceeded')
  )
}

/** Global renderer error hooks — catches errors outside React's ErrorBoundary. */
export function installRendererErrorHandlers(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  // Vite's preload helper raises this before it rethrows, for a lazy chunk and
  // for its CSS alike — the one signal that does not depend on matching a
  // Chromium error string. Start recovery here but leave the event uncancelled:
  // cancelling makes the helper resolve the import with `undefined`, and React
  // then raises an unrecognisable "Element type is invalid" in place of the
  // failure we started from. Letting it through costs nothing — the paths below
  // see the reload is already pending and stay quiet.
  window.addEventListener('vite:preloadError', () => {
    recoverFromStaleChunk()
  })

  window.addEventListener('error', (event) => {
    const rawMessage = event.message || ''
    if (isBenignScriptError(rawMessage)) return
    const err = event.error ?? new Error(rawMessage || 'Unknown error')
    if (handleStaleChunkFailure(err) !== 'not-stale') return
    reportRendererFatal(
      err,
      rawMessage,
      componentStackFromUnknown(event.error),
      'Uncaught renderer error'
    )
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    // A rebuild replaced out/ under the running window. Recovery logs its own
    // record; either way this is not a crash and must not be reported as one.
    if (handleStaleChunkFailure(reason) !== 'not-stale') return
    const err = reason instanceof Error ? reason : new Error(String(reason))
    const message = errorMessageFromUnknown(reason) || err.message
    reportRendererFatal(
      err,
      message,
      componentStackFromUnknown(reason),
      'Unhandled renderer rejection'
    )
  })
}

function reportRendererFatal(
  err: Error,
  rawMessage: string,
  componentStack: string | null | undefined,
  prefix: 'Uncaught renderer error' | 'Unhandled renderer rejection'
): void {
  const is185 = isReactMaxUpdateDepth(rawMessage) || isReactMaxUpdateDepth(err.message)
  const code = is185 ? 'REACT_185' : 'UNCAUGHT'
  // Throttle per signature — an #185 loop must not flood the main process log
  // bridge (main does per-record formatting + crash-snippet disk I/O).
  const decision = shouldLogErrorSignature(`${code}\u0000${err.message}`)
  if (!decision.log) return
  logger.fatal(
    is185
      ? `React maximum update depth (#185): ${logErrorSummary(err, 'REACT_185')}`
      : `${prefix}: ${logErrorSummary(err, 'UNCAUGHT')}`,
    {
      scope: 'renderer',
      code,
      ...(decision.suppressed > 0 ? { suppressedRepeats: decision.suppressed } : {}),
      componentStack: componentStack?.slice(0, 4000),
      err
    }
  )
  captureRendererException(err, { scope: 'renderer', code })
}

/**
 * React 19 root `onUncaughtError` callback. React calls this instead of
 * window.onerror, and `errorInfo` carries the component stack even in
 * production — the only reliable locator for an #185 loop.
 */
export function reportUncaughtRendererError(
  error: unknown,
  componentStack?: string | null
): void {
  const err = error instanceof Error ? error : new Error(String(error))
  if (handleStaleChunkFailure(error) !== 'not-stale') return
  reportRendererFatal(
    err,
    errorMessageFromUnknown(error) || err.message,
    componentStack,
    'Uncaught renderer error'
  )
}

export function isRendererErrorHandlersInstalled(): boolean {
  return installed
}
