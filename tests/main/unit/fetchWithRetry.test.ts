import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHAT_FETCH_MAX_ATTEMPTS,
  fetchWithRetry,
  httpRetryBackoffMs,
  HTTP_RETRY_BASE_MS,
  isRetriableNetworkError,
  isRetriableProviderMessage,
  retryAfterMs,
  RetriableStreamError,
  runWithNetworkRetry
} from '@main/agent/providers/fetchWithRetry'
import {
  CIRCUIT_FAILURE_THRESHOLD,
  CircuitOpenError,
  circuitKeyHttp,
  resetCircuitBreakersForTests,
  setCircuitNowForTests
} from '@main/agent/circuitBreaker'

describe('isRetriableNetworkError', () => {
  it('detects ECONNRESET on cause chain', () => {
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    const err = new TypeError('terminated', { cause })
    expect(isRetriableNetworkError(err)).toBe(true)
  })

  it('detects other side closed message', () => {
    expect(isRetriableNetworkError(new Error('fetch failed: other side closed'))).toBe(true)
  })

  it('rejects abort errors', () => {
    expect(isRetriableNetworkError(new DOMException('Aborted', 'AbortError'))).toBe(false)
  })

  it('rejects circuit-open errors', () => {
    expect(isRetriableNetworkError(new CircuitOpenError('http:down.test', 1000))).toBe(false)
  })
})

describe('isRetriableProviderMessage', () => {
  it('matches transient provider disconnect phrases', () => {
    expect(isRetriableProviderMessage('fetch failed: other side closed')).toBe(true)
    expect(isRetriableProviderMessage('read ECONNRESET')).toBe(true)
    expect(isRetriableProviderMessage('HTTP 401: unauthorized')).toBe(false)
  })
})

describe('RetriableStreamError', () => {
  it('wraps stream read failures', () => {
    const inner = new Error('read ECONNRESET')
    const err = new RetriableStreamError('stream ended', inner)
    expect(err.name).toBe('RetriableStreamError')
    expect(err.cause).toBe(inner)
  })
})

describe('retryAfterMs', () => {
  it('reads delta-seconds', () => {
    expect(retryAfterMs('2')).toBe(2000)
  })

  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(retryAfterMs('Thu, 01 Jan 2026 00:00:05 GMT', now)).toBe(5000)
  })

  it('clamps a far-future date to the cap', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(retryAfterMs('Thu, 01 Jan 2027 00:00:00 GMT', now)).toBe(30_000)
  })

  it('ignores missing or unparseable values', () => {
    expect(retryAfterMs(null)).toBeUndefined()
    expect(retryAfterMs('soon')).toBeUndefined()
  })
})

