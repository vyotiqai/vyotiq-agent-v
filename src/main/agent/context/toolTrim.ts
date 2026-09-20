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
  keepLast = KEEP_LAST_TOOL_RESULTS,
  slack = 0
): ChatMessage[] {
  const toolIndexes: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'tool') continue
    // Durable results never count toward the clearable pool / keep window.
    if (isDurableToolResultName(m.toolName)) continue
    toolIndexes.push(i)
  }

  // Hysteresis. Stubbing on every step rewrites history mid-array — the result
  // that was full text last step becomes `[cleared]` this step — which
  // invalidates the provider's cached prefix from that point on. Measured on
  // live runs: cachedInputTokens pinned near the system+tools prefix (9728)
  // while inputTokens grew 22k -> 30k, with hit rate decaying to 7-10% on large
  // steps. With slack, the boundary moves once every `slack` results instead of
  // every step, so history stays byte-identical in between and the prefix keeps
  // caching. The ceiling is still bounded, just at keepLast + slack.
  if (slack > 0) {
    const unstubbed = toolIndexes.filter((i) => {
      const text = contentToText(messages[i]!.content)
      return text !== '' && !text.endsWith(CLEARED_TOOL_RESULT_STUB)
    })
    if (unstubbed.length <= keepLast + slack) return messages
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
