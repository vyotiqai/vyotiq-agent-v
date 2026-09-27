import type { ChatMessage } from '../../../shared/ipc'

/**
 * Drop leading `tool` rows that are not preceded by a matching `assistant.tool_calls`
 * turn in the working set. Prevents OpenAI-compat HTTP 400 from orphan tool messages
 * after watermark / budget slices that leave a lone `[tool]` remainder.
 *
 * When the window is entirely orphan tools, returns `[]` so callers can rewind.
 */
export function stripLeadingOrphanToolMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages
  let kept = messages
  while (kept.length > 0 && kept[0].role === 'tool') {
    kept = kept.slice(1)
  }
  return kept
}

/**
 * Start of the shortest suffix that does not open on a `tool` row: the last
 * non-tool message, or the final message when every row is a tool result.
 * The last-resort keep window when no fold point leaves a valid suffix.
 */
export function lastNonToolStart(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role !== 'tool') return i
  }
  return Math.max(0, messages.length - 1)
}

/**
 * Apply a compaction `foldedMessages` watermark without leaving a leading orphan
 * `tool` row (including the sole-message case).
 */
export function applyFoldedMessagesWatermark(
  messages: ChatMessage[],
  foldedMessages: number
): { messages: ChatMessage[]; foldedMessages: number } {
  if (foldedMessages <= 0 || messages.length === 0) {
    return { messages, foldedMessages: 0 }
  }
  let fold = Math.min(foldedMessages, Math.max(0, messages.length - 1))
  for (;;) {
    let kept = stripLeadingOrphanToolMessages(messages.slice(fold))
    if (kept.length > 0) {
      return { messages: kept, foldedMessages: fold + (messages.length - fold - kept.length) }
    }
    if (fold <= 0) {
      const start = lastNonToolStart(messages)
      return { messages: messages.slice(start), foldedMessages: start }
    }
    fold--
  }
}