describe('fetchWithRetry', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('exports the shared chat fetch attempt budget', () => {
    expect(CHAT_FETCH_MAX_ATTEMPTS).toBe(5)
  })

  function response(status: number, headers: Record<string, string> = {}): Response {
    return new Response(status === 204 ? null : 'body', { status, headers })
  }

  it('drains the body of a retried 5xx so the connection is released', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const failing = response(503)
    Object.defineProperty(failing, 'body', { value: { cancel } })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failing)
      .mockResolvedValueOnce(response(200))
    vi.stubGlobal('fetch', fetchMock)

    const res = await fetchWithRetry('https://example.test', {})

    expect(res.status).toBe(200)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('waits for Retry-After on a 429 instead of the default backoff', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(429, { 'retry-after': '1' }))
      .mockResolvedValueOnce(response(200))
    vi.stubGlobal('fetch', fetchMock)

    const started = Date.now()
    const res = await fetchWithRetry('https://example.test', {})

    expect(res.status).toBe(200)
    // The default jittered backoff for attempt 1 tops out at 250ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  })

  it('stops retrying once the caller aborts', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn().mockImplementation(async () => {
      controller.abort()
      return response(503)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      fetchWithRetry('https://example.test', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws AbortError when aborted during network retry backoff', async () => {
    const controller = new AbortController()
    const fetchMock = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }))
    vi.stubGlobal('fetch', fetchMock)

    const pending = fetchWithRetry('https://example.test', { signal: controller.signal })
    await Promise.resolve()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('fail-fasts once consecutive exhausted fetches open the host circuit', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
    vi.stubGlobal('fetch', fetchMock)
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      await expect(
        fetchWithRetry('https://down.fetch.test', {}, { maxAttempts: 1 })
      ).rejects.toMatchObject({ code: 'ECONNRESET' })
    }
    fetchMock.mockClear()
    await expect(
      fetchWithRetry('https://down.fetch.test', {}, { maxAttempts: 3 })
    ).rejects.toBeInstanceOf(CircuitOpenError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never sends an already-aborted request', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      fetchWithRetry('https://pre-abort.test', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('releases the half-open probe when a non-retriable error fails the attempt', async () => {
    const url = 'https://probe-release-fetch.test'
    let now = Date.now()
    setCircuitNowForTests(() => now)
    try {
      const fetchMock = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      vi.stubGlobal('fetch', fetchMock)
      for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
        await expect(
          fetchWithRetry(url, {}, { maxAttempts: 1 })
        ).rejects.toMatchObject({ code: 'ECONNRESET' })
      }

      // Open window elapsed: this call is the half-open probe, and it fails
      // with a non-retriable error (bad URL). The probe slot must be released.
      now += 60_001
      fetchMock.mockRejectedValueOnce(new TypeError('Invalid URL'))
      await expect(fetchWithRetry(url, {}, { maxAttempts: 1 })).rejects.toThrow('Invalid URL')

      // A later call can probe again and close the breaker on success.
      now += 60_001
      fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }))
      const res = await fetchWithRetry(url, {})
      expect(res.status).toBe(200)
    } finally {
      resetCircuitBreakersForTests()
    }
  })
})

describe('httpRetryBackoffMs', () => {
  it('stays inside the full-jitter window for attempt 1', () => {
    for (let i = 0; i < 30; i++) {
      const ms = httpRetryBackoffMs(1)
      expect(ms).toBeGreaterThanOrEqual(HTTP_RETRY_BASE_MS / 2)
      expect(ms).toBeLessThanOrEqual(HTTP_RETRY_BASE_MS)
    }
  })
})

describe('runWithNetworkRetry', () => {
  it('retries a thrown network error then succeeds', async () => {
    vi.useFakeTimers()
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
        .mockResolvedValueOnce('ok')
      const pending = runWithNetworkRetry(fn)
      await vi.runAllTimersAsync()
      await expect(pending).resolves.toBe('ok')
      expect(fn).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry AbortError', async () => {
    const fn = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'))
    await expect(runWithNetworkRetry(fn)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('fail-fasts once the host circuit is open', async () => {
    const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    const fn = vi.fn().mockRejectedValue(err)
    const key = circuitKeyHttp('https://down.circuit.test')
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      await expect(
        runWithNetworkRetry(fn, { maxAttempts: 1, circuitKey: key })
      ).rejects.toMatchObject({ code: 'ECONNRESET' })
    }
    fn.mockClear()
    await expect(runWithNetworkRetry(fn, { maxAttempts: 3, circuitKey: key })).rejects.toBeInstanceOf(
      CircuitOpenError
    )
    expect(fn).not.toHaveBeenCalled()
  })

  it('never runs an already-aborted operation', async () => {
    const controller = new AbortController()
    controller.abort()
    const fn = vi.fn()
    await expect(runWithNetworkRetry(fn, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(fn).not.toHaveBeenCalled()
  })

  it('releases the half-open probe when a non-retriable error fails the operation', async () => {
    const key = circuitKeyHttp('https://probe-release-run.test')
    let now = Date.now()
    setCircuitNowForTests(() => now)
    try {
      const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
      for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
        await expect(
          runWithNetworkRetry(
            async () => {
              throw err
            },
            { maxAttempts: 1, circuitKey: key }
          )
        ).rejects.toMatchObject({ code: 'ECONNRESET' })
      }

      now += 60_001
      await expect(
        runWithNetworkRetry(
          async () => {
            throw new TypeError('bad operation')
          },
          { maxAttempts: 1, circuitKey: key }
        )
      ).rejects.toThrow('bad operation')

      now += 60_001
      await expect(runWithNetworkRetry(async () => 'ok', { circuitKey: key })).resolves.toBe('ok')
    } finally {
      resetCircuitBreakersForTests()
    }
  })
})
