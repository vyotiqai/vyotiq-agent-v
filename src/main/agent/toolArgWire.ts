/**
 * Streamed tool-arg wire helpers: delta merge and provider history replay.
 */

import { logger } from '../../shared/logger'
import { completeJsonPrefix } from '../../shared/utils/jsonish'

export { mergeOpenAiCompatToolArgDelta } from '../../shared/utils/toolArgDelta'

/**
 * Persist and provider-wire arguments. A double-closed payload is salvaged;
 * anything else unparseable becomes `{}` so callers report malformed arguments.
 *
 * Truncated arguments are deliberately *not* reconstructed field-by-field. A
 * half-streamed `contents` or `new_string` would still satisfy the write-tool
 * schemas, so the tool would overwrite the file with a partial body and report
 * success. Partial extraction belongs to the renderer's streaming diff preview.
 * Nested array fields (questions, todos, edits) are coerced later via parseJsonish;
 * this function only salvages trailing junk after a complete value.
 */
export function wireToolCallArguments(name: string, raw: string): string {
  const text = (raw ?? '').trim()
  if (!text) return '{}'

  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return text
    }
    if (name === 'ask_question' && Array.isArray(parsed)) {
      return JSON.stringify({ questions: parsed })
    }
    if (name === 'todo_write' && Array.isArray(parsed)) {
      return JSON.stringify({ todos: parsed })
    }
  } catch {
    const salvaged = completeJsonPrefix(text)
    if (salvaged) {
      logger.warn('Tool arguments carried trailing content; executing the first payload only', {
        scope: 'agent',
        tool: name,
        discardedChars: text.length - salvaged.length
      })
      return wireToolCallArguments(name, salvaged)
    }
    return '{}'
  }

  return '{}'
}

/**
 * Non-empty arguments that carry no usable object — malformed, truncated, or a
 * non-object value. Lets callers report that instead of "field is required".
 */
export function toolCallArgumentsUnusable(name: string, raw: string | undefined): boolean {
  const text = (raw ?? '').trim()
  if (!text || text === '{}') return false
  return wireToolCallArguments(name, text) === '{}'
}
