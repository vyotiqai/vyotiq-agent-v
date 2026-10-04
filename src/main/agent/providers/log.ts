import { logger } from '../../../shared/logger'
import { formatError, type ErrorCode } from '../../../shared/errors'
import { isCircuitOpenError } from '../circuitBreaker'
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

/**
 * A statusless `http` failure is raised by exactly one call site: the SSE error
 * frame read *inside* an already-open 200 stream (providers/openai.ts). There
 * is no response status to consult because the request itself succeeded — what
 * failed is one frame, which the loop's retry recovers from.
 *
 * AppData 2026-09-29 08:40:58.003 logged
 * `'Streaming response failed: [api_error] internal server error'` at [error],
 * and 08:40:58.004 — 1ms later — logged the normal
 * `'Provider stream error (retrying)'` at [warn]. One of the run's 9 [error]
 * lines described a recovered degraded turn.
 *
 * So the level cannot key on `kind === 'http'` alone: only a *transient* body
 * is downgraded. Bad requests, auth and model errors keep failing forever on
 * retry and must stay at error. Same reasoning as the `parse` branch below —
 * a dropped frame degrades one turn, it is not the whole request failing.
 */
const TRANSIENT_HTTP_BODY_RE =
  /\[api_error\]|internal server error|service unavailable|temporarily unavailable|bad gateway|gateway time-?out|overloaded|server is busy|at capacity|upstream (connect )?error|connection (reset|closed|aborted)|socket hang up|rate limit|too many requests|quota/i

/** True when a statusless `http` body is a transient upstream/transport shape. */
export function isTransientProviderHttpBody(message: string | undefined): boolean {
  return message !== undefined && TRANSIENT_HTTP_BODY_RE.test(message)
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
  // Statusless http + transient body: a frame dropped inside a live stream.
  if (kind === 'http' && status === undefined && isTransientProviderHttpBody(detail.message)) {
    logger.warn(`Provider ${kind} failure`, fields)
    return
  }
  logger.error(`Provider ${kind} failure`, fields)
}

/** Shared catch path for fetchWithRetry failures (network vs open circuit). */
export function providerFetchFailureChunk(provider: string, err: unknown): StreamChunk {
  const circuit = isCircuitOpenError(err)
  logProviderFailure(provider, circuit ? 'circuit' : 'network', {})
  return {
    type: 'error',
    error: formatError(err),
    errorCode: circuit ? 'CIRCUIT_OPEN' : 'PROVIDER_NETWORK'
  }
}
