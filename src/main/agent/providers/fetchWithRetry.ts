import {
  assertCircuitClosed,
  circuitKeyHttp,
  isCircuitOpenError,
  recordCircuitFailure,
  recordCircuitSuccess,
  releaseCircuitProbe
} from '../circuitBreaker'

export class RetriableStreamError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'RetriableStreamError'
    if (cause !== undefined) {
      ;(this as Error & { cause?: unknown }).cause = cause
    }
  }
}

export function isRetriableProviderMessage(message: string): boolean {
  return /other side closed|ECONNRESET|terminated|socket hang up|fetch failed/i.test(message)
}

export function isRetriableNetworkError(err: unknown): boolean {
  if (isCircuitOpenError(err)) return false
  if (err instanceof DOMException && err.name === 'AbortError') return false
  if (err instanceof Error && err.name === 'AbortError') return false

  const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'])
  let current: unknown = err
  while (current) {
    if (typeof current === 'object' && current !== null) {
      const code = (current as { code?: string }).code
      if (typeof code === 'string' && codes.has(code)) return true
      const message = (current as { message?: string }).message
      if (typeof message === 'string' && isRetriableProviderMessage(message)) return true
    }
    current =
      current instanceof Error
        ? (current as Error & { cause?: unknown }).cause
        : undefined
  }

  if (err instanceof Error && isRetriableProviderMessage(err.message)) return true
  return false
}

/** Chat/stream POSTs share this budget so Responses / Interactions match SSE paths. */
export const CHAT_FETCH_MAX_ATTEMPTS = 5

/** Abort-aware sleep used by fetch retries and tool-level backoff. */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export const HTTP_RETRY_BASE_MS = 250
const MAX_RETRY_AFTER_MS = 30_000
const DEFAULT_FETCH_MAX_ATTEMPTS = 3

/** `Retry-After` is either delta-seconds or an HTTP date. Ignore anything else. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined
  const raw = header.trim()
  if (!raw) return undefined

  if (/^\d+$/.test(raw)) {
    return Math.min(Number(raw) * 1000, MAX_RETRY_AFTER_MS)
  }
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return undefined
  return Math.min(Math.max(0, at - now), MAX_RETRY_AFTER_MS)
}

/** Full jitter over linear backoff so concurrent runs stop retrying in lockstep. */
export function httpRetryBackoffMs(attempt: number): number {
  const ceiling = Math.max(1, attempt) * HTTP_RETRY_BASE_MS
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2))
}

/**
 * Retry a function on transient network errors (and optional extra predicates).
 * Abort during backoff throws AbortError. Used by web_fetch, catalog, and installs.
 */
export async function runWithNetworkRetry<T>(
  fn: () => Promise<T>,
  opts?: {
    signal?: AbortSignal
    maxAttempts?: number
    isRetriable?: (err: unknown) => boolean
    circuitKey?: string
  }
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_FETCH_MAX_ATTEMPTS
  const isRetriable = opts?.isRetriable ?? isRetriableNetworkError
  const circuitKey = opts?.circuitKey
  if (circuitKey) assertCircuitClosed(circuitKey)
  // An already-aborted signal never fires the listener below, so without this
  // guard the request would still be sent (and the half-open probe leaked).
  if (opts?.signal?.aborted) {
    if (circuitKey) releaseCircuitProbe(circuitKey)
    throw new DOMException('Aborted', 'AbortError')
  }
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn()
      if (circuitKey) recordCircuitSuccess(circuitKey)
      return result
    } catch (err) {
      lastError = err
      if (opts?.signal?.aborted) {
        if (circuitKey) releaseCircuitProbe(circuitKey)
        throw err
      }
      if (isCircuitOpenError(err)) {
        if (circuitKey) releaseCircuitProbe(circuitKey)
        throw err
      }
      const retriable = isRetriable(err)
      if (!retriable || attempt >= maxAttempts) {
        // Non-retriable failures (bad URL, programming errors) are not host
        // failures: release the half-open slot instead of leaking it, or the
        // breaker stays half-open forever and bricks the host.
        if (circuitKey) {
          if (retriable) recordCircuitFailure(circuitKey)
          else releaseCircuitProbe(circuitKey)
        }
        throw err
      }
      await sleepAbortable(httpRetryBackoffMs(attempt), opts?.signal)
      if (opts?.signal?.aborted) {
        if (circuitKey) releaseCircuitProbe(circuitKey)
        throw new DOMException('Aborted', 'AbortError')
      }
    }
  }

  throw lastError ?? new Error('retry failed')
}

/**
 * An unread body keeps the socket checked out of the connection pool, so the
 * retry opens a new connection and the old one lingers until the server times
 * it out.
 */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Body already consumed or the connection is gone; nothing to release.
  }
}

