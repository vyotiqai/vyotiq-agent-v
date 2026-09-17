import type { ChatMessage } from '../../../shared/ipc'
import { contentToText } from '../../../shared/ipc'
import { KEEP_LAST_TOOL_RESULTS } from './types'
import {
  CLEARED_TOOL_RESULT_STUB,
  isDurableToolResultName
} from './durableToolResults'

/** Stub text for cleared ephemeral tool bodies. */
function clearedToolStub(_text: string): string {
  return CLEARED_TOOL_RESULT_STUB
}

/**
 * Collapse old ephemeral tool bodies; never stub durable tools (ask_question,
 * todo_write, memory_*). File `read` is clearable. Kept and durable bodies pass
 * through at full length.
 */
export function trimToolResults(
  messages: ChatMessage[],
  keepLast = KEEP_LAST_TOOL_RESULTS
): ChatMessage[] {
  const toolIndexes: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'tool') continue
    // Durable results never count toward the clearable pool / keep window.
    if (isDurableToolResultName(m.toolName)) continue
    toolIndexes.push(i)
  }
  const keep = new Set(toolIndexes.slice(-Math.max(0, keepLast)))

  return messages.map((m, i) => {
    if (m.role !== 'tool') return m
    if (isDurableToolResultName(m.toolName)) {
      return m
    }
    const text = contentToText(m.content)
    const stub = clearedToolStub(text)
    if (!keep.has(i) && text && text !== stub && !text.endsWith(CLEARED_TOOL_RESULT_STUB)) {
      return { ...m, content: stub }
    }
    return m
  })
}
