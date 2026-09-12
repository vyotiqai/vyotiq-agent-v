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

  it('keeps fetching through consecutive exhausted fetches (circuit never opens)', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
    vi.stubGlobal('fetch', fetchMock)
    // No attempt ceiling / circuit trip (cap removed): every call still
    // reaches the fetch layer and surfaces the raw retriable error.
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD + 1; i++) {
      await expect(
        fetchWithRetry('https://down.fetch.test', {}, { maxAttempts: 1 })
      ).rejects.toMatchObject({ code: 'ECONNRESET' })
    }
    expect(fetchMock).toHaveBeenCalledTimes(CIRCUIT_FAILURE_THRESHOLD + 1)
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

  it('surfaces non-retriable errors directly and keeps fetching afterwards', async () => {
    const url = 'https://probe-release-fetch.test'
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Invalid URL'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchWithRetry(url, {}, { maxAttempts: 1 })).rejects.toThrow('Invalid URL')
    // A later call proceeds normally — no half-open probe slot to wait for.
    const res = await fetchWithRetry(url, {})
    expect(res.status).toBe(200)
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

  it('keeps running through repeated host failures (circuit never opens)', async () => {
    const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    const fn = vi.fn(async () => {
      throw err
    })
    const key = circuitKeyHttp('https://down.circuit.test')
    // No circuit trip (cap removed): every call still runs the operation.
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD + 1; i++) {
      await expect(
        runWithNetworkRetry(fn, { maxAttempts: 1, circuitKey: key })
      ).rejects.toMatchObject({ code: 'ECONNRESET' })
    }
    expect(fn).toHaveBeenCalledTimes(CIRCUIT_FAILURE_THRESHOLD + 1)
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

  it('surfaces non-retriable operation errors directly and keeps running afterwards', async () => {
    const key = circuitKeyHttp('https://probe-release-run.test')
    let calls = 0
    await expect(
      runWithNetworkRetry(
        async () => {
          calls += 1
          if (calls === 1) throw new TypeError('bad operation')
          return 'ok'
        },
        { maxAttempts: 1, circuitKey: key }
      )
    ).rejects.toThrow('bad operation')
    // A later call proceeds normally — no half-open probe slot to wait for.
    await expect(
      runWithNetworkRetry(async () => 'ok', { circuitKey: key })
    ).resolves.toBe('ok')
  })
})
