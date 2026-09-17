/**
 * Tool results that must never be stubbed/cleared on the client wire set.
 * Aligns with Anthropic `clear_tool_uses` exclude_tools: protect durable state
 * (memory, todos, user answers). File `read` is intentionally *not* here —
 * Anthropic treats reads as re-fetchable and clears them; ba335d72's 84× re-read
 * thrash came from instructive stub text + keep=1 + lost ask_question answers,
 * not from clearing read bodies themselves.
 */
export const DURABLE_TOOL_RESULT_NAMES = [
  'memory_read',
  'memory_list',
  'memory_write',
  'todo_write',
  'ask_question',
  // Verification evidence: the harness spine forbids claiming a test or check
  // succeeded unless its result was observed, and these results capture a past
  // command's output that cannot be re-fetched — so they must survive trims.
  'run_tests',
  'diagnostics'
] as const

const DURABLE_SET = new Set<string>(DURABLE_TOOL_RESULT_NAMES)

/** True when this tool's result body must stay intact under client trim. */
export function isDurableToolResultName(toolName: string | undefined | null): boolean {
  if (!toolName) return false
  return DURABLE_SET.has(toolName)
}

/**
 * Neutral placeholder for cleared *ephemeral* tool bodies.
 * Must not instruct the model to re-call tools (that text caused re-read thrash).
 */
export const CLEARED_TOOL_RESULT_STUB = '[cleared]'
