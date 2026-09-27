import { logger } from '../../../shared/logger'
import { formatError, type ErrorCode } from '../../../shared/errors'
import type { ProviderId } from '../../../shared/ipc'
import { isCircuitOpenError } from '../circuitBreaker'
import { isRetriableNetworkError } from './fetchWithRetry'
import { formatProviderHttpError, scrubProviderErrorText } from './httpErrors'
import type { StreamChunk } from './types'

/**
 * Soft (catalog/probe) failures repeat every time settings or the model picker
 * probes a down local host — expected noise, not incidents. Log the first
 * occurrence per provider+kind, then stay quiet for this cooldown window.
 */
const SOFT_WARN_COOLDOWN_MS = 5 * 60_000
const softWarnLastAt = new Map<string, number>()

function softWarnOnCooldown(provider: string, kind: string): boolean {
  const key = `${provider}:${kind}`
  const now = Date.now()
  const last = softWarnLastAt.get(key)
  if (last !== undefined && now - last < SOFT_WARN_COOLDOWN_MS) return true
  softWarnLastAt.set(key, now)
  return false
}

/** @internal Test helper — clear soft-warn cooldown state between cases. */
export function resetSoftWarnCooldownsForTests(): void {
  softWarnLastAt.clear()
}

/** Log provider failures without request bodies, API keys, or full response text. */
export function logProviderFailure(
  provider: string,
  kind: 'http' | 'timeout' | 'stream' | 'network' | 'parse' | 'circuit',
  detail: { status?: number; bytes?: number; message?: string; model?: string },
  opts?: {
    /**
     * Catalog / probe failures (Ollama down, empty live list) — warn, not error.
     * Chat/stream failures stay at error unless already classified as soft above.
     */
    soft?: boolean
  }
): void {
  const status = detail.status
  const isAuth = status === 401 || status === 403
  const isBilling = status === 402
  // Soft catalog probes use a dedicated code so warn filters stay clean.
  const code: ErrorCode = opts?.soft
    ? 'CATALOG_PROBE'
    : isAuth
      ? 'PROVIDER_AUTH'
      : isBilling
        ? 'PROVIDER_BILLING'
        : kind === 'circuit'
          ? 'CIRCUIT_OPEN'
          : kind === 'timeout'
            ? 'PROVIDER_TIMEOUT'
            : kind === 'stream' || kind === 'parse'
              ? 'PROVIDER_STREAM'
              : 'PROVIDER_HTTP'

  const fields = {
    scope: 'provider' as const,
    code,
    provider,
    status,
    kind,
    ...(detail.bytes !== undefined ? { bytes: detail.bytes } : {}),
    ...(detail.model ? { model: detail.model } : {}),
    // Use providerMessage — plain `message` is stripped by the log allowlist.
    ...(detail.message ? { providerMessage: detail.message } : {})
  }

  if (opts?.soft) {
    if (softWarnOnCooldown(provider, kind)) return
    logger.warn(`Provider ${kind} failure`, fields)
    return
  }
  if (kind === 'circuit' || isAuth || isBilling) {
    logger.warn(`Provider ${kind} failure`, fields)
    return
  }
  // A dropped frame degrades one turn; it is not the whole request failing.
  if (kind === 'parse') {
    logger.warn('Provider stream frame dropped (unparseable JSON)', fields)
    return
  }
  // Non-auth 4xx: warn with scrubbed message so operators can diagnose without secrets.
  if (kind === 'http' && status !== undefined && status >= 400 && status < 500) {
    logger.warn(`Provider ${kind} failure`, fields)
    return
  }
  logger.error(`Provider ${kind} failure`, fields)
}

/**
 * Failures raised while building the request, before a byte leaves the
 * machine: a header value fetch refuses (an API key pasted with an invisible
 * character), an unparseable URL, or a redirect we refused to follow. Every
 * retry rebuilds the same request, so they are not network waits. Anything
 * that could be a network failure stays PROVIDER_NETWORK.
 */
const HEADER_CONSTRUCTION_RE = /Cannot convert argument to a ByteString|is an invalid header (?:name|value)/i
const REQUEST_CONSTRUCTION_RE = /Failed to parse URL|Refusing cross-origin redirect/i

function requestConstructionFailure(err: unknown): 'header' | 'request' | null {
  if (isRetriableNetworkError(err)) return null
  let current: unknown = err
  while (current instanceof Error) {
    if (HEADER_CONSTRUCTION_RE.test(current.message)) return 'header'
    if (REQUEST_CONSTRUCTION_RE.test(current.message)) return 'request'
    if ((current as Error & { code?: unknown }).code === 'ERR_INVALID_URL') return 'request'
    current = (current as Error & { cause?: unknown }).cause
  }
  return null
}

/** Shared catch path for fetchWithRetry failures (network vs open circuit vs a request that cannot be built). */
export function providerFetchFailureChunk(provider: string, err: unknown): StreamChunk {
  const circuit = isCircuitOpenError(err)
  const construction = circuit ? null : requestConstructionFailure(err)
  if (construction) {
    logProviderFailure(provider, 'network', { message: construction === 'header' ? 'invalid header' : 'invalid request' })
    return {
      type: 'error',
      // The header message echoes the offending value — the API key itself.
      error:
        construction === 'header'
          ? `${provider}: the API key or a request header contains a character HTTP headers cannot carry (often an invisible character from copy-paste). Re-enter the key in Settings → Providers.`
          : scrubProviderErrorText(formatError(err)),
      errorCode: 'PROVIDER_REQUEST'
    }
  }
  logProviderFailure(provider, circuit ? 'circuit' : 'network', {})
  return {
    type: 'error',
    error: formatError(err),
    errorCode: circuit ? 'CIRCUIT_OPEN' : 'PROVIDER_NETWORK'
  }
}

/** Shared non-OK response path: log the status and surface it as a PROVIDER_HTTP chunk. */
export function providerHttpFailureChunk(
  provider: ProviderId,
  status: number,
  body: string
): StreamChunk {
  logProviderFailure(provider, 'http', { status })
  return {
    type: 'error',
    error: formatProviderHttpError(status, body, provider),
    errorCode: 'PROVIDER_HTTP',
    httpStatus: status
  }
}
