/**
 * Stand-in tool results written when a tool call never produced one.
 *
 * These are contract text, not cosmetics: the loop's accounting recognizes them
 * so an abandoned call is not billed as a failed execution, the renderer shows
 * them in the transcript, and — most importantly — the model reads them when a
 * run resumes. What they say is what the next turn believes happened.
 */

/** The turn was aborted in-process; the tool did not run. */
export const TOOL_STUB_CANCELLED = 'Cancelled'

/** The stream was interrupted mid-step; the tool did not run. */
export const TOOL_STUB_INTERRUPTED = 'Interrupted'

/**
 * The process died between dispatching a tool and recording its result.
 *
 * Unlike the two above, this one cannot claim the tool did not run. The call
 * was already in flight, so a command may have executed, files may have been
 * written, or a request may have reached a remote service — and none of it was
 * durably recorded. Saying "Cancelled" here would invite the resumed turn to
 * replay a consequential action as if it had never happened, which is exactly
 * the exactly-once guarantee a crash cannot offer. The text states the
 * uncertainty and asks for a check instead.
 */
export const TOOL_STUB_RESTART_INTERRUPTED =
  'Interrupted by app restart before this tool reported a result. It may have ' +
  'already run — files may have been written, commands may have executed, or ' +
  'requests may have been sent. Check the current state before retrying; do not ' +
  'assume it had no effect.'

/**
 * True for any stand-in written in place of a real tool result. Used to keep
 * abandoned calls out of failed-execution statistics.
 */
export function isAbortStubText(content: string): boolean {
  const text = content.trim()
  return (
    text === TOOL_STUB_CANCELLED ||
    text === TOOL_STUB_INTERRUPTED ||
    text === TOOL_STUB_RESTART_INTERRUPTED
  )
}
