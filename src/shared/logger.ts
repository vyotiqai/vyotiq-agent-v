import type { AppError } from './errors'
import { isAppError, isExpectedError, toAppError } from './errors'
import {
  logErrorSummary,
  sanitizeErrorForLog,
  sanitizeLogFields,
  sanitizeLogMessage
} from './logPolicy'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export type LogFields = {
  scope?: string
  correlationId?: string
  code?: string
  /** Prefer attaching thrown values here — sanitized before disk/Sentry. */
  err?: unknown
  [key: string]: unknown
}

export type LoggerBackend = {
  log: (level: LogLevel, message: string, fields?: LogFields) => void
  captureException?: (err: unknown, fields?: LogFields) => void
}

const NOOP_BACKEND: LoggerBackend = {
  log: () => undefined
}

let backend: LoggerBackend = NOOP_BACKEND

/** Inject process-specific transport (electron-log, console, test mock). */
export function setLoggerBackend(next: LoggerBackend): void {
  backend = next
}

export function getLoggerBackend(): LoggerBackend {
  return backend
}

function normalizeFields(fields?: LogFields): LogFields | undefined {
  if (!fields) return undefined
  return sanitizeLogFields(fields) as LogFields | undefined
}

function scrubMessage(message: string): string {
  return sanitizeLogMessage(message)
}

function scrubErrForCapture(err: unknown): unknown {
  const sanitized = sanitizeErrorForLog(err)
  if (sanitized) return sanitized
  return { name: 'Unknown' }
}

/**
 * Cap on a *rendered* log line — the whole record electron-log writes:
 * timestamp + level + scope/correlation prefix + message + serialized fields.
 *
 * `sanitizeLogMessage` caps each string separately, so nothing bounded the sum:
 * a 2026-10-02 disk audit of `%APPDATA%\vyotiq\logs` measured 454 rendered
 * lines over 240 chars, 453 of them carrying no marker at all — prefix + short
 * message + a few fields, cut nowhere, indistinguishable from a complete entry.
 * This is the cap those lines are measured against.
 */
export const LOG_LINE_TEXT_CAP = 240

/**
 * Bytes electron-log's File transport prepends before the message text:
 * `'[{y}-{m}-{d} {h}:{i}:{s}.{ms}] '` (25) + `'[{level}]'` padded to 6 (6) plus
 * the space `concatFirstStringElements` puts between the two leading strings (1).
 * Only the length matters here, so the date and level are not formatted.
 */
const LOG_FILE_PREFIX_CHARS = 33

/**
 * Rendered length of one value under `util.inspect` (what electron-log's
 * `toString` transform calls with `inspectOptions` from the File transport).
 *
 * `src/shared` is bundled into the renderer, so this deliberately does not
 * import `node:util`; it mirrors `util.inspect` instead. Under-counting would
 * leave a line unmarked — the defect being fixed — so every branch rounds up or
 * adds the extra quotes `util.inspect` puts on a top-level string.
 */
function inspectedLength(value: unknown, depth: number): number {
  if (value == null) return value === null ? 4 : 5 // null / undefined
  switch (typeof value) {
    case 'string':
      // util.inspect wraps a top-level string in single quotes unless it would
      // have to switch to double quotes to avoid escapes.
      return value.length + (value.includes("'") ? 2 : 4)
    case 'number':
      return String(value).length
    case 'boolean':
      return String(value).length
    case 'bigint':
      return `${value}n`.length
    case 'symbol':
      return String(value).length
    case 'function':
      return value.length
    default:
      break
  }
  if (value instanceof RegExp) return String(value).length
  if (value instanceof Date) return value.toISOString().length
  if (value instanceof Error) {
    // sanitizeErrorForLog converts Error → plain record, so this is defensive.
    return value.stack?.length ?? 0
  }
  if (depth <= 0) return Array.isArray(value) ? 7 : 8 // [Array] / [Object]
  if (Array.isArray(value)) {
    let length = 2 // []
    value.forEach((item, i) => {
      if (i > 0) length += 2 // ", "
      length += inspectedLength(item, depth - 1)
    })
    // util.inspect switches to a multi-line "... N more items" form past
    // breakLength. Summing every item can only over-count, which is the safe
    // direction: it marks a line early, never leaves one unmarked.
    return length
  }
  const entries = Object.entries(value as Record<string, unknown>)
  let length = 2 // {}
  entries.forEach(([key, item], i) => {
    if (i > 0) length += 2 // ", "
    // util.inspect leaves an identifier-like key unquoted and quotes the rest;
    // counted pessimistically at 2 either way.
    length += key.length + 2 + 2 + inspectedLength(item, depth - 1)
  })
  return length
}

