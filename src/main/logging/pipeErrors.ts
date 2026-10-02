import { isAbortError } from '../../shared/errors'

/** Broken-pipe / reset writes must not cascade through uncaughtException logging. */
export function isIgnorablePipeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  return code === 'EPIPE' || code === 'ECONNRESET'
}

/**
 * node-pty's Windows kill() forks a console-list helper and never catches the
 * result. With the runAsNode fuse off Electron refuses the fork. conptyKill.ts
 * replaces the helper; this is the net if a node-pty upgrade moves it. Matched
 * on both the refusal and a node-pty frame, so no other fork is excused.
 */
export function isRefusedNodePtyFork(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return (
    /not supported when the runAsNode fuse is disabled/i.test(err.message) &&
    /node-pty/.test(err.stack ?? '')
  )
}

/** Uncaught/unhandled errors that must not call process.exit(1). */
export function isIgnorableUncaught(err: unknown): boolean {
  return isIgnorablePipeError(err) || isAbortError(err) || isRefusedNodePtyFork(err)
}
