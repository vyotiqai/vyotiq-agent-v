import { describe, expect, it, vi } from 'vitest'
import { RetriableStreamError } from '@main/agent/providers/fetchWithRetry'
import {
  CircuitOpenError,
  recordCircuitFailure,
  resetCircuitBreakersForTests,
  CIRCUIT_FAILURE_THRESHOLD
} from '@main/agent/circuitBreaker'
import {
  LOCAL_ENDPOINT_DOWN_HINT,
  decideStreamAttemptResult,
  describeLocalEndpointDown,
  isLocalEndpointDownError,
  isLocalEndpointDownMessage,
  runWithStreamRetry,
  runWithStreamRetryGen,
  shouldRetryProviderStreamError,
  shouldRetryStreamErrorChunk,
  shouldRetryThrownStreamError,
  sleepStreamRetryBackoff,
  streamRetryBackoffMs,
  streamRetryBackoffMsFor,
  STREAM_HTTP_RETRY_MAX_MS,
  STREAM_RETRY_BASE_MS,
  STREAM_RETRY_MAX_MS
} from '@main/agent/streamRetry'

describe('streamRetry', () => {
  it('exports shared retry constants', () => {
    expect(STREAM_RETRY_BASE_MS).toBe(1000)
    expect(streamRetryBackoffMs(1)).toBeGreaterThanOrEqual(500)
  })

  it('classifies retriable provider and thrown stream errors with no attempt ceiling', () => {
    expect(shouldRetryProviderStreamError('fetch failed: other side closed', 1)).toBe(true)
    expect(shouldRetryProviderStreamError('fetch failed: other side closed', 5)).toBe(true)
    expect(shouldRetryThrownStreamError(new RetriableStreamError('stream ended'), 1)).toBe(true)
    expect(shouldRetryThrownStreamError(new RetriableStreamError('stream ended'), 5)).toBe(true)
    expect(shouldRetryThrownStreamError(new DOMException('Aborted', 'AbortError'), 1)).toBe(false)
  })

  it('retries PROVIDER_NETWORK indefinitely (cap removed)', () => {
    expect(shouldRetryStreamErrorChunk('PROVIDER_NETWORK', 'Connect timed out', 1)).toBe(true)
    expect(shouldRetryStreamErrorChunk('PROVIDER_NETWORK', 'Connect timed out', 5)).toBe(true)
    expect(shouldRetryStreamErrorChunk('CIRCUIT_OPEN', 'Circuit open', 1)).toBe(false)
    expect(shouldRetryStreamErrorChunk('PROVIDER_STREAM', 'fetch failed: other side closed', 1)).toBe(
      true
    )
  })

  it('fails fast on ECONNREFUSED against a local endpoint (no retries)', () => {
    // Production shape (audit M2): Ollama-style local backend refusing connects.
    const dead = 'fetch failed — connect ECONNREFUSED 127.0.0.1:11434'
    expect(shouldRetryStreamErrorChunk('PROVIDER_NETWORK', dead, 1)).toBe(false)
    expect(shouldRetryStreamErrorChunk('PROVIDER_STREAM', dead, 1)).toBe(false)
    // Remote refusal keeps the existing retry semantics.
    expect(
      shouldRetryStreamErrorChunk('PROVIDER_NETWORK', 'connect ECONNREFUSED 93.184.216.34:443', 1)
    ).toBe(true)
    // Loopback/private shapes across the recognized families.
    expect(
      shouldRetryStreamErrorChunk('PROVIDER_NETWORK', 'connect ECONNREFUSED localhost:11434', 1)
    ).toBe(false)
    expect(
      shouldRetryStreamErrorChunk('PROVIDER_NETWORK', 'connect ECONNREFUSED 192.168.1.5:8080', 1)
    ).toBe(false)
    expect(
      shouldRetryStreamErrorChunk('PROVIDER_NETWORK', 'connect ECONNREFUSED [::1]:11434', 1)
    ).toBe(false)
    // Unrelated classes unchanged: transient HTTP and retriable provider messages.
    expect(shouldRetryStreamErrorChunk('PROVIDER_HTTP', 'Rate limited (HTTP 429)', 1, 429)).toBe(true)
    expect(
      shouldRetryStreamErrorChunk('PROVIDER_STREAM', 'fetch failed: other side closed', 1)
    ).toBe(true)
  })

  it('recognizes dead-local-endpoint messages by host family', () => {
    expect(isLocalEndpointDownMessage('connect ECONNREFUSED 127.0.0.1:11434')).toBe(true)
    expect(isLocalEndpointDownMessage('connect ECONNREFUSED localhost:11434')).toBe(true)
    expect(isLocalEndpointDownMessage('connect ECONNREFUSED 10.0.0.3:1234')).toBe(true)
    expect(isLocalEndpointDownMessage('connect ECONNREFUSED 172.20.1.2:1234')).toBe(true)
    expect(isLocalEndpointDownMessage('connect ECONNREFUSED [::1]:80')).toBe(true)
    expect(isLocalEndpointDownMessage('ECONNREFUSED')).toBe(false)
    // Remote host: not a dead local endpoint.
    expect(isLocalEndpointDownMessage('connect ECONNREFUSED api.anthropic.com:443')).toBe(false)
    expect(isLocalEndpointDownMessage('connect ECONNREFUSED 8.8.8.8:53')).toBe(false)
  })

  it('decorates dead-local-endpoint messages with the backend-not-running hint', () => {
    const raw = 'fetch failed — connect ECONNREFUSED 127.0.0.1:11434'
    const described = describeLocalEndpointDown(raw)
    expect(described).toContain(raw)
    expect(described).toContain(LOCAL_ENDPOINT_DOWN_HINT)
    expect(described).toContain('backend is not running')
    // Idempotent — callers may route a message through this more than once.
    expect(describeLocalEndpointDown(described)).toBe(described)
    // Non-local failures pass through untouched.
    expect(describeLocalEndpointDown('socket hang up')).toBe('socket hang up')
  })

  it('classifies dead-local-endpoint throws as no-retry and attaches the hint', () => {
    const dead = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
      code: 'ECONNREFUSED'
    })
    expect(isLocalEndpointDownError(dead)).toBe(true)
    // Same failure wrapped in a cause chain.
    expect(isLocalEndpointDownError(new Error('stream failed', { cause: dead }))).toBe(true)
    // No-retry on every attempt.
    expect(shouldRetryThrownStreamError(dead, 1)).toBe(false)
    // Retry classification unchanged for other connect-class errors.
    const refusedRemote = Object.assign(new Error('connect ECONNREFUSED 93.184.216.34:443'), {
      code: 'ECONNREFUSED'
    })
    expect(shouldRetryThrownStreamError(refusedRemote, 1)).toBe(true)
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    expect(shouldRetryThrownStreamError(reset, 1)).toBe(true)

    // decideStreamAttemptResult fails fast (throw, not retry) and decorates.
    const decision = decideStreamAttemptResult({ ok: false, err: dead }, 1)
    expect(decision).toEqual({ action: 'throw', err: dead })
    expect(dead.message).toContain(LOCAL_ENDPOINT_DOWN_HINT)
  })

  it('retries transient mid-stream HTTP statuses only', () => {
    expect(shouldRetryStreamErrorChunk('PROVIDER_HTTP', 'Rate limited (HTTP 429)', 1, 429)).toBe(true)
    expect(shouldRetryStreamErrorChunk('PROVIDER_HTTP', 'HTTP 503', 4, 503)).toBe(true)
    expect(shouldRetryStreamErrorChunk('PROVIDER_HTTP', 'Overloaded', 5, 529)).toBe(false)
    expect(shouldRetryStreamErrorChunk('PROVIDER_HTTP', 'Authentication failed (HTTP 401)', 1, 401)).toBe(false)
    expect(shouldRetryStreamErrorChunk('PROVIDER_HTTP', 'Insufficient credits', 1, 402)).toBe(false)
    expect(shouldRetryStreamErrorChunk('PROVIDER_HTTP', 'Bad request', 1, 400)).toBe(false)
    expect(shouldRetryStreamErrorChunk('PROVIDER_HTTP', 'Not found', 1, 404)).toBe(false)
    // Without a status, fall back to the message-shape heuristic.
    expect(shouldRetryStreamErrorChunk('PROVIDER_HTTP', 'fetch failed: other side closed', 1)).toBe(true)
    expect(shouldRetryStreamErrorChunk('PROVIDER_HTTP', 'Insufficient credits', 1)).toBe(false)
  })

  it('uses the slower backoff curve for transient HTTP waits', () => {
    const plain = streamRetryBackoffMsFor('PROVIDER_STREAM', 4)
    const http = streamRetryBackoffMsFor('PROVIDER_HTTP', 4)
    // 2^3 * 2s = 16s ceiling vs 8s plain ceiling — jitter keeps both under theirs.
    expect(plain).toBeLessThanOrEqual(STREAM_RETRY_MAX_MS)
    expect(http).toBeLessThanOrEqual(STREAM_HTTP_RETRY_MAX_MS)
  })

  it('retries transient mid-stream HTTP statuses at any attempt (cap removed)', () => {
    expect(shouldRetryStreamErrorChunk('PROVIDER_HTTP', 'Rate limited (HTTP 429)', 1, 429)).toBe(true)
    expect(shouldRetryStreamErrorChunk('PROVIDER_HTTP', 'Rate limited (HTTP 429)', 5, 429)).toBe(true)
  })

  it('retries runAttempt on inline retry', async () => {
    const runAttempt = vi.fn().mockResolvedValueOnce('retry').mockResolvedValueOnce('complete')

    await runWithStreamRetry({
      onAttemptStart: vi.fn(),
      runAttempt
    })

    expect(runAttempt).toHaveBeenCalledTimes(2)
  })

  it('retries thrown retriable stream failures', async () => {
    const onRetriableFailure = vi.fn()
    const runAttempt = vi
      .fn()
      .mockRejectedValueOnce(new RetriableStreamError('stream ended'))
      .mockResolvedValueOnce('complete')

    await runWithStreamRetry({
      onAttemptStart: vi.fn(),
      onRetriableFailure,
      runAttempt
    })

    expect(runAttempt).toHaveBeenCalledTimes(2)
    expect(onRetriableFailure).toHaveBeenCalledTimes(1)
  })

  it('sleepStreamRetryBackoff waits for the shared delay', async () => {
    vi.useFakeTimers()
    const done = sleepStreamRetryBackoff(undefined, 1)
    await vi.advanceTimersByTimeAsync(streamRetryBackoffMs(1))
    await done
    vi.useRealTimers()
  })

  it('sleepStreamRetryBackoff throws when aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(sleepStreamRetryBackoff(controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
  })

  it('keeps retrying retriable failures until the run is cancelled (no exhaustion)', async () => {
    const controller = new AbortController()
    const runAttempt = vi.fn().mockRejectedValue(new RetriableStreamError('stream ended'))
    setTimeout(() => controller.abort(), 1200)
    // No attempt ceiling (cap removed): the loop only exits via abort.
    await expect(
      runWithStreamRetry({
        onAttemptStart: vi.fn(),
        runAttempt,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(runAttempt).toHaveBeenCalled()
  })

  it('runWithStreamRetryGen yields wait events and completes', async () => {
    const events: string[] = []
    const gen = runWithStreamRetryGen({
      onAttemptStart: function* (attempt) {
        if (attempt > 1) yield `reset:${attempt}`
      },
      waitBeforeRetry: function* (attempt) {
        yield `wait:${attempt}`
      },
      runAttempt: async function* (attempt) {
        yield `chunk:${attempt}`
        if (attempt === 1) return 'retry'
        return 'complete'
      }
    })

    let result: unknown
    while (true) {
      const next = await gen.next()
      if (next.done) {
        result = next.value
        break
      }
      events.push(next.value)
    }

    expect(events).toEqual(['chunk:1', 'wait:1', 'reset:2', 'chunk:2'])
    expect(result).toEqual({ status: 'complete' })
  })

  it('runWithStreamRetryGen retries retriable throws until recovery (no exhaustion)', async () => {
    const gen = runWithStreamRetryGen({
      onAttemptStart: () => undefined,
      waitBeforeRetry: function* () {
        yield 'wait'
      },
      runAttempt: async function* (attempt) {
        yield* []
        if (attempt < 3) throw new RetriableStreamError('stream ended')
        return 'complete'
      }
    })

    const events: string[] = []
    let result: unknown
    while (true) {
      const next = await gen.next()
      if (next.done) {
        result = next.value
        break
      }
      events.push(next.value)
    }

    expect(events).toEqual(['wait', 'wait'])
    expect(result).toEqual({ status: 'complete' })
  })

  it('runWithStreamRetryGen returns terminal without further attempts', async () => {
    const gen = runWithStreamRetryGen({
      onAttemptStart: () => undefined,
      waitBeforeRetry: function* () {
        yield 'wait'
      },
      runAttempt: async function* () {
        yield 'err-event'
        return 'terminal'
      }
    })

    const events: string[] = []
    let result: unknown
    while (true) {
      const next = await gen.next()
      if (next.done) {
        result = next.value
        break
      }
      events.push(next.value)
    }

    expect(events).toEqual(['err-event'])
    expect(result).toEqual({ status: 'terminal' })
  })

  it('classifies CircuitOpenError as exhausted without retrying', () => {
    const err = new CircuitOpenError('provider:openai', 60_000)
    expect(decideStreamAttemptResult({ ok: false, err }, 1)).toEqual({ action: 'exhausted', err })
  })

  it('never opens the circuit — failures never block stream attempts', async () => {
    const key = 'provider:circuit-test'
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) recordCircuitFailure(key)
    const runAttempt = vi.fn().mockResolvedValue('complete')
    await runWithStreamRetry({
      circuitKey: key,
      onAttemptStart: vi.fn(),
      runAttempt
    })
    expect(runAttempt).toHaveBeenCalledTimes(1)
  })

  it('releases probe bookkeeping safely when an attempt throws non-retriably', async () => {
    resetCircuitBreakersForTests()
    try {
      const key = 'provider:probe-leak'
      for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) recordCircuitFailure(key)
      await expect(
        runWithStreamRetry({
          circuitKey: key,
          onAttemptStart: vi.fn(),
          runAttempt: vi.fn().mockRejectedValue(new Error('permanent provider bug'))
        })
      ).rejects.toThrow('permanent provider bug')
      // A later call proceeds normally — no half-open probe slot to wait for.
      const runAttempt = vi.fn().mockResolvedValue('complete')
      await runWithStreamRetry({ circuitKey: key, onAttemptStart: vi.fn(), runAttempt })
      expect(runAttempt).toHaveBeenCalledTimes(1)
    } finally {
      resetCircuitBreakersForTests()
    }
  })

  it('runWithStreamRetryGen keeps going after a terminal throw (probe no-op)', async () => {
    resetCircuitBreakersForTests()
    try {
      const key = 'provider:probe-leak-gen'
      for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) recordCircuitFailure(key)
      const gen = runWithStreamRetryGen({
        circuitKey: key,
        onAttemptStart: () => undefined,
        waitBeforeRetry: function* () {
          yield 'wait'
        },
        runAttempt: async function* () {
          yield* []
          throw new Error('permanent provider bug')
        }
      })
      await expect(gen.next()).rejects.toThrow('permanent provider bug')
      const runAttempt = vi.fn().mockResolvedValue('complete')
      await runWithStreamRetry({ circuitKey: key, onAttemptStart: vi.fn(), runAttempt })
      expect(runAttempt).toHaveBeenCalledTimes(1)
    } finally {
      resetCircuitBreakersForTests()
    }
  })
})
