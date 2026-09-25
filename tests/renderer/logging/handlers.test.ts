/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { logger, setLoggerBackend, getLoggerBackend } from '@shared/logger'
import {
  installRendererErrorHandlers,
  isRendererErrorHandlersInstalled,
  reportUncaughtRendererError
} from '@renderer/logging/handlers'
import { resetErrorLogRateLimiter } from '@renderer/logging/errorLogRateLimiter'
import {
  resetStaleChunkReloadFlagForTests,
  STALE_CHUNK_RELOAD_DELAYS_MS
} from '@renderer/lib/staleChunk'

describe('renderer error handlers', () => {
  const previous = getLoggerBackend()
  const fatal = vi.fn()
  const reload = vi.fn()

  beforeEach(() => {
    fatal.mockReset()
    reload.mockReset()
    resetStaleChunkReloadFlagForTests()
    Object.defineProperty(window, 'location', {
      value: { reload },
      configurable: true,
      writable: true
    })
    // The rate limiter keeps module-level state; tests 4 and 5 intentionally
    // share an error signature, so clear it or the second one is suppressed.
    resetErrorLogRateLimiter()
    setLoggerBackend({
      log: (level, message, fields) => {
        if (level === 'fatal') fatal(message, fields)
      }
    })
  })

  afterEach(() => {
    setLoggerBackend(previous)
    vi.useRealTimers()
  })

  it('installs window error, rejection and preload listeners once', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    installRendererErrorHandlers()
    expect(isRendererErrorHandlersInstalled()).toBe(true)
    installRendererErrorHandlers()
    const errorCalls = addSpy.mock.calls.filter(([type]) => type === 'error')
    const rejectionCalls = addSpy.mock.calls.filter(([type]) => type === 'unhandledrejection')
    const preloadCalls = addSpy.mock.calls.filter(([type]) => type === 'vite:preloadError')
    expect(errorCalls.length).toBe(1)
    expect(rejectionCalls.length).toBe(1)
    expect(preloadCalls.length).toBe(1)
    addSpy.mockRestore()
  })

  it('logs uncaught errors via logger.fatal', () => {
    installRendererErrorHandlers()
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'boom',
        filename: 'app.js',
        lineno: 1,
        colno: 1,
        error: new Error('boom')
      })
    )
    expect(fatal).toHaveBeenCalledWith(
      expect.stringMatching(/^Uncaught renderer error:/),
      expect.objectContaining({ scope: 'renderer', code: 'UNCAUGHT' })
    )
  })

  it('logs unhandled rejections via logger.fatal', async () => {
    installRendererErrorHandlers()
    const event = new Event('unhandledrejection') as PromiseRejectionEvent
    Object.defineProperty(event, 'reason', { value: new Error('reject') })
    window.dispatchEvent(event)
    expect(fatal).toHaveBeenCalledWith(
      expect.stringMatching(/^Unhandled renderer rejection:/),
      expect.objectContaining({ scope: 'renderer', code: 'UNCAUGHT' })
    )
  })

  it('tags React #185 rejections as REACT_185 and keeps componentStack', () => {
    installRendererErrorHandlers()
    const reason = Object.assign(
      new Error(
        'Minified React error #185; visit https://react.dev/errors/185 for the full message'
      ),
      { componentStack: '\n    at MessageList\n    at ChatView' }
    )
    const event = new Event('unhandledrejection') as PromiseRejectionEvent
    Object.defineProperty(event, 'reason', { value: reason })
    window.dispatchEvent(event)
    expect(fatal).toHaveBeenCalledWith(
      expect.stringMatching(/^React maximum update depth \(#185\):/),
      expect.objectContaining({
        scope: 'renderer',
        code: 'REACT_185',
        componentStack: expect.stringContaining('MessageList')
      })
    )
  })

  it('reports React root uncaught errors with the production component stack', () => {
    installRendererErrorHandlers()
    reportUncaughtRendererError(
      new Error(
        'Minified React error #185; visit https://react.dev/errors/185 for the full message'
      ),
      '\n    at LoopingComponent\n    at App'
    )
    expect(fatal).toHaveBeenCalledWith(
      expect.stringMatching(/^React maximum update depth \(#185\):/),
      expect.objectContaining({
        scope: 'renderer',
        code: 'REACT_185',
        componentStack: expect.stringContaining('LoopingComponent')
      })
    )
  })

  it('recovers from a stale chunk instead of reporting a crash', () => {
    vi.useFakeTimers()
    installRendererErrorHandlers()
    const event = new Event('unhandledrejection') as PromiseRejectionEvent
    Object.defineProperty(event, 'reason', {
      value: new TypeError(
        'Failed to fetch dynamically imported module: file:///C:/app/out/renderer/assets/FilesPanel-B-tydSMi.js'
      )
    })
    window.dispatchEvent(event)

    // A rebuild is not a crash: logger.fatal feeds crash history and Sentry.
    expect(fatal).not.toHaveBeenCalled()
    vi.advanceTimersByTime(STALE_CHUNK_RELOAD_DELAYS_MS[0])
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("acts on Vite's preloadError event without cancelling the rethrow", () => {
    vi.useFakeTimers()
    installRendererErrorHandlers()
    // The CSS shape carries no 'module' wording — the event is the only signal.
    const event = new Event('vite:preloadError', { cancelable: true })
    Object.assign(event, {
      payload: new Error('Unable to preload CSS for /assets/FilesPanel-CtQm2k_x.css')
    })
    window.dispatchEvent(event)

    // Cancelling would resolve the lazy import with `undefined` and trade the
    // failure for an unrecognisable React error.
    expect(event.defaultPrevented).toBe(false)
    expect(fatal).not.toHaveBeenCalled()
    vi.advanceTimersByTime(STALE_CHUNK_RELOAD_DELAYS_MS[0])
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('stays quiet about the fallout while a reload is pending', () => {
    vi.useFakeTimers()
    installRendererErrorHandlers()
    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }))

    // The surface tearing down behind a scheduled reload throws whatever it
    // throws; none of it is a crash, and none of it may schedule a second one.
    const event = new Event('unhandledrejection') as PromiseRejectionEvent
    Object.defineProperty(event, 'reason', {
      value: new Error('Element type is invalid: expected a string but got: undefined')
    })
    window.dispatchEvent(event)

    vi.runAllTimers()
    expect(fatal).not.toHaveBeenCalled()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
