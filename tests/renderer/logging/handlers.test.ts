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

describe('renderer error handlers', () => {
  const previous = getLoggerBackend()
  const fatal = vi.fn()

  beforeEach(() => {
    fatal.mockReset()
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
  })

  it('installs window error and unhandledrejection listeners once', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    installRendererErrorHandlers()
    expect(isRendererErrorHandlersInstalled()).toBe(true)
    installRendererErrorHandlers()
    const errorCalls = addSpy.mock.calls.filter(([type]) => type === 'error')
    const rejectionCalls = addSpy.mock.calls.filter(([type]) => type === 'unhandledrejection')
    expect(errorCalls.length).toBe(1)
    expect(rejectionCalls.length).toBe(1)
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
})
