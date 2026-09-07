import type { ChatMessage, MessageContent, PersistedEvent } from '../ipc'
import {
  contentAudios,
  contentDisplayText,
  contentFiles,
  contentImages,
  contentNativeFiles,
  contentToText
} from '../ipc'
import { isAgentEvent } from '../utils/eventUtils'
import { isRetryableTurnFailure } from '../utils/errors'
import {
  parseProviderReasoningState,
  thinkingFromReasoningState
} from './reasoning'
import { summarizeToolArgs } from '../utils/toolSummary'
import { truncateToolArgsPreview } from '../utils/toolResultIpc'
import { finalizeTodoContentOnRunEnd } from '../utils/todoContent'

const KEEP_FULL_ARGS_TOOLS = new Set(['edit', 'str_replace', 'delete'])

function uiArgsPreview(name: string, args: string | undefined): string | undefined {
  if (!args) return undefined
  if (KEEP_FULL_ARGS_TOOLS.has(name)) return args
  return truncateToolArgsPreview(args)
}

export type ToolPresentation = 'prominent' | 'compact'

export type UiToolRow = {
  id: string
  name: string
  summary: string
  status: 'running' | 'done' | 'fail'
  content?: string
  /** Live IPC shipped a preview only; expand to lazy-load from disk. */
  contentTruncated?: boolean
  argsPreview?: string
  /** Locked at first render; terminal may recompute when args arrive for read-only demotion. */
  presentation?: ToolPresentation
}

export type UiGroupTiming = {
  startedAt: number
  endedAt?: number
}

/** One line of live progress from a long-running tool. */
export type UiToolProgressEntry = {
  kind: 'text' | 'thinking' | 'tool' | 'done'
  text: string
}

/** A document the user attached, shown as a chip instead of its extracted text. */
export type UiAttachment = {
  name: string
  mime: string
  chars: number
}

/** A gated call the agent is parked on, waiting for the reader to answer. */
export type UiToolApproval = {
  requestId: string
  toolName: string
  summary: string
  argsPreview: string
  mutating: boolean
}

/** One field in a pending ask_question form. */
export type UiAgentQuestionItem = {
  id: string
  prompt: string
  type: 'single' | 'multi' | 'boolean' | 'text'
  options?: string[]
  allowCustom?: boolean
}

/** A structured question form the agent is waiting on in the transcript. */
export type UiAgentQuestion = {
  requestId: string
  toolCallId: string
  title?: string
  questions: UiAgentQuestionItem[]
}

/** Structured answer payload submitted for a pending question form. */
export type UiAgentQuestionAnswer = {
  questionId: string
  values: string[]
}

export type CompactionVerifyStatus = 'verifying' | 'retrying' | 'verified' | 'failed'

/** Stable id for the in-flight compact card (replaced when the fold settles). */
export const LIVE_COMPACTION_ID = 'compaction:in-flight'

export type UiItem =
  | {
      kind: 'message'
      id: string
      role: 'user' | 'assistant'
      content: string
      images?: string[]
      attachments?: UiAttachment[]
      streaming?: boolean
      thinking?: string
      thinkingStreaming?: boolean
      thinkingExpanded?: boolean
      /** True while the provider stream is reconnecting after a transient disconnect. */
      reconnecting?: boolean
      /** ISO timestamp when the message was sent or received. */
      at?: string
    }
  | {
      kind: 'tool'
      id: string
      tool: UiToolRow
      groupTiming?: UiGroupTiming
      at?: string
      toolExpanded?: boolean
      /**
       * Reader's disclosure choice for the activity group this row opens. Kept on
       * the row rather than in the component so it survives list remounts.
       */
      groupExpanded?: boolean
      /** Set while this call is waiting on tool approval. */
      approval?: UiToolApproval
      /** Live progress lines from a long-running tool. */
      toolProgress?: UiToolProgressEntry[]
    }
  | {
      kind: 'question'
      id: string
      question: UiAgentQuestion
      at?: string
    }
  | {
      /** Persisted run failure visible in the transcript after the banner is dismissed. */
      kind: 'run_error'
      id: string
      message: string
      code?: string
      at?: string
    }
  | {
      /** LLM summary of folded history — shown inline in the transcript. */
      kind: 'compaction'
      id: string
      summary: string
      tokenEstimate?: number
      expanded?: boolean
      at?: string
      verifyStatus?: CompactionVerifyStatus
      verifyFailures?: string[]
      verifyCoverage?: number
    }

/** Attachment chips for a message: names and sizes only, never the quoted text. */
export function uiAttachments(content: MessageContent): UiAttachment[] {
  const out: UiAttachment[] = contentFiles(content).map((file) => ({
    name: file.name,
    mime: file.mime,
    chars: file.text.length
  }))
  for (const file of contentNativeFiles(content)) {
    out.push({
      name: file.name,
      mime: file.mime,
      chars: Math.ceil((file.data.length * 3) / 4)
    })
  }
  for (const audio of contentAudios(content)) {
    out.push({
      name: 'audio',
      mime: audio.mime || 'audio/*',
      chars: Math.ceil((audio.url.length * 3) / 4)
    })
  }
  return out
}

/** Stable ids so reload/sync does not remount every transcript row. */
export function messageUiId(role: 'user' | 'assistant', index: number): string {
  return `${role}-${index}`
}

