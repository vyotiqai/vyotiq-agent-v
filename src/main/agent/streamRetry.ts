import { isAbortError } from '../../shared/errors'
import {
  assertCircuitClosed,
  isCircuitOpenError,
  recordCircuitFailure,
  recordCircuitSuccess,
  releaseCircuitProbe
} from './circuitBreaker'
import {
  isRetriableHttpStatus,
  isRetriableNetworkError,
  isRetriableProviderMessage,
  RetriableStreamError
} from './providers/fetchWithRetry'

/**
 * Run-stopping caps removed (user decision): transient stream failures retry
 * forever with capped exponential backoff until the stream recovers or the
 * user stops the run. Only hard errors end the run (auth/billing, invalid
 * request, dead local endpoint, persistence failure).
 */
export const STREAM_RETRY_BASE_MS = 1000
export const STREAM_RETRY_MAX_MS = 8000
/** Slower curve for provider-side wait failures (429/5xx) — they need real cool-down. */
export const STREAM_HTTP_RETRY_BASE_MS = 2000
export const STREAM_HTTP_RETRY_MAX_MS = 30_000

/** @deprecated Use streamRetryBackoffMs(attempt) — kept for tests that import a scalar. */
export const STREAM_RETRY_BACKOFF_MS = STREAM_RETRY_BASE_MS

export { isRetriableNetworkError, isRetriableProviderMessage, RetriableStreamError }

/**
 * User-facing hint for a dead local endpoint. `ECONNREFUSED` against a
 * loopback/private host means the configured local backend (Ollama-style,
 * e.g. `connect ECONNREFUSED 127.0.0.1:11434`) is not running — retrying the
 * connect cannot help (audit M2).
 */
export const LOCAL_ENDPOINT_DOWN_HINT =
  'local endpoint refused the connection — the backend is not running. Start the backend, then retry.'

/** Host part of a `host:port` / `[v6]:port` endpoint string. */
function endpointHost(endpoint: string): string {
  const raw = endpoint.trim().toLowerCase()
  if (!raw) return ''
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']')
    return close === -1 ? raw.slice(1) : raw.slice(1, close)
  }
  // Bare IPv6 with a trailing :port (`::1:11434`): strip it only when the
  // remainder still looks like an IPv6 address.
  if ((raw.match(/:/g) ?? []).length > 1) {
    const stripped = raw.replace(/:\d{1,5}$/, '')
    if (stripped.includes(':') && stripped !== '::') return stripped
    return raw
  }
  const colon = raw.indexOf(':')
  return colon === -1 ? raw : raw.slice(0, colon)
}

/** Loopback, localhost, and private-range hosts (RFC 1918 + IPv6 ULA/link-local). */
function isLocalHost(host: string): boolean {
  if (!host) return false
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return true
  if (/^10\.\d{1,3}(\.\d{1,3}){1,2}$/.test(host)) return true
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host)) return true
  return false
}

/**
 * True when a failure message is `ECONNREFUSED` naming a loopback/private
 * endpoint. A refused remote host is NOT this: a remote refusal can clear on
 * its own, so it keeps the existing retry class.
 */
export function isLocalEndpointDownMessage(message: string): boolean {
  if (!/ECONNREFUSED/i.test(message)) return false
  const endpoint = message.match(/ECONNREFUSED[^\S\n]+(\S+)/i)?.[1] ?? ''
  return isLocalHost(endpointHost(endpoint))
}

/** Decorate a dead-local-endpoint failure message with the user-facing hint. Idempotent. */
export function describeLocalEndpointDown(message: string): string {
  if (
    !isLocalEndpointDownMessage(message) ||
    message.includes(LOCAL_ENDPOINT_DOWN_HINT)
  ) {
    return message
  }
  return `${message} — ${LOCAL_ENDPOINT_DOWN_HINT}`
}

