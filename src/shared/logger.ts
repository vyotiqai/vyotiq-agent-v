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

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  try {
    backend.log(level, scrubMessage(message), normalizeFields(fields))
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
