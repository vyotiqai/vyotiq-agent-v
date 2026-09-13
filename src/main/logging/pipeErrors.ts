import { isAbortError } from '../../shared/errors'

/** Broken-pipe / reset writes must not cascade through uncaughtException logging. */
export function isIgnorablePipeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  return code === 'EPIPE' || code === 'ECONNRESET'
}

/** Uncaught/unhandled errors that must not call process.exit(1). */
export function isIgnorableUncaught(err: unknown): boolean {
  return isIgnorablePipeError(err) || isAbortError(err)
}
