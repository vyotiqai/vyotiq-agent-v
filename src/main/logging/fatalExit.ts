/**
 * The exit after an uncaught exception or unhandled rejection. Run records
 * are written through queues (messages, events, status, the egress ledger),
 * and exiting straight away dropped whatever was still queued — usually the
 * last steps of the run that was going when it happened. Save them first,
 * bounded, then exit: a process in this state must not linger on a stuck
 * write either.
 */

/** Hard bound on the save; the exit happens by then whatever the writes do. */
export const FATAL_FLUSH_MS = 3_000
/** The log transport's tick to write the fatal message itself. */
const LOG_FLUSH_MS = 250

let fatalFlush: (() => Promise<unknown>) | null = null
let exiting = false

/** What to save before a fatal exit. Wired in index.ts once the queues exist. */
export function setFatalFlush(flush: (() => Promise<unknown>) | null): void {
  fatalFlush = flush
}

/**
 * Save queued writes, then exit(1). A second fatal error while saving changes
 * nothing: the first exit is already on its way.
 */
export function exitAfterFatal(
  exit: (code: number) => void = (code) => process.exit(code),
  onSaved?: (outcome: 'saved' | 'failed' | 'none') => void
): void {
  if (exiting) return
  exiting = true
  const hard = setTimeout(() => exit(1), FATAL_FLUSH_MS)
  const flush = fatalFlush
  const saving: Promise<'saved' | 'failed' | 'none'> = flush
    ? Promise.resolve()
        .then(flush)
        .then(
          () => 'saved' as const,
          () => 'failed' as const
        )
    : Promise.resolve('none' as const)
  void saving.then((outcome) => {
    onSaved?.(outcome)
    setTimeout(() => {
      clearTimeout(hard)
      exit(1)
    }, LOG_FLUSH_MS)
  })
}

export function resetFatalExitForTests(): void {
  fatalFlush = null
  exiting = false
}
