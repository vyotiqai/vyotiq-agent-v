import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logProviderFailure, resetSoftWarnCooldownsForTests } from '@main/agent/providers/log'
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