function toolContentText(content: MessageContent): string {
  return typeof content === 'string' ? content : contentToText(content)
}

export function inferToolStatus(content: MessageContent, ok?: boolean): 'done' | 'fail' {
  if (ok !== undefined) return ok ? 'done' : 'fail'
  const text = toolContentText(content)
  if (
    text === 'Cancelled' ||
    text === 'Interrupted' ||
    text === 'Stopped' ||
    text === 'Not completed' ||
    text === 'Connection lost'
  )
    return 'fail'
  if (!text) return 'done'
  if (/^Failed to parse tool arguments/i.test(text)) return 'fail'
  if (/^Unknown tool[:\s"]/i.test(text)) return 'fail'
  if (/exit_code:\s*(?!0\b)\d+/i.test(text)) return 'fail'
  return 'done'
}

type AssistantMessageItem = Extract<UiItem, { kind: 'message' }> & { role: 'assistant' }

/** True when reasoning text is worth showing (not empty or placeholder punctuation). */
export function isMeaningfulThinking(text: string | undefined): boolean {
  if (!text) return false
  const trimmed = text.trim()
  if (!trimmed) return false
  if (/^[.…,;:!?\-–—\s]+$/.test(trimmed)) return false
  return trimmed.length >= 2
}

/**
 * Finished stubs shorter than this render as empty padded gaps if a thinking
 * row is emitted — keep the threshold shared by row builders and ThinkingBlock.
 */
export const MIN_VISIBLE_FINISHED_THINKING_CHARS = 24

/** Whether a thinking row / ThinkingBlock should render for this content. */
export function shouldRenderThinking(
  text: string | undefined,
  streaming?: boolean
): boolean {
  if (!isMeaningfulThinking(text)) return false
  if (streaming) return true
  return (text?.trim().length ?? 0) >= MIN_VISIBLE_FINISHED_THINKING_CHARS
}

/**
 * Long enough that matching the reasoning means the model really did emit the
 * same passage twice, rather than two rows happening to share a short phrase.
 */
const DUPLICATE_TEXT_MIN_CHARS = 40

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Join thinking chunks and drop near-duplicate paragraphs. */
export function mergeThinkingContent(chunks: string[]): string {
  const seen = new Set<string>()
  const parts: string[] = []

  for (const chunk of chunks) {
    for (const paragraph of chunk.split(/\n\n+/)) {
      const trimmed = paragraph.trim()
      if (!trimmed) continue
      const key = collapseWhitespace(trimmed)
      if (key.length >= DUPLICATE_TEXT_MIN_CHARS) {
        if (seen.has(key)) continue
        seen.add(key)
      }
      parts.push(trimmed)
    }
  }

  return parts.join('\n\n')
}

/**
 * Hide assistant text that only repeats the reasoning already shown beside it.
 *
 * Nothing else is hidden. The narration a tool loop produces between batches is
 * the model's running commentary on its own work, and it streams in live, so
 * suppressing it is what leaves a multi-minute turn looking like a frozen page.
 */
export function duplicatesReasoning(item: UiItem): boolean {
  if (item.kind !== 'message' || item.role !== 'assistant') return false
  const content = item.content?.trim()
  if (!content || content.length < DUPLICATE_TEXT_MIN_CHARS) return false
  if (!isMeaningfulThinking(item.thinking)) return false
  const normalizedThinking = collapseWhitespace(item.thinking ?? '')
  const normalizedContent = collapseWhitespace(content)
  // Only hide when the answer is a verbatim prefix of reasoning — not when it
  // merely shares a long passage somewhere inside the thinking block.
  return normalizedThinking.startsWith(normalizedContent)
}

/** True when assistant text looks like a leaked pseudo tool call, not narration. */
export function isToolShapedTextLeak(content: string): boolean {
  const trimmed = content.trimStart()
  if (!trimmed) return false
  if (/^tool\s*(\{|[a-z_]+\b)/i.test(trimmed)) return true
  // Whole buffer is only tool-shaped / DSML leak after scrubbing.
  if (stripToolShapedAssistantTextForStream(content).trim() === '') {
    if (/\btool\s*(\{|[a-z_]+\b)/i.test(trimmed)) return true
    if (hasDsmlMarkup(trimmed)) return true
  }
  return false
}

/**
 * DeepSeek DSML token. Official V4 encoding uses fullwidth U+FF5C (`｜`);
 * screenshots of the live UI also show ASCII `|` after decode/display.
 */
const DSML_MARK = String.raw`(?:\uFF5C|\|)DSML(?:\uFF5C|\|)`

const DSML_TOOL_CALLS_BLOCK = new RegExp(
  String.raw`<${DSML_MARK}(?:tool_calls|function_calls)\s*>[\s\S]*?</${DSML_MARK}(?:tool_calls|function_calls)\s*>`,
  'gi'
)
const DSML_INVOKE_BLOCK = new RegExp(
  String.raw`<${DSML_MARK}invoke\b[^>]*>[\s\S]*?</${DSML_MARK}invoke\s*>`,
  'gi'
)
const DSML_PARAMETER_BLOCK = new RegExp(
  String.raw`<${DSML_MARK}parameter\b[^>]*>[\s\S]*?</${DSML_MARK}parameter\s*>`,
  'gi'
)
const DSML_ANY_TAG = new RegExp(String.raw`</?${DSML_MARK}[^>\n]*>`, 'gi')
const DSML_OPEN_RE = new RegExp(String.raw`<(/)?${DSML_MARK}`, 'i')

function hasDsmlMarkup(content: string): boolean {
  return DSML_OPEN_RE.test(content)
}

/** Remove complete DeepSeek DSML tool-call markup from assistant text. */
export function stripDsmlToolMarkup(content: string): string {
  if (!content || !hasDsmlMarkup(content)) return content
  let out = content
  // Repeat in case multiple sibling blocks appear (screenshot spam).
  for (let n = 0; n < 32; n++) {
    const next = out
      .replace(DSML_TOOL_CALLS_BLOCK, '')
      .replace(DSML_INVOKE_BLOCK, '')
      .replace(DSML_PARAMETER_BLOCK, '')
    if (next === out) break
    out = next
  }
  out = out.replace(DSML_ANY_TAG, '')
  return out
}

/**
 * Drop a tool JSON blob still being streamed (no closing brace yet) and any
 * trailing partial `tool <name> …` line at the end of the buffer.
 */
export function stripIncompleteToolPrefix(content: string): string {
  if (!content) return content

  let searchFrom = 0
  let cutAt: number | null = null
  while (searchFrom < content.length) {
    const rest = content.slice(searchFrom)
    const match = rest.match(/\btool\s*\{/)
    if (!match || match.index === undefined) break
    const start = searchFrom + match.index
    let i = start + match[0].length
    let depth = 1
    while (i < content.length && depth > 0) {
      const ch = content[i]!
      i += 1
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
    }
    if (depth > 0) {
      cutAt = start
      break
    }
    searchFrom = i
  }

  if (cutAt !== null) {
    return content.slice(0, cutAt).replace(/[ \t]*(?:\r?\n)+$/, '')
  }

  const lineMatch = content.match(/(?:^|\n)(tool\s+[a-z_]+(?:\s+\S[^\n]*)?)$/i)
  if (lineMatch && lineMatch.index !== undefined) {
    const start = lineMatch.index === 0 ? 0 : lineMatch.index + 1
    return content.slice(0, start).replace(/[ \t]*(?:\r?\n)+$/, '')
  }

  // Hide a trailing bare `tool` / `tool ` prefix still being typed into the text channel.
  const bareMatch = content.match(/(?:^|\n)(tool\s*)$/i)
  if (bareMatch && bareMatch.index !== undefined) {
    const start = bareMatch.index === 0 ? 0 : bareMatch.index + 1
    return content.slice(0, start).replace(/[ \t]*(?:\r?\n)+$/, '')
  }

  // Incomplete DSML: open tag without `>`, or open tool_calls/invoke without close.
  const dsmlStart = content.search(DSML_OPEN_RE)
  if (dsmlStart >= 0) {
    const fromTag = content.slice(dsmlStart)
    const tagEnd = fromTag.indexOf('>')
    if (tagEnd < 0) {
      return content.slice(0, dsmlStart).replace(/[ \t]*(?:\r?\n)+$/, '')
    }
    const openTag = fromTag.slice(0, tagEnd + 1)
    const isToolCalls = new RegExp(
      String.raw`^<${DSML_MARK}(?:tool_calls|function_calls)\s*>`,
      'i'
    ).test(openTag)
    const isInvoke = new RegExp(String.raw`^<${DSML_MARK}invoke\b`, 'i').test(openTag)
    const isParameter = new RegExp(String.raw`^<${DSML_MARK}parameter\b`, 'i').test(openTag)
    if (isToolCalls || isInvoke || isParameter) {
      const closeRe = isToolCalls
        ? new RegExp(String.raw`</${DSML_MARK}(?:tool_calls|function_calls)\s*>`, 'i')
        : isInvoke
          ? new RegExp(String.raw`</${DSML_MARK}invoke\s*>`, 'i')
          : new RegExp(String.raw`</${DSML_MARK}parameter\s*>`, 'i')
      if (!closeRe.test(fromTag)) {
        return content.slice(0, dsmlStart).replace(/[ \t]*(?:\r?\n)+$/, '')
      }
    }
  }

  // Trailing partial DSML opener: `<｜`, `<|DS`, `<｜DSML｜inv`…
  const partialOpen = content.search(
    new RegExp(String.raw`<(?:/)?(?:(?:\uFF5C|\|)(?:D(?:S(?:M(?:L(?:(?:\uFF5C|\|)[^>\n]*)?)?)?)?)?)?$`, 'i')
  )
  if (partialOpen >= 0 && !content.slice(partialOpen).includes('>')) {
    return content.slice(0, partialOpen).replace(/[ \t]*(?:\r?\n)+$/, '')
  }

  return content
}

function stripToolShapedAssistantTextInner(content: string, options?: { trim?: boolean }): string {
  if (!content) return content
  const withoutDsml = stripDsmlToolMarkup(content)
  let result = ''
  let i = 0
  while (i < withoutDsml.length) {
    const rest = withoutDsml.slice(i)
    const jsonMatch = rest.match(/^(\s*)tool\s*\{/)
    if (jsonMatch) {
      i += jsonMatch[0].length
      let depth = 1
      while (i < withoutDsml.length && depth > 0) {
        const ch = withoutDsml[i]!
        i += 1
        if (ch === '{') depth += 1
        else if (ch === '}') depth -= 1
      }
      while (i < withoutDsml.length && (withoutDsml[i] === ' ' || withoutDsml[i] === '\t')) i += 1
      if (withoutDsml[i] === '\r') i += 1
      if (withoutDsml[i] === '\n') i += 1
      continue
    }

    const atLineStart = i === 0 || withoutDsml[i - 1] === '\n'
    if (atLineStart) {
      const lineMatch = rest.match(/^tool\s+([a-z_]+)\s+(\S.+?)(?:\r?\n|$)/i)
      if (lineMatch) {
        i += lineMatch[0].length
        continue
      }
    }

    result += withoutDsml[i]!
    i += 1
  }
  const collapsed = result.replace(/\n{3,}/g, '\n\n')
  return options?.trim === false ? collapsed : collapsed.trim()
}

/**
 * Drop model-emitted pseudo tool calls that leaked into the text channel
 * (e.g. `tool {"edits":[...]}` or DeepSeek `<｜DSML｜tool_calls>` blocks)
 * so they do not render as plain transcript text.
 */
export function stripToolShapedAssistantText(content: string): string {
  return stripToolShapedAssistantTextInner(content, { trim: true })
}

/** Like stripToolShapedAssistantText but also hides in-progress tool blobs while streaming. */
export function stripToolShapedAssistantTextForStream(content: string): string {
  if (!content) return content
  return stripToolShapedAssistantTextInner(stripIncompleteToolPrefix(content), { trim: false })
}

/** Scrub leaked tool text from any assistant rows still marked streaming. */
export function scrubStreamingAssistantToolLeak(items: UiItem[]): UiItem[] {
  let changed = false
  const next = items.map((item) => {
    if (item.kind !== 'message' || item.role !== 'assistant' || item.streaming !== true) {
      return item
    }
    const content = stripToolShapedAssistantTextForStream(item.content)
    if (content === item.content) return item
    changed = true
    return { ...item, content }
  })
  return changed ? next : items
}

/** Provider snapshot replaces streamed deltas; empty snapshot keeps the buffer. */
export function applyThinkingSnapshot(
  previous: string | undefined,
  snapshot: string | undefined
): string | undefined {
  if (snapshot?.trim()) return snapshot
  return previous
}

/** Rebuild chat UI items from persisted messages (includes tool rows). */
export function messagesToUiItems(messages: ChatMessage[]): UiItem[] {
  const items: UiItem[] = []
  const pendingCalls = new Map<string, { name: string; arguments: string }>()
  // Empty toolCallIds (legacy DeepSeek bug) are paired in message order.
  const emptyIdQueue: string[] = []
  let emptyIdSeq = 0

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'user') {
      // Loop-injected protocol turns (goal continue, plan nudge) are not user
      // prompts — they must never appear as chat bubbles. Item ids keep the raw
      // message index so edit/revert index mapping stays aligned with disk.
      if (m.synthetic) continue
      const images = contentImages(m.content)
      const attachments = uiAttachments(m.content)
      const display = contentDisplayText(m.content)
      items.push({
        kind: 'message',
        id: messageUiId('user', i),
        role: 'user',
        content: display,
        images: images.length ? images : undefined,
        attachments: attachments.length ? attachments : undefined,
        ...(m.at ? { at: m.at } : {})
      })
      continue
    }

    if (m.role === 'assistant') {
      const text = contentDisplayText(m.content)
      // New transcripts carry reasoning only inside reasoningState; derive the
      // display view so hydration matches what live streaming showed.
      const thinking =
        m.thinking || thinkingFromReasoningState(parseProviderReasoningState(m.reasoningState))
      // Each step keeps its own reasoning, right above the calls it explains.
      // Pooling a turn's steps into one row buries the work under a wall of text.
      if (text || thinking) {
        items.push({
          kind: 'message',
          id: messageUiId('assistant', i),
          role: 'assistant',
          content: stripToolShapedAssistantText(text),
          thinking
        })
      }
      if (m.toolCalls?.length) {
        for (let ti = 0; ti < m.toolCalls.length; ti++) {
          const tc = m.toolCalls[ti]!
          const id = tc.id?.trim() || `empty-tool-${emptyIdSeq++}`
          if (!tc.id?.trim()) emptyIdQueue.push(id)
          pendingCalls.set(id, { name: tc.name, arguments: tc.arguments })
          const summary = summarizeToolArgs(tc.name, tc.arguments)
          items.push({
            kind: 'tool',
            id,
            tool: {
              id,
              name: tc.name,
              summary,
              status: 'running',
              argsPreview: uiArgsPreview(tc.name, tc.arguments || undefined)
            }
          })
        }
      }
      continue
    }

    if (m.role === 'tool') {
      const rawId = m.toolCallId?.trim()
      const id = rawId || emptyIdQueue.shift() || `tool-${i}`
      const pending = pendingCalls.get(id)
      const name = m.toolName ?? pending?.name ?? 'tool'
      const summary = summarizeToolArgs(name, pending?.arguments)
      const content = toolContentText(m.content)
      const row: Extract<UiItem, { kind: 'tool' }> = {
        kind: 'tool',
        id,
        tool: {
          id,
          name,
          summary,
          status: inferToolStatus(m.content, m.ok),
          content,
          contentTruncated: m.contentTruncated,
          argsPreview: uiArgsPreview(name, pending?.arguments || undefined)
        }
      }
      const existingIdx = items.findIndex((item) => item.kind === 'tool' && item.id === id)
      if (existingIdx >= 0) {
        items[existingIdx] = row
      } else {
        items.push(row)
      }
      pendingCalls.delete(id)
    }
  }

  return items
}

/**
 * Rebuild in-progress tool chrome from persisted live snapshots when messages
 * do not yet include those tool_calls (mid-stream reattach / remount).
 */
export function applyPersistedLiveTools(items: UiItem[], events: PersistedEvent[]): UiItem[] {
  if (!events.length) return items
  const existing = new Set(
    items.filter((item): item is Extract<UiItem, { kind: 'tool' }> => item.kind === 'tool').map((item) => item.id)
  )
  const live = new Map<
    string,
    { at: string; name: string; arguments: string; startSummary?: string }
  >()

  for (const row of events) {
    if (!isAgentEvent(row.event)) continue
    const event = row.event
    if (event.type === 'stream_reset') {
      // Drop provisional chrome from a failed stream attempt.
      live.clear()
      continue
    }
    if (event.type === 'tool_call_delta') {
      if (existing.has(event.toolCallId)) continue
      const current = live.get(event.toolCallId)
      const name =
        event.name && event.name !== 'tool' ? event.name : current?.name ?? ''
      live.set(event.toolCallId, {
        at: current?.at ?? row.at,
        name,
        arguments: `${current?.arguments ?? ''}${event.argumentsDelta}`
      })
      continue
    }
    if (event.type === 'tool_start') {
      if (existing.has(event.toolCallId)) continue
      const current = live.get(event.toolCallId)
      live.set(event.toolCallId, {
        at: current?.at ?? row.at,
        name: event.name,
        arguments: current?.arguments ?? '',
        startSummary: event.summary
      })
      continue
    }
    if (event.type === 'tool_result') {
      // Settled on disk — do not rebuild spinning chrome for this id.
      live.delete(event.toolCallId)
      continue
    }
    if (event.type === 'assistant_message') {
      // Inner-retry / validation drops emit assistant_message without the
      // provisional tool_calls — mirror live pruneOrphanDeltaToolRows.
      const keep = new Set((event.toolCalls ?? []).map((tc) => tc.id))
      for (const id of live.keys()) {
        if (!keep.has(id)) live.delete(id)
      }
    }
  }

  const extras: UiItem[] = [...live.entries()]
    .filter(([, value]) => Boolean(value.name))
    .map(([id, value]) => ({
      kind: 'tool',
      id,
      at: value.at,
      tool: {
        id,
        name: value.name,
        summary: value.startSummary ?? summarizeToolArgs(value.name, value.arguments),
        status: 'running',
        argsPreview: uiArgsPreview(value.name, value.arguments || undefined)
      }
    }))
  return extras.length ? [...items, ...extras] : items
}

function toolResultOk(events: PersistedEvent[]): Map<string, boolean> {
  const out = new Map<string, boolean>()
  for (const row of events) {
    if (!isAgentEvent(row.event)) continue
    if (row.event.type !== 'tool_result') continue
    const id = row.event.toolCallId
    if (!id) continue
    out.set(id, row.event.ok)
  }
  return out
}

function reconstructGroupTiming(items: UiItem[], events: PersistedEvent[]): UiItem[] {
  const startById = new Map<string, string>()
  const endById = new Map<string, string>()
  const itemIds = new Set(
    items.filter((item): item is Extract<UiItem, { kind: 'tool' }> => item.kind === 'tool').map((item) => item.id)
  )
  for (const row of events) {
    if (!isAgentEvent(row.event)) continue
    if (row.event.type === 'tool_start') {
      const id = row.event.toolCallId
      if (!id || !itemIds.has(id) || startById.has(id)) continue
      startById.set(id, row.at)
    }
    if (row.event.type === 'tool_result') {
      const id = row.event.toolCallId
      if (!id || !itemIds.has(id) || endById.has(id)) continue
      endById.set(id, row.at)
    }
  }

  const out = [...items]
  let i = 0
  while (i < out.length) {
    if (out[i].kind !== 'tool') {
      i++
      continue
    }
    const groupStart = i
    while (i < out.length && out[i].kind === 'tool') i++
    const first = out[groupStart] as Extract<UiItem, { kind: 'tool' }>
    const last = out[i - 1] as Extract<UiItem, { kind: 'tool' }>
    const startedAt = startById.get(first.id)
    const endedAt = endById.get(last.id)
    if (startedAt) {
      const startedMs = new Date(startedAt).getTime()
      const endedMs = endedAt ? new Date(endedAt).getTime() : undefined
      if (!Number.isNaN(startedMs)) {
        out[groupStart] = {
          ...first,
          groupTiming: {
            startedAt: startedMs,
            ...(endedMs !== undefined && !Number.isNaN(endedMs) ? { endedAt: endedMs } : {})
          }
        }
      }
    }
  }
  return out
}

/** Tail cap for live + replayed tool progress lines. */
export const MAX_TOOL_PROGRESS_ENTRIES = 200

function applyToolProgressUpdates(items: UiItem[], events: PersistedEvent[]): UiItem[] {
  const out = [...items]
  for (const row of events) {
    if (!isAgentEvent(row.event)) continue
    if (row.event.type !== 'tool_progress') continue
    const parentToolCallId = row.event.parentToolCallId
    const idx = out.findIndex((item) => item.kind === 'tool' && item.id === parentToolCallId)
    if (idx < 0) continue
    const item = out[idx]
    if (item.kind !== 'tool') continue
    const entries = [
      ...(item.toolProgress ?? []),
      { kind: row.event.kind, text: row.event.text }
    ]
    out[idx] = { ...item, toolProgress: entries.slice(-MAX_TOOL_PROGRESS_ENTRIES) }
  }
  return out
}

/** Attach ISO timestamps from persisted events.jsonl rows where available. */
export function applyEventTimestamps(items: UiItem[], events: PersistedEvent[]): UiItem[] {
  if (!events.length) return items
  const itemIds = new Set(
    items.filter((item): item is Extract<UiItem, { kind: 'tool' }> => item.kind === 'tool').map((item) => item.id)
  )
  const startAtById = new Map<string, string>()
  let runStartAt: string | undefined
  let runDoneAt: string | undefined
  let lastTerminal: 'done' | 'cancelled' | 'error' | null = null
  const extraUserStartAts: string[] = []
  const allAssistantMessageAts: string[] = []
  const visibleAssistantMessageAts: string[] = []

  for (const row of events) {
    if (!isAgentEvent(row.event)) continue
    if (row.event.type === 'status') {
      if (row.event.status === 'running') {
        if (!runStartAt) runStartAt = row.at
        else if (lastTerminal === 'done' || lastTerminal === 'error') {
          extraUserStartAts.push(row.at)
          lastTerminal = null
        }
      } else if (
        row.event.status === 'done' ||
        row.event.status === 'error' ||
        row.event.status === 'cancelled'
      ) {
        runDoneAt = row.at
        lastTerminal = row.event.status
      }
    }
    if (row.event.type === 'follow_up_applied') {
      const appliedUsers = row.event.messages.filter((message) => message.role === 'user')
      const count = appliedUsers.length || row.event.ids.length
      for (let i = 0; i < count; i++) extraUserStartAts.push(row.at)
    }
    if (row.event.type === 'assistant_message') {
      allAssistantMessageAts.push(row.at)
      if (row.event.content || row.event.thinking) {
        visibleAssistantMessageAts.push(row.at)
      }
    }
    if (row.event.type !== 'tool_start') continue
    const id = row.event.toolCallId
    if (!id || !itemIds.has(id) || startAtById.has(id)) continue
    startAtById.set(id, row.at)
  }
  const okById = toolResultOk(events)

  const withMeta = items.map((item) => {
    if (item.kind !== 'tool') return item
    const startAt = startAtById.get(item.id)
    const ok = okById.get(item.id)
    const withAt = startAt ? { ...item, at: startAt } : item
    if (ok === undefined) return withAt
    return {
      ...withAt,
      tool: {
        ...withAt.tool,
        status: ok ? ('done' as const) : ('fail' as const)
      }
    }
  })

  const withTools = reconstructGroupTiming(withMeta, events)
  const messageAtById = messageTimestampsFromEvents(withTools, {
    runStartAt,
    runDoneAt,
    extraUserStartAts,
    allAssistantMessageAts,
    visibleAssistantMessageAts
  })

  const withMessages = withTools.map((item) => {
    if (item.kind !== 'message') return item
    if (item.role === 'user' && item.at) return item
    const at = messageAtById.get(item.id)
    return at ? { ...item, at } : item
  })
  return applyToolProgressUpdates(withMessages, events)
}

function compactionUiItemFromEvent(
  row: PersistedEvent,
  index: number
): Extract<UiItem, { kind: 'compaction' }> | null {
  if (!isAgentEvent(row.event)) return null
  if (row.event.type === 'compaction') {
    const summary = row.event.summary.trim()
    if (!summary) return null
    return {
      kind: 'compaction',
      id: `compaction:${row.at}:${index}`,
      summary,
      ...(typeof row.event.tokenEstimate === 'number'
        ? { tokenEstimate: row.event.tokenEstimate }
        : {}),
      at: row.at,
      verifyStatus:
        row.event.verified === true
          ? 'verified'
          : row.event.verified === false
            ? 'failed'
            : undefined,
      ...(row.event.verifyCoverage != null ? { verifyCoverage: row.event.verifyCoverage } : {}),
      ...(row.event.verifyFailures && row.event.verifyFailures.length > 0
        ? { verifyFailures: row.event.verifyFailures }
        : {})
    }
  }
  if (row.event.type === 'compaction_verify_failed') {
    const summary = row.event.summary?.trim() || 'Summary failed verification and was not applied.'
    return {
      kind: 'compaction',
      id: `compaction:${row.at}:${index}`,
      summary,
      ...(typeof row.event.tokenEstimate === 'number'
        ? { tokenEstimate: row.event.tokenEstimate }
        : {}),
      at: row.at,
      verifyStatus: 'failed',
      verifyFailures: row.event.failures
    }
  }
  return null
}

export function weaveCompactionItems(
  items: UiItem[],
  extras: Extract<UiItem, { kind: 'compaction' }>[]
): UiItem[] {
  if (extras.length === 0) return items
  if (items.length === 0) return extras
  const out = [...items]
  for (const extra of extras) {
    const extraMs = extra.at ? Date.parse(extra.at) : Number.NaN
    if (Number.isNaN(extraMs)) {
      out.push(extra)
      continue
    }
    let insertAt = out.length
    for (let i = 0; i < out.length; i++) {
      const at = out[i]?.at
      if (!at) continue
      const ms = Date.parse(at)
      if (Number.isNaN(ms)) continue
      if (ms > extraMs) {
        insertAt = i
        break
      }
      insertAt = i + 1
    }
    out.splice(insertAt, 0, extra)
  }
  return out
}

function compactionItemsMatch(
  row: UiItem,
  extra: Extract<UiItem, { kind: 'compaction' }>
): boolean {
  if (row.kind !== 'compaction') return false
  if (
    (row.verifyStatus === 'failed' || row.verifyStatus === 'verified') &&
    (extra.verifyStatus === 'failed' || extra.verifyStatus === 'verified') &&
    row.verifyStatus !== extra.verifyStatus
  ) {
    return false
  }
  if (row.id === extra.id) return true
  if (row.at && extra.at) return row.at === extra.at && row.summary === extra.summary
  return !row.at && !extra.at && row.summary === extra.summary
}

/** Insert one live/manual fold summary in timestamp order (no duplicate). */
export function insertCompactionItem(
  items: UiItem[],
  extra: Extract<UiItem, { kind: 'compaction' }>
): UiItem[] {
  if (items.some((row) => compactionItemsMatch(row, extra))) return items
  return weaveCompactionItems(
    items.filter((item) => item.kind !== 'compaction' || item.id !== extra.id),
    [extra]
  )
}

/** Insert persisted compaction summaries into the transcript in event order. */
export function applyCompactionItems(items: UiItem[], events: PersistedEvent[]): UiItem[] {
  const extras: Extract<UiItem, { kind: 'compaction' }>[] = []
  for (let i = 0; i < events.length; i++) {
    const row = events[i]
    if (!row) continue
    const item = compactionUiItemFromEvent(row, i)
    if (item) extras.push(item)
  }
  const base = items.filter((item) => item.kind !== 'compaction')
  if (extras.length === 0) return base
  return weaveCompactionItems(base, extras)
}

function messageTimestampsFromEvents(
  items: UiItem[],
  meta: {
    runStartAt?: string
    runDoneAt?: string
    extraUserStartAts: string[]
    allAssistantMessageAts: string[]
    visibleAssistantMessageAts: string[]
  }
): Map<string, string> {
  const out = new Map<string, string>()
  let assistantEventIdx = 0
  let visibleAssistantEventIdx = 0
  let extraUserIdx = 0
  let seenUser = false
  let turnHasVisibleAssistant = false

  for (const item of items) {
    if (item.kind === 'message' && item.role === 'user') {
      if (!out.has(item.id)) {
        if (item.at) {
          out.set(item.id, item.at)
        } else if (!seenUser && meta.runStartAt) {
          out.set(item.id, meta.runStartAt)
        } else if (seenUser && extraUserIdx < meta.extraUserStartAts.length) {
          out.set(item.id, meta.extraUserStartAts[extraUserIdx]!)
          extraUserIdx += 1
        }
      }
      seenUser = true
      turnHasVisibleAssistant = false
      continue
    }

    if (item.kind === 'message' && item.role === 'assistant' && (item.content || item.thinking)) {
      if (!turnHasVisibleAssistant && assistantEventIdx < meta.allAssistantMessageAts.length) {
        assistantEventIdx += 1
        turnHasVisibleAssistant = true
      } else if (turnHasVisibleAssistant && assistantEventIdx < meta.allAssistantMessageAts.length) {
        assistantEventIdx += 1
      }
      if (visibleAssistantEventIdx < meta.visibleAssistantMessageAts.length) {
        out.set(item.id, meta.visibleAssistantMessageAts[visibleAssistantEventIdx]!)
        visibleAssistantEventIdx += 1
      }
      continue
    }

    if (item.kind === 'tool') {
      if (!turnHasVisibleAssistant && assistantEventIdx < meta.allAssistantMessageAts.length) {
        assistantEventIdx += 1
        turnHasVisibleAssistant = true
      }
    }
  }

  const assistantItems = items.filter(
    (item): item is AssistantMessageItem =>
      item.kind === 'message' &&
      item.role === 'assistant' &&
      Boolean(item.content || item.thinking)
  )
  for (let i = 0; i < assistantItems.length; i++) {
    const item = assistantItems[i]!
    if (out.has(item.id)) continue
    if (visibleAssistantEventIdx < meta.visibleAssistantMessageAts.length) {
      out.set(item.id, meta.visibleAssistantMessageAts[visibleAssistantEventIdx]!)
      visibleAssistantEventIdx += 1
      continue
    }
    const itemIndex = items.findIndex((entry) => entry.id === item.id)
    const nextTool = items
      .slice(itemIndex + 1)
      .find((entry): entry is Extract<UiItem, { kind: 'tool' }> => entry.kind === 'tool')
    if (nextTool?.at) {
      out.set(item.id, nextTool.at)
      continue
    }
    if (i === assistantItems.length - 1 && meta.runDoneAt) {
      out.set(item.id, meta.runDoneAt)
    }
  }

  return out
}

export type TerminalRunStatus = 'done' | 'cancelled' | 'error'

/** UI outcome for the latest turn, including a run recovered after a crash. */
export type TurnOutcome = TerminalRunStatus | 'interrupted'

/** Last persisted run status event, if any. */
export function lastPersistedRunStatus(
  events: PersistedEvent[]
): 'running' | TerminalRunStatus | null {
  let lastAt = ''
  let status: 'running' | TerminalRunStatus | null = null
  for (const row of events) {
    if (!isAgentEvent(row.event)) continue
    if (row.event.type !== 'status') continue
    if (row.at < lastAt) continue
    lastAt = row.at
    status = row.event.status
  }
  return status
}

function interruptedToolContent(
  status: TerminalRunStatus,
  events?: PersistedEvent[]
): string {
  if (status === 'error') {
    for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
      const event = events?.[i]?.event
      if (!isAgentEvent(event)) continue
      if (event.type === 'incomplete' && isRetryableTurnFailure({ incompleteReason: event.reason })) {
        return event.reason === 'circuit_open' ? 'Temporarily paused' : 'Connection lost'
      }
    }
    return 'Interrupted'
  }
  switch (status) {
    case 'cancelled':
      return 'Cancelled'
    case 'done':
      return 'Not completed'
    default: {
      const _exhaustive: never = status
      return _exhaustive
    }
  }
}

function closeOpenGroupTimingsOnHydrate(items: UiItem[], endedAt: number): UiItem[] {
  const out = [...items]
  let index = 0
  while (index < out.length) {
    if (out[index]?.kind !== 'tool') {
      index += 1
      continue
    }
    const groupStart = index
    while (index < out.length && out[index]?.kind === 'tool') index += 1
    const first = out[groupStart]
    if (first?.kind !== 'tool') continue
    if (!first.groupTiming || first.groupTiming.endedAt != null) continue
    out[groupStart] = {
      ...first,
      groupTiming: { startedAt: first.groupTiming.startedAt, endedAt }
    }
  }
  return out
}

/** Tool call ids that reached execution (`tool_start` on disk). */
export function toolCallIdsWithStart(events: PersistedEvent[]): Set<string> {
  const out = new Set<string>()
  for (const row of events) {
    const event = row.event
    if (!event || typeof event !== 'object' || !('type' in event)) continue
    if ((event as { type: string }).type !== 'tool_start') continue
    const id = (event as { toolCallId?: string }).toolCallId
    if (typeof id === 'string' && id) out.add(id)
  }
  return out
}

/** Drop provisional delta chrome that never reached `tool_start`. */
export function dropNeverStartedRunningTools(
  items: UiItem[],
  startedIds: Set<string>
): UiItem[] {
  let changed = false
  const next = items.filter((item) => {
    if (item.kind !== 'tool' || item.tool.status !== 'running') return true
    if (startedIds.has(item.id) || startedIds.has(item.tool.id)) return true
    changed = true
    return false
  })
  return changed ? next : items
}

/**
 * After a terminal run is reloaded from disk, close any tool rows still marked
 * `running` because crash interrupt never wrote matching tool_result rows.
 *
 * When the process is gone but disk still says `running`, pass
 * `treatRunningAs` (usually `cancelled`) so idle hydrate does not leave
 * spinning tool chrome until stale-run reconciliation.
 */
export function finalizeHydratedTranscript(
  items: UiItem[],
  events: PersistedEvent[],
  opts?: { treatRunningAs?: TerminalRunStatus }
): UiItem[] {
  let lastStatus = lastPersistedRunStatus(events)
  if (lastStatus === 'running' && opts?.treatRunningAs) {
    lastStatus = opts.treatRunningAs
  }
  if (!lastStatus || lastStatus === 'running') return items

  const stub = interruptedToolContent(lastStatus, events)
  let endedAt = Date.now()
  for (const row of events) {
    if (!isAgentEvent(row.event)) continue
    if (row.event.type !== 'status') continue
    if (row.event.status !== lastStatus) continue
    const ms = new Date(row.at).getTime()
    if (!Number.isNaN(ms)) endedAt = ms
  }

  const startedIds = toolCallIdsWithStart(events)
  const scrubbed = dropNeverStartedRunningTools(items, startedIds)

  const finalized = scrubbed.map((item) => {
    if (item.kind === 'message') {
      if (!item.streaming && !item.thinkingStreaming) return item
      return {
        ...item,
        streaming: false,
        thinkingStreaming: false
      }
    }
    if (item.kind !== 'tool') return item

    let tool = item.tool
    if (tool.status === 'running') {
      tool = {
        ...tool,
        status: 'fail' as const,
        content: tool.content ?? stub
      }
    }
    if (
      tool.name === 'todo_write' &&
      tool.content &&
      (lastStatus === 'done' || lastStatus === 'error' || lastStatus === 'cancelled')
    ) {
      const content = finalizeTodoContentOnRunEnd(tool.content, lastStatus)
      if (content !== tool.content) tool = { ...tool, content }
    }

    if (tool === item.tool) return item
    return { ...item, tool }
  })

  return closeOpenGroupTimingsOnHydrate(finalized, endedAt)
}
