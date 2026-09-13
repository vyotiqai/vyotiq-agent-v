/**
 * Logging policy: Vyotiq system telemetry only — never user workspace content.
 * Enforced at the logger facade so call sites cannot accidentally leak paths,
 * tool args, chat text, or file names via structured fields or messages.
 */

import { isAppError } from './errors'
import { scrubString } from './scrub'

/** Structured log fields allowed through to disk / optional Sentry. */
export const ALLOWED_LOG_FIELD_KEYS = new Set([
  'scope',
  'correlationId',
  'code',
  'err',
  'channel',
  'provider',
  'model',
  'tool',
  'status',
  'kind',
  'resume',
  'step',
  'ratio',
  'estimatedTokens',
  'contextWindow',
  'source',
  'omittedToolCount',
  'serverId',
  'migrated',
  'count',
  'workspaces',
  'remaining',
  'workspaceId',
  'runId',
  'encryptionAvailable',
  'line',
  'exitCode',
  'reason',
  'terminalType',
  'invokeId',
  'generation',
  'dsnConfigured',
  'telemetryEnabled',
  'inputTokens',
  'cachedInputTokens',
  'cacheCreationInputTokens',
  'attempt',
  'messageCount',
  'toolCallId',
  'providerMessage',
  'logsDir',
  'crashDumpsPath',
  'crashReporterStarted',
  'crashDumpCount',
  /** React component stack for #185 / renderer crashes (path-scrubbed). */
  'componentStack',
  'exitCodeHex',
  'processType',
  'serviceName',
  'reloadCount',
  'url',
  'restored',
  'kept',
  'discarded',
  'action',
  'checkpointId',
  'id',
  'version',
  'removed',
  /** Incomplete-turn / stream stop taxonomy (not user content). */
  'stopReason',
  /** Top-level tool-arg key names only (comma-separated; not values). */
  'argsKeys',
  'circuitKey',
  'retryAfterMs'
])

const PATH_IN_TEXT =
  /(?:[A-Za-z]:\\|\\\\|\/(?:Users|home|root|tmp|var)\/)[^\s"',})\]]+/g

const USER_DATA_PREFIX =
  /^(?:File not found|Not a file|Path is a directory|Path escapes workspace|Binary file detected|Invalid memory path|Unsupported Unix command)[:\s].+/i

/** Safe one-line summary for log messages — no workspace paths or file names. */
export function logErrorSummary(err: unknown, code?: string): string {
  if (err == null) return code ? `${code}: error` : 'Error'
  if (isAppError(err)) return `${err.code}: ${err.name}`
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return `${code ?? err.name}: ${err.name}`
    }
    // Same contract as sanitizeErrorForLog: path-bearing messages are
    // path-scrubbed via sanitizeLogMessage, never dropped (dropping left
    // renderer crash logs with a bare TypeError and no cause).
    const raw = err.message?.trim() ?? ''
    if (raw) {
      const scrubbed = sanitizeLogMessage(raw)
      if (scrubbed) {
        return code ? `${code}: ${scrubbed.slice(0, 120)}` : scrubbed.slice(0, 120)
      }
    }
    return code ? `${code}: ${err.name}` : err.name
  }
  if (typeof err === 'string') {
    const scrubbed = sanitizeLogMessage(err)
    return scrubbed || (code ? `${code}: error` : 'Error')
  }
  return code ? `${code}: error` : 'Error'
}

export function sanitizeLogMessage(message: string): string {
  let out = scrubString(message)
  out = out.replace(PATH_IN_TEXT, '[path]')
  if (USER_DATA_PREFIX.test(out)) {
    const label = out.split(':')[0]?.trim() ?? 'Error'
    out = `${label}: [redacted]`
  }
  if (out.length > 240) out = `${out.slice(0, 237)}...`
  return out
}

