import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { ZodError, z } from 'zod'
import { formatError, AppError, isAbortError } from '@shared/errors'
import { logger, setLoggerBackend, getLoggerBackend } from '@shared/logger'
import { fail } from '@shared/ipc'

/**
 * Mirrors the IPC failFrom helper: validation → warn + fail(), unexpected → error + fail().
 * Keeps the IpcResult pattern (no thrown exceptions across IPC).
 */
function failFrom(
  err: unknown,
  channel: string,
  log: typeof logger
): { ok: false; error: string } {
  const isValidation =
    err instanceof ZodError || (err instanceof AppError && err.code === 'IPC_VALIDATION')
  const message = formatError(err)
  if (isAbortError(err)) {
    log.warn('IPC aborted', { scope: 'ipc', channel, err })
  } else if (isValidation) {
    log.warn('IPC validation failed', {
      scope: 'ipc',
      code: 'IPC_VALIDATION',
      channel,
      err
    })
  } else {
    log.error('IPC handler failed', {
      scope: 'ipc',
      code: 'IPC_HANDLER',
      channel,
      err
    })
  }
  return fail(message)
}

describe('IPC failure logging pattern', () => {
  const previous = getLoggerBackend()
  const warn = vi.fn()
  const error = vi.fn()

  beforeEach(() => {
    warn.mockReset()
    error.mockReset()
    setLoggerBackend({
      log: (level, message, fields) => {
        if (level === 'warn') warn(message, fields)
        if (level === 'error' || level === 'fatal') error(message, fields)
      }
    })
  })

  afterEach(() => {
    setLoggerBackend(previous)
  })

  it('returns fail() and warns on Zod validation errors', () => {
    const schema = z.object({ runId: z.string().min(1) })
    let caught: unknown
    try {
      schema.parse({ runId: '' })
    } catch (err) {
      caught = err
    }
    const result = failFrom(caught, 'chat:cancel', logger)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0)
    expect(warn).toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('returns fail() and errors on unexpected throws', () => {
    const result = failFrom(new Error('disk full'), 'settings:set', logger)
    expect(result).toEqual({ ok: false, error: 'disk full' })
    expect(error).toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('returns fail() and warns on AppError IPC_VALIDATION', () => {
    const result = failFrom(
      new AppError('bad payload', { code: 'IPC_VALIDATION' }),
      'settings:set',
      logger
    )
    expect(result).toEqual({ ok: false, error: 'bad payload' })
    expect(warn).toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('returns fail() and warns on abort without error-level log', () => {
    const result = failFrom(new DOMException('Aborted', 'AbortError'), 'chat:start', logger)
    expect(result.ok).toBe(false)
    expect(warn).toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('scrubs secrets from error messages in fail() path', () => {
    const result = failFrom(
      new Error('upstream rejected sk-abcdefghijklmnop'),
      'secrets:set',
      logger
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('[redacted]')
      expect(result.error).not.toContain('sk-abcdefghijklmnop')
    }
    expect(error).toHaveBeenCalled()
    const fields = error.mock.calls[0][1] as { err?: Record<string, unknown> }
    expect(fields?.err).toBeTruthy()
    expect(JSON.stringify(fields)).not.toContain('sk-abcdefghijklmnop')
  })
})
