import { ZodError } from 'zod'
import { scrubString } from './scrub'

/**
 * Every code emitted at runtime. AgentEvent.code travels as a plain string over
 * IPC, so the compiler cannot catch drift — keep this union in sync with the
 * string literals actually attached to error events and AppErrors.
 */
export type ErrorCode =
  | 'AGENT_LOOP'
  | 'AGENT_QUESTION'
  | 'AGENT_QUESTION_INVALID'
  | 'AGENT_QUESTION_WAIT'
  | 'AGENT_INCOMPLETE'
  | 'AGENT_FINALLY_FLUSH'
  | 'AGENT_FINALLY_DISPOSE'
  | 'CATALOG_PROBE'
  | 'COMPACTION'
  | 'CIRCUIT_OPEN'
  | 'IPC_VALIDATION'
  | 'IPC_HANDLER'
  | 'IPC_CLIENT'
  | 'MCP_CONNECT'
  | 'MCP_SPAWN'
  | 'PERSIST'
  | 'RENDERER_CRASH'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_BILLING'
  | 'PROVIDER_HTTP'
  | 'PROVIDER_NETWORK'
  | 'PROVIDER_STREAM'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_KEYCHAIN'
  | 'PROVIDER_KEY_DECRYPT'
  | 'SECRETS'
  | 'SETTINGS'
  | 'TOOL_APPROVAL'
  | 'TOOL_EXEC'
  | 'UNCAUGHT'
  | 'WORKSPACE'

export type ErrorSeverity = 'error' | 'warn' | 'info' | 'fatal'

export class AppError extends Error {
  readonly code: ErrorCode
  readonly severity: ErrorSeverity
  readonly retriable: boolean
  readonly correlationId?: string
  readonly context?: Record<string, unknown>

  constructor(
    message: string,
    opts?: {
      code?: ErrorCode
      severity?: ErrorSeverity
      retriable?: boolean
      correlationId?: string
      cause?: unknown
      context?: Record<string, unknown>
    }
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'AppError'
    this.code = opts?.code ?? 'AGENT_LOOP'
    this.severity = opts?.severity ?? 'error'
    this.retriable = opts?.retriable ?? false
    this.correlationId = opts?.correlationId
    this.context = opts?.context
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError
}

export function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof Error && err.name === 'AbortError') return true
  if (err instanceof Error && err.message === 'Aborted') return true
  if (isAppError(err) && err.cause instanceof DOMException && err.cause.name === 'AbortError') {
    return true
  }
  return false
}

/**
 * Combine independent abort sources into one signal.
 *
 * Used where a caller needs to cancel work for its own reason (a per-tool
 * deadline) without cancelling the shared run signal, which is still driving
 * sibling operations. Aborting `a` or `b` aborts the result.
 *
 * Prefers the native `AbortSignal.any` when available and falls back to a
 * manual composite otherwise, matching the pattern already used elsewhere in
 * the runtime (see `compactRun` / `networkMonitor`).
 */
export function composeAbortSignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([a, b])
  }
  const controller = new AbortController()
  const onAbort = (): void => {
    controller.abort((a.reason ?? b.reason) as unknown)
  }
  if (a.aborted || b.aborted) {
    controller.abort((a.reason ?? b.reason) as unknown)
    return controller.signal
  }
  a.addEventListener('abort', onAbort, { once: true })
  b.addEventListener('abort', onAbort, { once: true })
  return controller.signal
}

/**
 * Attach a no-op rejection handler so a promise cannot become an
 * unhandledRejection before the caller awaits it (Electron `loadURL` +
 * `did-fail-load` can reject two promises for one navigation).
 */
export function observePromise<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => {})
  return promise
}

export function isExpectedToolError(message: string): boolean {
  if (/Command timed out after \d+ms/i.test(message)) return false
  return /File not found|Not a file|Path is a directory|Path escapes workspace|No matches|Unsupported Unix command|Invalid memory path|Binary file detected|MCP server not connected/i.test(
    message
  )
}

// IPC_CLIENT is a failure the other side already handled and returned as a string,
// so it must not be re-reported as an unexpected crash. MCP connect/spawn failures
// are operator/config issues, not app crashes.
const EXPECTED_CODES = new Set<ErrorCode>([
  'IPC_VALIDATION',
  'IPC_CLIENT',
  'MCP_CONNECT',
  'MCP_SPAWN',
  'CIRCUIT_OPEN'
])

// Codes excluded here are permanent user-action failures (bad key, missing
// plan, exhausted credits) — the UI must not offer Retry for them. PROVIDER_HTTP
// stays retryable for 404/429/5xx; 401/402/403 arrive pre-mapped to PROVIDER_AUTH
// / PROVIDER_BILLING by the loop (see providerHttpErrorCode).
const RETRYABLE_TURN_ERROR_CODES = new Set<ErrorCode>([
  'PROVIDER_NETWORK',
  'PROVIDER_HTTP',
  'PROVIDER_TIMEOUT',
  'PROVIDER_STREAM',
  'CIRCUIT_OPEN'
])