/**
 * Rendered length of everything the fields add to the line.
 *
 * Both backends (main `logging/init.ts` and the renderer's `logging/init.ts`)
 * build the text as `` `[${scope}] ` `` + `` `{${correlationId}} ` `` +
 * message, then destructure `scope` / `correlationId` out of the object and
 * let electron-log serialize only what is left. So the two prefixes are counted
 * as text here, and the space before the meta object only when meta is left.
 */
function renderedFieldsLength(fields: LogFields | undefined): number {
  if (!fields) return 0
  let length = 0
  if (typeof fields.scope === 'string' && fields.scope) length += fields.scope.length + 3 // '[x] '
  if (typeof fields.correlationId === 'string' && fields.correlationId) {
    length += fields.correlationId.length + 3 // '{x} '
  }
  const { scope: _s, correlationId: _c, ...rest } = fields
  if (Object.keys(rest).length > 0) length += 1 + inspectedLength(rest, 5) // ' { … }'
  return length
}

/**
 * Append a visible marker when the rendered record exceeds {@link
 * LOG_LINE_TEXT_CAP}, so an entry cut by the cap can never be mistaken for a
 * complete one.
 *
 * This only *measures* — the message and fields have already been scrubbed by
 * `sanitizeLogMessage` / `sanitizeLogFields` before this runs, nothing here cuts
 * or rewrites content, and the marker reports the real overflow. Keeping the
 * marker on the message text is what puts it at the end of the line: electron-log
 * renders the remaining fields after `{text}`.
 */
export function markTruncatedLogText(message: string, fields?: LogFields): string {
  const rendered = LOG_FILE_PREFIX_CHARS + message.length + renderedFieldsLength(fields)
  if (rendered <= LOG_LINE_TEXT_CAP) return message
  const hidden = rendered - LOG_LINE_TEXT_CAP
  return `${message} [+truncated: ${hidden} char${hidden === 1 ? '' : 's'}]`
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  try {
    const safeFields = normalizeFields(fields)
    const safeMessage = scrubMessage(message)
    backend.log(level, markTruncatedLogText(safeMessage, safeFields), safeFields)
  } catch {
    // Logger must never throw into app paths
  }
}

function shouldCapture(err: unknown, level: LogLevel): boolean {
  if (level !== 'error' && level !== 'fatal') return false
  if (isExpectedError(err)) return false
  return true
}

function capture(err: unknown, fields?: LogFields): void {
  if (!backend.captureException) return
  try {
    backend.captureException(scrubErrForCapture(err), normalizeFields(fields))
  } catch {
    // ignore
  }
}

export const logger = {
  debug(message: string, fields?: LogFields): void {
    emit('debug', message, fields)
  },
  info(message: string, fields?: LogFields): void {
    emit('info', message, fields)
  },
  warn(message: string, fields?: LogFields): void {
    emit('warn', message, fields)
  },
  error(message: string, fields?: LogFields): void {
    emit('error', message, fields)
    if (fields?.err != null && shouldCapture(fields.err, 'error')) {
      capture(fields.err, fields)
    }
  },
  fatal(message: string, fields?: LogFields): void {
    emit('fatal', message, fields)
    if (fields?.err != null && shouldCapture(fields.err, 'fatal')) {
      capture(fields.err, fields)
    } else if (fields?.err == null) {
      capture(new Error(sanitizeLogMessage(message)), fields)
    }
  },
  /** Log an AppError / unknown at the right level and optionally capture. */
  exception(err: unknown, fields?: LogFields): void {
    const appErr: AppError = isAppError(err) ? err : toAppError(err)
    const level: LogLevel =
      isExpectedError(err) ? 'warn' : appErr.severity === 'fatal' ? 'fatal' : 'error'
    const merged: LogFields = {
      scope: fields?.scope,
      correlationId: fields?.correlationId ?? appErr.correlationId,
      code: fields?.code ?? appErr.code,
      err: appErr,
      ...fields
    }
    emit(level, logErrorSummary(appErr, merged.code as string | undefined), merged)
    if (shouldCapture(err, level)) {
      capture(appErr, merged)
    }
  }
}

export type Logger = typeof logger

export { logErrorSummary } from './logPolicy'