/** True when a thrown error (or its cause chain) is a dead-local-endpoint failure. */
export function isLocalEndpointDownError(err: unknown): boolean {
  let current: unknown = err
  while (typeof current === 'object' && current !== null) {
    const message = (current as { message?: unknown }).message
    if (typeof message === 'string' && isLocalEndpointDownMessage(message)) return true
    current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : undefined
  }
  return false
}

export function isRetriableStreamFailure(err: unknown): boolean {
  return isRetriableNetworkError(err) || err instanceof RetriableStreamError
}

export function shouldRetryProviderStreamError(message: string, _attempt: number): boolean {
  // No attempt ceiling (cap removed): retriable provider messages retry forever.
  return isRetriableProviderMessage(message)
}

/**
 * Messages that mark a status-less in-band stream failure as permanent (auth,
 * billing, bad request). Everything else upstream mid-stream — overloads, rate
 * limits, provider hiccups — is treated as transient.
 */
export function isPermanentInBandStreamMessage(message: string): boolean {
  return /invalid api key|invalid_api_key|authentication|unauthorized|forbidden|permission denied|insufficient (credits|balance|quota)|billing|quota exceeded|model not found|invalid request|invalid_request|does not exist|not allowed|unsupported/i.test(
    message
  )
}

/**
 * Status-aware mid-stream retry. A `PROVIDER_HTTP` failure retries only for
 * transient statuses (429/408/5xx) — auth, billing, and bad-request errors are
 * permanent and must surface to the user immediately.
 */
export function shouldRetryStreamErrorChunk(
  errorCode: string,
  message: string,
  attempt: number,
  httpStatus?: number
): boolean {
  // Dead local endpoint (ECONNREFUSED to loopback/private): the configured
  // local backend (Ollama-style, e.g. 127.0.0.1:11434) is not running —
  // no retry can succeed. Fail fast regardless of error code (audit M2).
  if (isLocalEndpointDownMessage(message)) return false
  if (errorCode === 'CIRCUIT_OPEN') return false
  if (errorCode === 'PROVIDER_NETWORK') {
    // The fetch layer already retried connect failures to exhaustion inside
    // this attempt (5 × ~30s connect budget). Stream-level retries continue
    // indefinitely (fresh fetch budget plus the network-wait backoff) until
    // the network returns or the user stops the run (cap removed).
    return true
  }
  if (errorCode === 'PROVIDER_HTTP') {
    if (httpStatus != null) return isRetriableHttpStatus(httpStatus)
    // Status-less in-band stream errors (OpenRouter error frames, Anthropic
    // `event: error`, Gemini in-band errors) are upstream failures mid-stream.
    // They never matched the connect-error message regex, so a transient
    // overload after several streamed seconds ended the run. Retry them like
    // an equivalent connect-time 5xx unless the message is clearly permanent.
    return !isPermanentInBandStreamMessage(message)
  }
  return shouldRetryProviderStreamError(message, attempt)
}

/** True when a `PROVIDER_HTTP` failure is a transient wait (429/408/5xx), not a permanent request error. */
export function isTransientHttpFailure(errorCode: string, httpStatus?: number): boolean {
  return errorCode === 'PROVIDER_HTTP' && (httpStatus == null || isRetriableHttpStatus(httpStatus))
}

export function shouldRetryThrownStreamError(err: unknown, _attempt?: number): boolean {
  // Dead local endpoint: no-retry class (audit M2) — fail fast like the
  // chunk classification above.
  if (isLocalEndpointDownError(err)) return false
  // No attempt ceiling (cap removed): retriable throws retry forever.
  return !isAbortError(err) && isRetriableStreamFailure(err)
}

/** Full jitter over exponential backoff for attempt N (1-based). */
export function streamRetryBackoffMs(attempt: number): number {
  const capped = Math.min(
    STREAM_RETRY_MAX_MS,
    STREAM_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1)
  )
  return Math.round(capped / 2 + Math.random() * (capped / 2))
}

