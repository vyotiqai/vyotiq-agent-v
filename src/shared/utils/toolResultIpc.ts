import {
  contentImageArtifacts,
  contentToText,
  toolContentWithImages,
  type AgentEvent,
  type ChatMessage
} from '../ipc'

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
  return fitArgsObject(args, TOOL_ARGS_IPC_PREVIEW_CHARS) ?? `${args.slice(0, TOOL_ARGS_IPC_PREVIEW_CHARS)}\n…`
}

/**
 * An over-long argument object cut to `max` and still an object: its short
 * fields whole, its long strings shortened with "…". A plain cut left invalid
 * JSON the record could not read at all, and a spawn's 6,000-character `goal`
 * pushed its one-line `outcome` and `step_id` out of the preview besides.
 * Null for anything that is not a whole JSON object (arguments still streaming).
 */
function fitArgsObject(args: string, max: number): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const fields = Object.entries(parsed as Record<string, unknown>)
    .map(([key, value]) => ({ key, value, size: key.length + (JSON.stringify(value)?.length ?? 0) + 4 }))
    .sort((a, b) => a.size - b.size)
  const out: Record<string, unknown> = {}
  let used = 2
  for (const { key, value, size } of fields) {
    if (used + size <= max) {
      out[key] = value
      used += size
      continue
    }
    // Shorten a long string to the room left; a long non-string is left out.
    const room = max - used - key.length - 8
    if (typeof value !== 'string' || room < 40) continue
    let cut = value.slice(0, room)
    while (cut && JSON.stringify(cut).length > room + 2) cut = cut.slice(0, Math.floor(cut.length * 0.9))
    out[key] = `${cut}…`
    used += key.length + JSON.stringify(out[key]).length + 4
  }
  return JSON.stringify(out)
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
    // Image parts are small run-dir references; keep them so the row can show them.
    content: toolContentWithImages(
      truncateToolResultContent(content) ?? '',
      contentImageArtifacts(message.content)
    ),
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
