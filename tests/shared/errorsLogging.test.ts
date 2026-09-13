import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import {
  AppError,
  abortError,
  formatError,
  formatToolResultError,
  createCorrelationId,
  isAbortError,
  isExpectedError,
  isExpectedToolError,
  isRetryableTurnFailure,
  observePromise,
  toAppError,
  toLogErr
} from '@shared/errors'
import { scrubString, scrubPath, scrubValue } from '@shared/scrub'
import {
  logErrorSummary,
  sanitizeErrorForLog,
  sanitizeLogFields,
  sanitizeLogMessage,
  scrubSentryEvent
} from '@shared/logPolicy'
import { workspaceIdFromPath } from '@shared/workspaceId'
import { logger, setLoggerBackend, getLoggerBackend } from '@shared/logger'

describe('formatError + AppError', () => {
  it('formats nested cause chains', () => {
    const inner = Object.assign(new Error('ECONNREFUSED'), {
      code: 'ECONNREFUSED',
      address: '127.0.0.1',
      port: 11434
    })
    const outer = new Error('fetch failed', { cause: inner })
    expect(formatError(outer)).toContain('fetch failed')
  })

  it('scrubs secrets in formatError output', () => {
    expect(formatError(new Error('bad sk-abcdefghijklmnop'))).toContain('[redacted]')
    expect(formatError(new Error('bad sk-abcdefghijklmnop'))).not.toContain('sk-abcdefghijklmnop')
  })

  it('keeps path-escape tool results actionable instead of a scrubbed basename', () => {
    const absolute = new Error(
      'Path escapes workspace: C:\\Users\\ajay\\AppData\\Roaming\\vyotiq'
    )
    expect(formatError(absolute)).toBe('Path escapes workspace: vyotiq')
    const toolText = formatToolResultError(absolute)
    expect(toolText).toMatch(/outside the workspace root/i)
    expect(toolText).toMatch(/workspace-relative/i)
    expect(toolText).not.toMatch(/Roaming/i)
    expect(toolText).not.toBe('Path escapes workspace: vyotiq')

    const relative = formatToolResultError(new Error('Path escapes workspace: ../escape.txt'))
    expect(relative).toMatch(/\.\.\/escape\.txt/)
    expect(relative).toMatch(/do not use '\.\.'/)
  })

  it('returns AppError message directly', () => {
    const err = new AppError('bad key', { code: 'PROVIDER_AUTH' })
    expect(formatError(err)).toBe('bad key')
    expect(err.code).toBe('PROVIDER_AUTH')
    expect(err.severity).toBe('error')
  })

  it('formats Zod issues as readable paths', () => {
    let caught: unknown
    try {
      z.object({ runId: z.string().min(1) }).parse({ runId: '' })
    } catch (err) {
      caught = err
    }
    const msg = formatError(caught)
    expect(msg).toContain('runId')
    expect(msg.toLowerCase()).toMatch(/string|least|min|required|empty|too small/)
  })

  it('toAppError wraps unknowns', () => {
    const wrapped = toAppError(new Error('boom'), { code: 'AGENT_LOOP', correlationId: 'abc' })
    expect(wrapped).toBeInstanceOf(AppError)
    expect(wrapped.code).toBe('AGENT_LOOP')
    expect(wrapped.correlationId).toBe('abc')
  })


  it('classifies expected tool exploration errors', () => {
    expect(isExpectedToolError('File not found: src/a.ts')).toBe(true)
    expect(isExpectedToolError('Unsupported Unix command on Windows: "ls".')).toBe(true)
    expect(isExpectedToolError('Command timed out after 60000ms')).toBe(false)
  })

  it('classifies abort-shaped errors including raw Error(Aborted)', () => {
    expect(isAbortError(abortError())).toBe(true)
    expect(isAbortError(new DOMException('Aborted', 'AbortError'))).toBe(true)
    expect(isAbortError(Object.assign(new Error('Aborted'), { name: 'AbortError' }))).toBe(true)
    expect(isAbortError(new Error('Aborted'))).toBe(true)
    expect(isAbortError(new Error('boom'))).toBe(false)
    expect(isAbortError(new Error('fetch failed'))).toBe(false)
    expect(isAbortError(null)).toBe(false)
  })

  it('treats AbortError, Zod, and validation as expected', () => {
    expect(isExpectedError(new DOMException('Aborted', 'AbortError'))).toBe(true)
    expect(isExpectedError(new Error('Aborted'))).toBe(true)
    expect(isExpectedError(new AppError('bad', { code: 'IPC_VALIDATION' }))).toBe(true)
    expect(isExpectedError(new AppError('boom', { code: 'AGENT_LOOP' }))).toBe(false)
    expect(isExpectedError(new AppError('paused', { code: 'CIRCUIT_OPEN' }))).toBe(true)
    try {
      z.string().min(1).parse('')
    } catch (err) {
      expect(isExpectedError(err)).toBe(true)
    }
    expect(
      isExpectedError(new AppError('cancelled', { code: 'AGENT_LOOP', cause: new DOMException('Aborted', 'AbortError') }))
    ).toBe(true)
  })

  it('createCorrelationId returns a short non-empty id', () => {
    const id = createCorrelationId()
    expect(id.length).toBeGreaterThanOrEqual(8)
    expect(id.length).toBeLessThanOrEqual(32)
  })

  it('toLogErr wraps IPC string errors as expected AppError', () => {
    const err = toLogErr('workspace not found')
    expect(err).toBeInstanceOf(AppError)
    expect(isExpectedError(err)).toBe(true)
    expect(err.message).toBe('workspace not found')
  })

  it('flags retryable turn failures for Continue UX', () => {
    expect(isRetryableTurnFailure({ errorCode: 'CIRCUIT_OPEN' })).toBe(true)
    expect(isRetryableTurnFailure({ incompleteReason: 'circuit_open' })).toBe(true)
    expect(isRetryableTurnFailure({ errorCode: 'PROVIDER_NETWORK' })).toBe(true)
    expect(isRetryableTurnFailure({ errorCode: 'PROVIDER_AUTH' })).toBe(false)
  })

  // 2026-09-01 audit: empty_response/truncated incompletes ended runs with no
  // visible reason (runs 9349708b s129/s150, c9e863c0 s31). They must surface
  // the turn-failure banner like network-class incompletes do.
  it('surfaces empty_response and truncated incompletes for Continue UX', () => {
    expect(isRetryableTurnFailure({ incompleteReason: 'empty_response' })).toBe(true)
    expect(isRetryableTurnFailure({ incompleteReason: 'truncated' })).toBe(true)
    expect(isRetryableTurnFailure({ incompleteReason: 'filtered' })).toBe(false)
    expect(isRetryableTurnFailure({ incompleteReason: 'context_overflow' })).toBe(false)
  })
})

