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
 * Drop tool rows no provider can pair anywhere in the set: missing `toolCallId`,
 * or a result whose assistant tool call is absent (stale rows, partial slices).
 */
export function stripOrphanToolMessages(messages: ChatMessage[]): ChatMessage[] {
  if (!messages.some((m) => m.role === 'tool')) return messages
  const callIds = new Set<string>()
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const call of m.toolCalls) callIds.add(call.id)
    }
  }
  return messages.filter((m) => {
    if (m.role !== 'tool') return true
    return m.toolCallId != null && callIds.has(m.toolCallId)
  })
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
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== 'tool') {
          return { messages: messages.slice(i), foldedMessages: i }
        }
      }
      return {
        messages: messages.slice(-1),
        foldedMessages: Math.max(0, messages.length - 1)
      }
    }
    fold--
  }
}
