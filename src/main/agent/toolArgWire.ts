/**
 * Streamed tool-arg wire helpers: delta merge and provider history replay.
 */

import { logger } from '../../shared/logger'
import {
  closeUnterminatedJson,
  completeJsonPrefix,
  trimDanglingJsonTail
} from '../../shared/utils/jsonish'

export { mergeOpenAiCompatToolArgDelta } from '../../shared/utils/toolArgDelta'

/**
 * Write-family tools whose truncated arguments are never closed up — a
 * salvageable-but-cut payload could still pass the schema and overwrite files
 * with a partial body. Same locked rationale as the mid-string refusals.
 */
const WRITE_FAMILY_TOOLS = new Set([
  'edit',
  'str_replace',
  'edit_notebook',
  'delete',
  'memory_write',
  'build_tool',
  'git_apply',
  'git_commit'
])

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

  const writeTool = WRITE_FAMILY_TOOLS.has(name)

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
    const closed = closeUnterminatedJson(text)
    if (closed && !writeTool) {
      try {
        const parsed: unknown = JSON.parse(closed)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          logger.warn('Tool arguments were missing closing brackets; appending them', {
            scope: 'agent',
            tool: name,
            closedContainers: closed.length - text.length
          })
          return closed
        }
      } catch {
        // fall through to '{}'
      }
    }
    // A dangling trailing member stub (` , `, ` , "key"`, ` , "key": `) proves
    // every value before it is whole — the , / : is the token terminator, so
    // `12,` cannot be a cut `123`. Dropping the stub reconstructs no value; the
    // schema then names the missing field precisely instead of a blanket
    // malformed-args refusal (observed cuts ended right before `todos` /
    // `sub_tasks` values). Gated exactly like closeUnterminatedJson: write
    // family tools never receive reconstructed arguments.
    const trimmed = trimDanglingJsonTail(text)
    if (trimmed && !writeTool) {
      logger.warn('Tool arguments ended on a dangling member stub; dropped it', {
        scope: 'agent',
        tool: name,
        droppedChars: text.length - trimmed.length
      })
      return wireToolCallArguments(name, trimmed)
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