// 2026-09-01 audit (runs 9349708b / c9e863c0): empty_response and truncated
// incompletes ended turns with NO user-visible banner because only network-
// class reasons were recognized here. The loop auto-continues these in-band;
// when a turn does surface them, the user must see why the run stopped. They
// are surfaceable turn failures: the Continue/retry affordance re-issues a
// user turn, not an auto-resend, so listing them cannot create a resend loop.
const RETRYABLE_INCOMPLETE_REASONS = new Set([
  'network_interrupted',
  'circuit_open',
  'provider_error',
  'empty_response',
  'truncated',
  // Bounded goal auto-continue stop: the goal is still active but the model
  // finished twice without tools. A user continue re-issues a turn (the goal
  // loop resumes it), so listing it cannot create an auto-resend loop.
  'goal_wait'
])

/** Continue / retry affordance for transient provider, stream, and circuit-open failures. */
export function isRetryableTurnFailure(opts: {
  errorCode?: string | null
  incompleteReason?: string | null
}): boolean {
  const code = opts.errorCode
  const reason = opts.incompleteReason
  return (
    // Codes cross the IPC boundary as plain strings — unknown codes fall out of
    // the retryable set (fail closed), known ones classify normally.
    (typeof code === 'string' && RETRYABLE_TURN_ERROR_CODES.has(code as ErrorCode)) ||
    (typeof reason === 'string' && RETRYABLE_INCOMPLETE_REASONS.has(reason))
  )
}

/** Classify stdio/spawn failures vs generic MCP connect errors. */
export function mcpConnectErrorCode(err: unknown): 'MCP_SPAWN' | 'MCP_CONNECT' {
  if (!err || typeof err !== 'object') return 'MCP_CONNECT'
  const code = (err as { code?: unknown }).code
  if (
    code === 'ENOENT' ||
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'ENOTDIR' ||
    code === 'EINVAL'
  ) {
    return 'MCP_SPAWN'
  }
  const message = err instanceof Error ? err.message : String(err)
  if (/ENOENT|spawn |uvx|uv\.exe|not found|is not recognized/i.test(message)) {
    return 'MCP_SPAWN'
  }
  return 'MCP_CONNECT'
}

export function isExpectedError(err: unknown): boolean {
  if (isAbortError(err)) return true
  if (err instanceof ZodError) return true
  if (isAppError(err)) {
    if (EXPECTED_CODES.has(err.code)) return true
    if (isAbortError(err.cause)) return true
    return false
  }
  return false
}

export function createCorrelationId(): string {
  // Shared by main and renderer, so use the Web Crypto global rather than node:crypto.
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid.replace(/-/g, '').slice(0, 16)
  return Math.random().toString(16).slice(2).padEnd(16, '0').slice(0, 16)
}

function formatZodError(err: ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : 'value'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}

export function formatError(err: unknown): string {
  if (err == null) return 'Unknown error'
  if (isAppError(err)) {
    const parts = [scrubString(err.message)]
    if (err.cause instanceof Error && err.cause.message) {
      parts.push(scrubString(err.cause.message))
    }
    return parts.filter(Boolean).join(' — ') || 'Unknown error'
  }
  if (err instanceof ZodError) return scrubString(formatZodError(err))
  if (err instanceof Error) {
    const parts = [scrubString(err.message)]
    const cause = (err as Error & { cause?: unknown }).cause
    if (cause instanceof Error && cause.message) {
      parts.push(scrubString(cause.message))
    }
    return parts.filter(Boolean).join(' — ')
  }
  return scrubString(String(err))
}

/**
 * Tool-result text for the model. `formatError` collapses absolute paths to a
 * basename (PII scrub), which turned AppData escapes into `Path escapes
 * workspace: vyotiq` — the model then treated a relative name as the failure.
 */
export function formatToolResultError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  if (/Path escapes workspace/i.test(raw)) {
    const requested = raw.replace(/^Path escapes workspace:\s*/i, '').trim()
    const looksAbsolute =
      /^[A-Za-z]:[\\/]/.test(requested) ||
      requested.startsWith('/') ||
      requested.startsWith('\\\\')
    if (looksAbsolute) {
      return 'Path escapes workspace: requested path is outside the workspace root. Use a workspace-relative path; absolute home, AppData, and other-drive paths are rejected.'
    }
    return `Path escapes workspace: ${requested}. Stay inside the workspace root; do not use '..' to leave it.`
  }
  return formatError(err)
}

export function toAppError(
  err: unknown,
  opts?: { code?: ErrorCode; correlationId?: string; cause?: unknown }
): AppError {
  if (isAppError(err)) {
    if (opts?.correlationId && !err.correlationId) {
      return new AppError(err.message, {
        code: opts.code ?? err.code,
        correlationId: opts.correlationId,
        cause: err.cause,
        context: err.context
      })
    }
    return err
  }
  if (err instanceof ZodError) {
    return new AppError(formatZodError(err), {
      code: opts?.code ?? 'IPC_VALIDATION',
      correlationId: opts?.correlationId,
      cause: err
    })
  }
  if (err instanceof Error) {
    return new AppError(err.message, {
      code: opts?.code ?? 'AGENT_LOOP',
      correlationId: opts?.correlationId,
      cause: opts?.cause ?? err
    })
  }
  return new AppError(String(err), {
    code: opts?.code ?? 'IPC_CLIENT',
    correlationId: opts?.correlationId,
    cause: opts?.cause
  })
}

export function toLogErr(message: string): AppError {
  return new AppError(message, { code: 'IPC_CLIENT' })
}