/** Slow-curve variant for transient HTTP waits: base 2s, cap 30s. */
export function streamHttpRetryBackoffMs(attempt: number): number {
  const capped = Math.min(
    STREAM_HTTP_RETRY_MAX_MS,
    STREAM_HTTP_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1)
  )
  return Math.round(capped / 2 + Math.random() * (capped / 2))
}

/** Pick the backoff curve from the failure class: transient HTTP waits wait longer. */
export function streamRetryBackoffMsFor(errorCode: string, attempt: number): number {
  return errorCode === 'PROVIDER_HTTP'
    ? streamHttpRetryBackoffMs(attempt)
    : streamRetryBackoffMs(attempt)
}

export async function sleepStreamRetryBackoff(
  signal?: AbortSignal,
  attempt = 1,
  ms?: number
): Promise<void> {
  if (process.env.VITEST === 'true') {
    if (signal?.aborted) {
      const err = new Error('Aborted')
      err.name = 'AbortError'
      throw err
    }
    return
  }
  const wait = ms ?? streamRetryBackoffMs(attempt)
  if (signal?.aborted) {
    const err = new Error('Aborted')
    err.name = 'AbortError'
    throw err
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, wait)
    function onAbort(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const err = new Error('Aborted')
      err.name = 'AbortError'
      reject(err)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** `terminal` = attempt ended the whole run (hard error / idle timeout); caller should stop. */
export type StreamAttemptOutcome = 'complete' | 'retry' | 'terminal'

export type StreamAttemptDecision =
  | { action: 'complete' }
  | { action: 'terminal' }
  | { action: 'retry' }
  | { action: 'exhausted'; err?: unknown }
  | { action: 'throw'; err: unknown }

/**
 * Shared attempt classification for Promise + generator stream retry drivers.
 * No attempt ceiling (cap removed): retriable outcomes and throws always
 * retry; only `complete`, `terminal` (hard error), abort, or a non-retriable
 * throw ends the driver.
 */
export function decideStreamAttemptResult(
  result: { ok: true; outcome: StreamAttemptOutcome } | { ok: false; err: unknown }
): StreamAttemptDecision {
  if (result.ok) {
    if (result.outcome === 'complete') return { action: 'complete' }
    if (result.outcome === 'terminal') return { action: 'terminal' }
    return { action: 'retry' }
  }

  const err = result.err
  if (isAbortError(err)) return { action: 'throw', err }
  if (isCircuitOpenError(err)) return { action: 'exhausted', err }
  // Dead local endpoint: fail fast (no stream retries) and attach the
  // user-facing hint to the message before it surfaces.
  if (isLocalEndpointDownError(err)) {
    if (err instanceof Error) err.message = describeLocalEndpointDown(err.message)
    return { action: 'throw', err }
  }
  if (shouldRetryThrownStreamError(err)) return { action: 'retry' }
  return { action: 'throw', err }
}

export type StreamRetryGenResult =
  | { status: 'complete' }
  | { status: 'terminal' }
  | { status: 'exhausted'; err?: unknown }

/**
 * Run a provider stream attempt with shared retry/backoff policy.
 * `runAttempt` returns `retry` for retriable inline stream errors; thrown
 * retriable failures are retried automatically. AbortError is rethrown.
 */
export async function runWithStreamRetry(options: {
  signal?: AbortSignal
  circuitKey?: string
  onAttemptStart: (attempt: number) => void
  onRetriableFailure?: (err: unknown, attempt: number) => void
  runAttempt: (attempt: number) => Promise<StreamAttemptOutcome>
}): Promise<void> {
  if (options.circuitKey) assertCircuitClosed(options.circuitKey)
  for (let attempt = 1; ; attempt++) {
    options.onAttemptStart(attempt)
    let decision: StreamAttemptDecision
    try {
      const outcome = await options.runAttempt(attempt)
      decision = decideStreamAttemptResult({ ok: true, outcome })
    } catch (err) {
      decision = decideStreamAttemptResult({ ok: false, err })
      if (decision.action === 'retry') {
        options.onRetriableFailure?.(err, attempt)
      }
    }

    if (decision.action === 'complete') {
      if (options.circuitKey) recordCircuitSuccess(options.circuitKey)
      return
    }
    if (decision.action === 'terminal') {
      if (options.circuitKey) releaseCircuitProbe(options.circuitKey)
      return
    }
    if (decision.action === 'throw') {
      // Any un-retried throw ends the attempt without a success/failure record.
      // Release the half-open probe regardless of error type — a leaked slot
      // keeps the breaker half-open forever (permanent CIRCUIT_OPEN).
      if (options.circuitKey) {
        releaseCircuitProbe(options.circuitKey)
      }
      throw decision.err
    }
    if (decision.action === 'exhausted') {
      if (options.circuitKey) recordCircuitFailure(options.circuitKey)
      if (isCircuitOpenError(decision.err)) throw decision.err
      throw new RetriableStreamError('Stream retries exhausted')
    }
    // retry — no attempt ceiling (cap removed): sleep on the capped backoff
    // curve and retry until the stream recovers or the run is cancelled.
    try {
      await sleepStreamRetryBackoff(options.signal, attempt)
    } catch (err) {
      if (options.circuitKey && isAbortError(err)) {
        releaseCircuitProbe(options.circuitKey)
      }
      throw err
    }
  }
}

/**
 * Generator-aware stream retry driver for the agent loop.
 * Yields events from attempt start, runAttempt, and waitBeforeRetry.
 * Retriable thrown failures invoke onRetriableFailure then waitBeforeRetry.
 */
export async function* runWithStreamRetryGen<TEvent>(options: {
  circuitKey?: string
  onAttemptStart: (attempt: number) => AsyncGenerator<TEvent, void> | Generator<TEvent, void> | void
  waitBeforeRetry: (attempt: number) => AsyncGenerator<TEvent, void> | Generator<TEvent, void>
  onRetriableFailure?: (err: unknown, attempt: number) => void
  runAttempt: (attempt: number) => AsyncGenerator<TEvent, StreamAttemptOutcome>
}): AsyncGenerator<TEvent, StreamRetryGenResult> {
  if (options.circuitKey) {
    try {
      assertCircuitClosed(options.circuitKey)
    } catch (err) {
      if (isCircuitOpenError(err)) return { status: 'exhausted', err }
      throw err
    }
  }
  for (let attempt = 1; ; attempt++) {
    const started = options.onAttemptStart(attempt)
    if (started) yield* started

    let decision: StreamAttemptDecision
    try {
      const outcome = yield* options.runAttempt(attempt)
      decision = decideStreamAttemptResult({ ok: true, outcome })
    } catch (err) {
      decision = decideStreamAttemptResult({ ok: false, err })
      if (decision.action === 'retry') {
        options.onRetriableFailure?.(err, attempt)
      }
    }

    if (decision.action === 'complete') {
      if (options.circuitKey) recordCircuitSuccess(options.circuitKey)
      return { status: 'complete' }
    }
    if (decision.action === 'terminal') {
      if (options.circuitKey) releaseCircuitProbe(options.circuitKey)
      return { status: 'terminal' }
    }
    if (decision.action === 'throw') {
      // Any un-retried throw ends the attempt without a success/failure record.
      // Release the half-open probe regardless of error type — a leaked slot
      // keeps the breaker half-open forever (permanent CIRCUIT_OPEN).
      if (options.circuitKey) {
        releaseCircuitProbe(options.circuitKey)
      }
      throw decision.err
    }
    if (decision.action === 'exhausted') {
      if (options.circuitKey) recordCircuitFailure(options.circuitKey)
      return { status: 'exhausted', err: decision.err }
    }

    try {
      yield* options.waitBeforeRetry(attempt)
    } catch (err) {
      if (options.circuitKey && isAbortError(err)) {
        releaseCircuitProbe(options.circuitKey)
      }
      throw err
    }
  }
}
