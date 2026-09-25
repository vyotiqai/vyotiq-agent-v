/**
 * Waits the agent observes, shared so the UI states the same numbers main
 * enforces rather than a copy that can drift.
 */

/** A command's wait when the model gives no `timeoutMs` / `block_until_ms`. */
export const TERMINAL_DEFAULT_TIMEOUT_MS = 300_000

/** How long a tool approval waits for you before it is denied automatically. */
export const TOOL_APPROVAL_TIMEOUT_MS = 900_000