/**
 * HTTP statuses worth another attempt. Shared with the stream-retry layer so a
 * mid-stream failure is classified by the same rule as the connect layer.
 * 408 Request Timeout joins 429/5xx — both are transient provider-side waits.
 */
export function isRetriableHttpStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408
}

/**
 * Abort the attempt if response headers have not arrived within this window —
 * a hung TLS/DNS/connect otherwise stalls the run until the user cancels.
 * The timer stops the moment headers arrive; body streaming is never cut.
 */
export const CONNECT_TIMEOUT_MS = 30_000

/** Connect timeout turned into a retriable network error (code matches ETIMEDOUT). */
function connectTimeoutError(ms: number): Error {
  const err = new Error(`Connect timed out waiting for response headers after ${ms}ms`)
  ;(err as Error & { code?: string }).code = 'ETIMEDOUT'
  return err
}

function isAbortLikeError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  )
}

/** Race the caller signal against a per-attempt connect deadline without Node-version assumptions. */
function connectDeadlineSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; dispose: () => void; fired: boolean } {
  const controller = new AbortController()
  let done = false
  let fired = false
  const onCallerAbort = (): void => {
    done = true
    clearTimeout(timer)
    controller.abort(callerSignal?.reason)
  }
  const timer = setTimeout(() => {
    done = true
    fired = true
    callerSignal?.removeEventListener('abort', onCallerAbort)
    controller.abort(connectTimeoutError(timeoutMs))
  }, timeoutMs)
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  function dispose(): void {
    if (done) return
    done = true
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', onCallerAbort)
  }
  return { signal: controller.signal, dispose, get fired(): boolean { return fired } }
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit & { signal?: AbortSignal },
  opts?: { maxAttempts?: number; circuitKey?: string | false; connectTimeoutMs?: number }
): Promise<Response> {
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_FETCH_MAX_ATTEMPTS
  const connectTimeoutMs = opts?.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
  const circuitKey = opts?.circuitKey === false ? undefined : (opts?.circuitKey ?? circuitKeyHttp(url))
  if (circuitKey) assertCircuitClosed(circuitKey)
  // An already-aborted signal never fires the listener registered per attempt,
  // so without this guard the POST would still be sent (and the half-open probe
  // leaked) before the abort surfaced as a connect timeout instead of AbortError.
  if (init.signal?.aborted) {
    if (circuitKey) releaseCircuitProbe(circuitKey)
    throw new DOMException('Aborted', 'AbortError')
  }
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const deadline = connectDeadlineSignal(init.signal, connectTimeoutMs)
    try {
      const response = await fetch(url, { ...init, signal: deadline.signal })
      // Headers arrived — stop the connect deadline; the body streams on freely.
      deadline.dispose()
      if (isRetriableHttpStatus(response.status) && attempt < maxAttempts) {
        const retryAfter = retryAfterMs(response.headers?.get('retry-after') ?? null)
        await discardBody(response)
        await sleepAbortable(retryAfter ?? httpRetryBackoffMs(attempt), init.signal)
        if (init.signal?.aborted) {
          if (circuitKey) releaseCircuitProbe(circuitKey)
          throw new DOMException('Aborted', 'AbortError')
        }
        continue
      }
      if (circuitKey) {
        if (isRetriableHttpStatus(response.status)) recordCircuitFailure(circuitKey)
        else recordCircuitSuccess(circuitKey)
      }
      return response
    } catch (err) {
      deadline.dispose()
      // The deadline aborted the fetch but the runtime surfaced a bare AbortError
      // instead of our reason — normalize so the retry layer treats it as transient.
      const timeoutErr = deadline.fired && isAbortLikeError(err) ? connectTimeoutError(connectTimeoutMs) : err
      lastError = timeoutErr
      if (init.signal?.aborted) {
        if (circuitKey) releaseCircuitProbe(circuitKey)
        throw err
      }
      if (isCircuitOpenError(timeoutErr)) {
        if (circuitKey) releaseCircuitProbe(circuitKey)
        throw timeoutErr
      }
      const retriable = isRetriableNetworkError(timeoutErr)
      if (!retriable || attempt >= maxAttempts) {
        // Non-retriable failures (bad URL, programming errors) are not host
        // failures: release the half-open slot instead of leaking it, or the
        // breaker stays half-open forever and bricks the host.
        if (circuitKey) {
          if (retriable) recordCircuitFailure(circuitKey)
          else releaseCircuitProbe(circuitKey)
        }
        throw timeoutErr
      }
      await sleepAbortable(httpRetryBackoffMs(attempt), init.signal)
      if (init.signal?.aborted) {
        if (circuitKey) releaseCircuitProbe(circuitKey)
        throw new DOMException('Aborted', 'AbortError')
      }
    }
  }

  throw lastError ?? new Error('fetch failed')
}