describe('scrubber', () => {
  it('redacts API keys and bearer tokens', () => {
    expect(scrubString('key sk-abc1234567890xyz in text')).toContain('[redacted]')
    expect(scrubString('Authorization: Bearer secret-token-value')).toContain('[redacted]')
    expect(scrubString('X-Api-Key: super-secret-key-value')).toContain('[redacted]')
  })

  it('scrubs Modal proxy tokens in combined wk-…ws-… form', () => {
    expect(scrubString('auth failed for wk-Ab12Cd34.ws-Xy56Zv78')).toBe(
      'auth failed for [redacted]'
    )
    expect(scrubString('Bearer wk-Ab12Cd34.ws-Xy56Zv78')).toContain('[redacted]')
    // Partial forms without the dot-joined secret are not claimed.
    expect(scrubString('endpoint id wk-Ab12Cd34 alone')).not.toContain('[redacted]')
  })

  it('redacts named tokens in text and URL query strings', () => {
    const url = scrubString(
      'GET https://api.example.com/v1?access_token=oauth-secret-value&x=1'
    )
    const bare = scrubString('token=plain-secret-value')
    expect(url).toContain('[redacted]')
    expect(url).not.toContain('oauth-secret-value')
    expect(bare).toContain('[redacted]')
    expect(bare).not.toContain('plain-secret-value')
  })

  it('redacts JWTs and PEM blocks', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepad'
    expect(scrubString(`token ${jwt}`)).toContain('[redacted]')
    expect(scrubString(`token ${jwt}`)).not.toContain('eyJhbGci')
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----'
    expect(scrubString(pem)).toBe('[redacted-pem]')
  })

  it('redacts data URLs', () => {
    const out = scrubString('img data:image/png;base64,AAAA and more')
    expect(out).toContain('data:[redacted]')
    expect(out).not.toContain('AAAA')
  })

  it('scrubs absolute paths to basename', () => {
    expect(scrubPath('C:\\Users\\admin\\proj\\file.ts')).toBe('file.ts')
    expect(scrubPath('/home/admin/proj/file.ts')).toBe('file.ts')
  })

  it('redacts sensitive object keys', () => {
    const scrubbed = scrubValue({
      apiKey: 'sk-secret',
      accessToken: 'tok',
      AccessToken: 'tok-legacy',
      SESSION_TOKEN: 'session',
      dsn: 'https://key@o.ingest.sentry.io/1',
      path: '/Users/admin/ws/a.ts',
      ok: true
    }) as Record<string, unknown>
    expect(scrubbed.apiKey).toBe('[redacted]')
    expect(scrubbed.accessToken).toBe('[redacted]')
    expect(scrubbed.AccessToken).toBe('[redacted]')
    expect(scrubbed.SESSION_TOKEN).toBe('[redacted]')
    expect(scrubbed.dsn).toBe('[redacted]')
    expect(scrubbed.path).toBe('a.ts')
    expect(scrubbed.ok).toBe(true)
  })

  it('preserves Error message/name when scrubbing LogFields.err', () => {
    const err = new AppError('failed with sk-abcdefghijklmnop', {
      code: 'PROVIDER_HTTP',
      context: { apiKey: 'secret' }
    })
    const scrubbed = scrubValue({ err, scope: 'ipc' }) as {
      err: Record<string, unknown>
      scope: string
    }
    expect(scrubbed.scope).toBe('ipc')
    expect(scrubbed.err.name).toBe('AppError')
    expect(String(scrubbed.err.message)).toContain('[redacted]')
    expect(String(scrubbed.err.message)).not.toContain('sk-abcdefghijklmnop')
    expect(scrubbed.err.code).toBe('PROVIDER_HTTP')
    expect((scrubbed.err.context as Record<string, unknown>).apiKey).toBe('[redacted]')
  })

  it('does not leave global regex lastIndex sticky across calls', () => {
    const sample = 'sk-abc1234567890xyz'
    expect(scrubString(sample)).toContain('[redacted]')
    expect(scrubString(sample)).toContain('[redacted]')
  })
})

