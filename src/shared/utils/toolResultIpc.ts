import { contentToText, type AgentEvent, type ChatMessage } from '../ipc'

/** Matches ToolRow display cap — IPC should not ship more than the UI can show live. */
export const TOOL_RESULT_IPC_PREVIEW_CHARS = 4000

/** Cap live tool-call argument previews in the renderer (full args stay on disk / messages). */
export const TOOL_ARGS_IPC_PREVIEW_CHARS = TOOL_RESULT_IPC_PREVIEW_CHARS

/** Trailing chars preserved on truncated results so `exit_code:` survives. */
export const TOOL_RESULT_TAIL_CHARS = 200

/**
 * Head+tail truncation that keeps trailing metadata lines intact.
 *
 * Terminal results carry `cwd:` at the top and `exit_code: N` at the very
 * bottom. A plain head slice drops that footer, so a long command renders with
 * no exit badge at all and `terminalResultOk` (absence of `exit_code:`) treats
 * it as a pass. Keeping the tail preserves the verdict.
 */
export function truncateToolResultContent(content: string | undefined): string | undefined {
  if (!content) return content
  if (content.length <= TOOL_RESULT_IPC_PREVIEW_CHARS) return content
  const head = content.slice(0, TOOL_RESULT_IPC_PREVIEW_CHARS)
  return `${head}\n…\n${content.slice(-TOOL_RESULT_TAIL_CHARS)}`
}

/** Bound tool-call argument strings shown in the UI transcript. */
export function truncateToolArgsPreview(args: string | undefined): string {
  if (!args) return ''
  if (args.length <= TOOL_ARGS_IPC_PREVIEW_CHARS) return args
  return `${args.slice(0, TOOL_ARGS_IPC_PREVIEW_CHARS)}\n…`
}

/** Shrink tool_result payloads before Structured Clone IPC; persistence keeps full content. */
export function toolResultEventForIpc(event: AgentEvent): AgentEvent {
  if (event.type !== 'tool_result') return event
  if (!event.content || event.content.length <= TOOL_RESULT_IPC_PREVIEW_CHARS) return event
  return {
    ...event,
    content: truncateToolResultContent(event.content),
    contentTruncated: true
  }
}

/** Bound persisted history sent to the renderer without changing on-disk history. */
export function toolMessageForIpc(message: ChatMessage): ChatMessage {
  if (message.role !== 'tool') return message
  const content = contentToText(message.content)
  if (content.length <= TOOL_RESULT_IPC_PREVIEW_CHARS) return message
  return {
    ...message,
    content: truncateToolResultContent(content) ?? '',
    contentTruncated: true
  }
}

const PERSISTED_TOOL_RESULT_CONTENT_MAX = 200

/** Slim tool_result for events.jsonl — full output stays in messages.jsonl only. */
export function toolResultEventForPersistence(event: AgentEvent): AgentEvent {
  if (event.type !== 'tool_result') return event
  const { content, contentTruncated: _contentTruncated, ...rest } = event
  if (content && content.length <= PERSISTED_TOOL_RESULT_CONTENT_MAX) {
    return { ...rest, content }
  }
  return rest
}