/** Strip Error stacks/messages that may embed workspace paths; keep taxonomy only. */
export function sanitizeErrorForLog(err: unknown): Record<string, unknown> | undefined {
  if (err == null) return undefined
  if (isAppError(err)) {
    return {
      name: err.name,
      code: err.code,
      severity: err.severity,
      retriable: err.retriable,
      correlationId: err.correlationId
    }
  }
  if (err instanceof Error) {
    const rec = err as Error & { code?: unknown; errno?: unknown; syscall?: unknown }
    const out: Record<string, unknown> = { name: err.name }
    if (typeof rec.code === 'string' || typeof rec.code === 'number') out.code = rec.code
    if (typeof rec.errno === 'number') out.errno = rec.errno
    if (typeof rec.syscall === 'string') out.syscall = rec.syscall
    // Path-bearing messages are path-scrubbed, not dropped. A failed dynamic
    // import (renderer chunk reload after a rebuild) carries its file:// URL
    // in message text; dropping it left only "TypeError" in crash logs
    // (2026-08-31 renderer crashes, run 82889e99 window) and made the cause
    // undiagnosable. sanitizeLogMessage replaces path spans with [path] /
    // [redacted], so user-derived text never reaches disk.
    const raw = err.message?.trim() ?? ''
    if (raw) {
      const scrubbed = sanitizeLogMessage(raw)
      if (scrubbed && scrubbed !== err.name) out.message = scrubbed.slice(0, 200)
    }
    return out
  }
  // String errors (e.g. formatError output) must retain scrubbed text — do not
  // collapse them to a fake IPC_CLIENT code that hides spawn/uv failures.
  if (typeof err === 'string') {
    const scrubbed = sanitizeLogMessage(err)
    return {
      name: 'Error',
      message: scrubbed.slice(0, 200) || 'error'
    }
  }
  return { name: 'Unknown' }
}

export type PolicyLogFields = Record<string, unknown>

export function sanitizeLogFields(fields?: PolicyLogFields): PolicyLogFields | undefined {
  if (!fields) return undefined
  const out: PolicyLogFields = {}
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_LOG_FIELD_KEYS.has(key)) continue
    if (key === 'err') {
      const sanitized = sanitizeErrorForLog(value)
      if (sanitized) out.err = sanitized
      continue
    }
    if (typeof value === 'string') {
      out[key] = sanitizeLogMessage(value)
      continue
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
      out[key] = value
      continue
    }
    // Nested objects are not permitted — drop to avoid smuggling user data.
  }
  return Object.keys(out).length > 0 ? out : undefined
}

type SentryFrame = { filename?: string; abs_path?: string; [key: string]: unknown }
type SentryException = {
  value?: unknown
  stacktrace?: { frames?: SentryFrame[] }
  [key: string]: unknown
}

/** Strip user-derived text and workspace paths from Sentry events before upload. */
export function scrubSentryEvent<T extends Record<string, unknown>>(event: T): T {
  const out = { ...event } as T & {
    exception?: { values?: SentryException[] }
    message?: unknown
    breadcrumbs?: Array<{ message?: unknown; data?: unknown }>
  }

  if (typeof out.message === 'string') {
    out.message = sanitizeLogMessage(out.message)
  }

  const values = out.exception?.values
  if (Array.isArray(values)) {
    for (const ex of values) {
      if (!ex || typeof ex !== 'object') continue
      delete ex.value
      const frames = ex.stacktrace?.frames
      if (Array.isArray(frames)) {
        for (const frame of frames) {
          if (!frame || typeof frame !== 'object') continue
          if (typeof frame.filename === 'string') {
            frame.filename = frame.filename.replace(/^.*[/\\]/, '[path]/')
          }
          delete frame.abs_path
        }
      }
    }
  }

  if (Array.isArray(out.breadcrumbs)) {
    out.breadcrumbs = out.breadcrumbs.map((crumb) => {
      const next = { ...crumb }
      if (typeof next.message === 'string') {
        next.message = sanitizeLogMessage(next.message)
      }
      if (next.data && typeof next.data === 'object') {
        next.data = sanitizeLogFields(next.data as PolicyLogFields)
      }
      return next
    })
  }

  return out as T
}