describe('log policy (no user workspace data)', () => {
  it('drops forbidden structured fields', () => {
    const out = sanitizeLogFields({
      scope: 'agent',
      workspacePath: 'C:\\Users\\me\\secret-project',
      summary: 'read src/payroll.ts',
      query: 'password',
      tool: 'read',
      correlationId: 'abc123'
    }) as Record<string, unknown>
    expect(out.workspacePath).toBeUndefined()
    expect(out.summary).toBeUndefined()
    expect(out.query).toBeUndefined()
    expect(out.tool).toBe('read')
    expect(out.correlationId).toBe('abc123')
  })

  it('keeps scrubbed providerMessage for HTTP diagnostics', () => {
    const out = sanitizeLogFields({
      scope: 'provider',
      code: 'PROVIDER_HTTP',
      provider: 'openrouter',
      status: 400,
      kind: 'http',
      model: 'openai/gpt-5.6-luna-pro',
      providerMessage: 'Invalid model id',
      message: 'should be stripped'
    }) as Record<string, unknown>
    expect(out.providerMessage).toBe('Invalid model id')
    expect(out.model).toBe('openai/gpt-5.6-luna-pro')
    expect(out.message).toBeUndefined()
  })

  it('keeps stopReason and argsKeys diag keys', () => {
    const out = sanitizeLogFields({
      scope: 'agent',
      code: 'AGENT_LOOP',
      tool: 'terminal',
      stopReason: 'empty_response',
      argsKeys: 'command,block_until_ms',
      secretPath: '/Users/me/secret'
    }) as Record<string, unknown>
    expect(out.stopReason).toBe('empty_response')
    expect(out.argsKeys).toBe('command,block_until_ms')
    expect(out.secretPath).toBeUndefined()
  })

  it('sanitizes error objects to taxonomy only', () => {
    const err = new AppError('File not found: C:\\Users\\me\\payroll.xlsx', {
      code: 'TOOL_EXEC',
      context: { path: 'payroll.xlsx' }
    })
    const out = sanitizeErrorForLog(err) as Record<string, unknown>
    expect(out.code).toBe('TOOL_EXEC')
    expect(out.message).toBeUndefined()
    expect(out.context).toBeUndefined()
  })

  it('preserves scrubbed message for string errors (not fake IPC_CLIENT)', () => {
    const out = sanitizeErrorForLog('spawn uvx ENOENT') as Record<string, unknown>
    expect(out.code).toBeUndefined()
    expect(out.message).toContain('ENOENT')
    expect(String(out.message)).not.toContain('IPC_CLIENT')
  })

  it('keeps path-bearing error messages with paths scrubbed, not dropped', () => {
    // Verbatim shape of the 2026-08-31 renderer crashes: a failed dynamic
    // import after a rebuild carries its file:// URL in message text. The
    // old drop-left-only-name behavior made the log say just "TypeError".
    // PATH_IN_TEXT replaces from the drive-letter to the end of the URL, so
    // the file name is not separately asserted.
    const err = new TypeError(
      'Failed to fetch dynamically imported module: file:///C:/Users/me/app/out/renderer/assets/chunk-abc.js'
    )
    const out = sanitizeErrorForLog(err) as Record<string, unknown>
    expect(out.name).toBe('TypeError')
    expect(typeof out.message).toBe('string')
    expect(String(out.message)).toContain('Failed to fetch dynamically imported module')
    expect(String(out.message)).not.toContain('C:/Users')
    expect(String(out.message)).not.toContain('me/app')
  })

  it('logErrorSummary keeps scrubbed text for path-bearing messages', () => {
    // Established scrubPath semantics: directory structure is removed, the
    // basename survives (scrubPath('C:\\u\\a\\f.ts') → 'f.ts'). The message
    // text itself is retained instead of being dropped.
    const summary = logErrorSummary(
      new TypeError('Cannot read settings of file:///C:/Users/me/ws/config.json')
    )
    expect(summary).toContain('Cannot read settings of')
    expect(summary).not.toContain('C:/Users')
    expect(summary).not.toContain('me/ws')
  })

  it('redacts OpenAI masked API key echoes in providerMessage', () => {
    const out = sanitizeLogFields({
      scope: 'provider',
      providerMessage:
        'Incorrect API key provided: 0e2be96e*********************************************ftCM.'
    }) as Record<string, unknown>
    expect(String(out.providerMessage)).toContain('[redacted]')
    expect(String(out.providerMessage)).not.toContain('0e2be96e')
    expect(String(out.providerMessage)).not.toContain('ftCM')
  })

  it('redacts user paths and file names from log messages', () => {
    const msg = sanitizeLogMessage('File not found: C:\\Users\\me\\src\\auth.ts')
    expect(msg).not.toContain('auth.ts')
    expect(msg).not.toContain('Users')
    expect(msg).toContain('[redacted]')
  })

  it('logErrorSummary avoids workspace-derived error text', () => {
    const summary = logErrorSummary(new Error('File not found: C:\\secret\\keys.env'), 'TOOL_EXEC')
    expect(summary).not.toContain('keys.env')
    expect(summary).toContain('TOOL_EXEC')
  })

  it('workspaceIdFromPath is stable and opaque', () => {
    const a = workspaceIdFromPath('C:\\proj\\a')
    const b = workspaceIdFromPath('C:\\proj\\a')
    const c = workspaceIdFromPath('C:\\proj\\b')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('scrubSentryEvent removes exception text and path-like stack frames', () => {
    const event = scrubSentryEvent({
      message: 'File not found: C:\\Users\\me\\secret.ts',
      exception: {
        values: [
          {
            value: 'sensitive provider body',
            stacktrace: {
              frames: [{ filename: 'C:\\Users\\me\\proj\\auth.ts', abs_path: 'C:\\Users\\me\\proj\\auth.ts' }]
            }
          }
        ]
      }
    }) as {
      message?: string
      exception?: { values?: Array<{ value?: string; stacktrace?: { frames?: Array<{ filename?: string; abs_path?: string }> } }> }
    }
    expect(event.message).toContain('[redacted]')
    expect(event.exception?.values?.[0]?.value).toBeUndefined()
    expect(event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename).toBe('[path]/auth.ts')
    expect(event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.abs_path).toBeUndefined()
  })
})

describe('logger facade', () => {
  const previous = getLoggerBackend()

  beforeEach(() => {
    setLoggerBackend({
      log: () => undefined
      // no captureException — Sentry disabled
    })
  })

  afterEach(() => {
    setLoggerBackend(previous)
  })

  it('does not throw when Sentry capture is absent', () => {
    expect(() => {
      logger.debug('d')
      logger.info('i')
      logger.warn('w')
      logger.error('e', { err: new Error('x'), scope: 'test' })
      logger.fatal('f', { err: new Error('y') })
      logger.exception(new AppError('z', { code: 'UNCAUGHT' }))
    }).not.toThrow()
  })

  it('invokes captureException for unexpected errors when provided', () => {
    const capture = vi.fn()
    setLoggerBackend({
      log: () => undefined,
      captureException: capture
    })
    logger.exception(new AppError('boom', { code: 'AGENT_LOOP' }))
    expect(capture).toHaveBeenCalled()
  })

  it('does not capture expected validation errors', () => {
    const capture = vi.fn()
    setLoggerBackend({
      log: () => undefined,
      captureException: capture
    })
    logger.exception(new AppError('bad', { code: 'IPC_VALIDATION' }))
    expect(capture).not.toHaveBeenCalled()
  })

  it('does not capture ZodError via logger.error', () => {
    const capture = vi.fn()
    const log = vi.fn()
    setLoggerBackend({ log, captureException: capture })
    let zodErr: unknown
    try {
      z.string().min(1).parse('')
    } catch (err) {
      zodErr = err
    }
    logger.error('validation', { err: zodErr })
    expect(capture).not.toHaveBeenCalled()
  })

  it('scrubs secrets in messages before backend.log', () => {
    const log = vi.fn()
    setLoggerBackend({ log })
    logger.info('using sk-abcdefghijklmnop now')
    expect(log).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('[redacted]'),
      undefined
    )
    expect(String(log.mock.calls[0][1])).not.toContain('sk-abcdefghijklmnop')
  })

  it('captures fatal without err when backend supports it', () => {
    const capture = vi.fn()
    setLoggerBackend({
      log: () => undefined,
      captureException: capture
    })
    logger.fatal('disk full')
    expect(capture).toHaveBeenCalledWith({ name: 'Error', message: 'disk full' }, undefined)
  })

  it('does not throw when the backend log throws', () => {
    setLoggerBackend({
      log: () => {
        throw new Error('backend down')
      }
    })
    expect(() => logger.info('still safe')).not.toThrow()
  })
})

describe('observePromise', () => {
  it('keeps a parallel rejection awaitable without unhandledRejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      let rejectDone!: (err: Error) => void
      const done = new Promise<void>((_, reject) => {
        rejectDone = reject
      })
      observePromise(done)
      const load = observePromise(Promise.reject(new Error('ERR_CONNECTION_REFUSED')))
      queueMicrotask(() => rejectDone(new Error('ERR_CONNECTION_REFUSED')))
      await expect(load).rejects.toThrow('ERR_CONNECTION_REFUSED')
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(unhandled).toEqual([])
      await expect(done).rejects.toThrow('ERR_CONNECTION_REFUSED')
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
