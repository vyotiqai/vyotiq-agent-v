import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isTransientProviderHttpBody,
  logProviderFailure,
  resetSoftWarnCooldownsForTests
} from '@main/agent/providers/log'
import { ollamaProvider } from '@main/agent/providers/openai'

vi.mock('@shared/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn()
  }
}))

import { logger } from '@shared/logger'

describe('logProviderFailure', () => {
  afterEach(() => {
    vi.mocked(logger.error).mockClear()
    vi.mocked(logger.warn).mockClear()
  })

  it('logs chat/stream network failures as error', () => {
    logProviderFailure('ollama', 'network', {})
    expect(logger.error).toHaveBeenCalledWith(
      'Provider network failure',
      expect.objectContaining({ provider: 'ollama', kind: 'network' })
    )
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('logs soft catalog network failures as warn with CATALOG_PROBE', () => {
    logProviderFailure('ollama', 'network', {}, { soft: true })
    expect(logger.warn).toHaveBeenCalledWith(
      'Provider network failure',
      expect.objectContaining({
        provider: 'ollama',
        kind: 'network',
        code: 'CATALOG_PROBE'
      })
    )
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('classifies HTTP 402 as PROVIDER_BILLING (matches providerHttpErrorCode)', () => {
    logProviderFailure('openrouter', 'http', { status: 402, message: 'credits' })
    expect(logger.warn).toHaveBeenCalledWith(
      'Provider http failure',
      expect.objectContaining({
        provider: 'openrouter',
        status: 402,
        code: 'PROVIDER_BILLING'
      })
    )
  })

  it('classifies 401/403 as PROVIDER_AUTH', () => {
    logProviderFailure('openai', 'http', { status: 401 })
    expect(logger.warn).toHaveBeenCalledWith(
      'Provider http failure',
      expect.objectContaining({ status: 401, code: 'PROVIDER_AUTH' })
    )
  })

  // AppData 2026-09-29 08:40:58.003 logged this shape at [error] and 1ms later
  // the loop retried and carried on — the frame was dropped mid-stream, not the
  // request failing. Raised only by the SSE error frame read inside an open
  // 200 stream (providers/openai.ts), which has no HTTP status by construction.
  it('does not log a statusless http mid-stream dropped frame as error', () => {
    logProviderFailure('opencode', 'http', {
      model: 'space-bunny-free',
      message: 'Streaming response failed: [api_error] internal server error'
    })
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      'Provider http failure',
      expect.objectContaining({
        provider: 'opencode',
        kind: 'http',
        code: 'PROVIDER_HTTP',
        providerMessage: 'Streaming response failed: [api_error] internal server error'
      })
    )
  })

  it.each([
    'Streaming response failed: [api_error] overloaded_error: server is busy',
    'Stream error: connection reset by peer',
    'upstream connect error: 502 Bad Gateway',
    'internal server error'
  ])('treats statusless http body %j as a degraded frame, not error', (message) => {
    logProviderFailure('opencode', 'http', { message })
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it.each([
    'Streaming response failed: [invalid_request_error] context length exceeded',
    'invalid_api_key: Incorrect API key provided',
    'model_not_found: The model does not exist',
    'connection refused'
  ])('still logs statusless http body %j as error — a retry cannot succeed', (message) => {
    logProviderFailure('opencode', 'http', { message })
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('still logs a statusless http failure with no message as error', () => {
    logProviderFailure('opencode', 'http', {})
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('logs chat/stream 5xx as error even with a transient-looking body', () => {
    logProviderFailure('openrouter', 'http', {
      status: 503,
      message: 'internal server error'
    })
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      'Provider http failure',
      expect.objectContaining({ status: 503, code: 'PROVIDER_HTTP' })
    )
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('logs non-auth 4xx as warn with the scrubbed body', () => {
    logProviderFailure('openrouter', 'http', { status: 429, message: 'quota exceeded' })
    expect(logger.warn).toHaveBeenCalledWith(
      'Provider http failure',
      expect.objectContaining({ status: 429, code: 'PROVIDER_HTTP' })
    )
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('logs an open circuit as warn with CIRCUIT_OPEN', () => {
    logProviderFailure('openrouter', 'circuit', {})
    expect(logger.warn).toHaveBeenCalledWith(
      'Provider circuit failure',
      expect.objectContaining({ kind: 'circuit', code: 'CIRCUIT_OPEN' })
    )
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('logs a dropped/unparseable frame as warn with the frame-dropped text', () => {
    logProviderFailure('sse', 'parse', { bytes: 12 })
    expect(logger.warn).toHaveBeenCalledWith(
      'Provider stream frame dropped (unparseable JSON)',
      expect.objectContaining({ kind: 'parse', code: 'PROVIDER_STREAM', bytes: 12 })
    )
    expect(logger.error).not.toHaveBeenCalled()
  })
})

describe('isTransientProviderHttpBody', () => {
  it('is a pure predicate — true only for transient upstream/transport shapes', () => {
    expect(isTransientProviderHttpBody(undefined)).toBe(false)
    expect(isTransientProviderHttpBody('')).toBe(false)
    expect(isTransientProviderHttpBody('internal server error')).toBe(true)
    expect(isTransientProviderHttpBody('Streaming response failed: [api_error] x')).toBe(
      true
    )
    expect(isTransientProviderHttpBody('rate limit exceeded, retry later')).toBe(true)
    expect(isTransientProviderHttpBody('invalid_api_key')).toBe(false)
    expect(isTransientProviderHttpBody('tool arguments were not valid JSON')).toBe(false)
  })
})

describe('ollama catalog when host is down', () => {
  beforeEach(() => {
    resetSoftWarnCooldownsForTests()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.mocked(logger.error).mockClear()
    vi.mocked(logger.warn).mockClear()
  })

  it('emits one soft CATALOG_PROBE warn after both /v1/models and /api/tags fail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      })
    )

    await expect(
      ollamaProvider.listModels({
        baseUrl: 'http://127.0.0.1:11434',
        signal: AbortSignal.timeout(2000)
      })
    ).rejects.toThrow(/Cannot reach Ollama/i)

    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      'Provider network failure',
      expect.objectContaining({
        provider: 'ollama',
        kind: 'network',
        code: 'CATALOG_PROBE'
      })
    )
  })
})
