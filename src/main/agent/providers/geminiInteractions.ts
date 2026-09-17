import type { ChatMessage } from '../../../shared/ipc'
import { contentToText, providerContentParts } from '../../../shared/ipc'
import { formatError } from '../../../shared/errors'
import { wireToolCallArguments, mergeOpenAiCompatToolArgDelta } from '../toolArgWire'
import { mergeStreamedToolName } from '../../../shared/utils/toolName'
import {
  continuationPromptKeys,
  rememberContinuationPrompt,
  stablePromptKey
} from './promptKeys'
import {
  normalizeEffortForGeminiInteractions,
  statefulContinuationMessages,
  type ProviderReasoningState
} from '../../../shared/reasoning'
import type { ProviderChatRequest, StopReason, StreamChunk, ToolCall, TokenUsage } from './types'
import { billedCostFromUsage } from './usageFields'
import { normalizeStopReason } from './stopReason'
import { iterateSseJson } from './sse'
import { logProviderFailure, providerFetchFailureChunk } from './log'
import { CHAT_FETCH_MAX_ATTEMPTS, fetchWithRetry } from './fetchWithRetry'
import { formatProviderHttpError } from './httpErrors'
import { parseDataUrl } from './normalize'
import { resolveSystemZones, volatileSessionMessage } from './systemZones'

export function serializeToolArgs(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** Best-effort mime from a remote image URL path (Interactions ImageContent.mime_type). */
function mimeFromImageUrl(url: string): string | undefined {
  const path = url.split(/[?#]/, 1)[0]?.toLowerCase() ?? ''
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
  if (path.endsWith('.webp')) return 'image/webp'
  if (path.endsWith('.gif')) return 'image/gif'
  if (path.endsWith('.bmp')) return 'image/bmp'
  if (path.endsWith('.tif') || path.endsWith('.tiff')) return 'image/tiff'
  if (path.endsWith('.heic')) return 'image/heic'
  if (path.endsWith('.heif')) return 'image/heif'
  return undefined
}

/**
 * Map a composer image URL to Interactions API ImageContent
 * (`type: "image"` + `data` or `uri`). See:
 * https://ai.google.dev/gemini-api/docs/interactions/image-understanding
 */
function imageContentFromUrl(url: string): Record<string, unknown> | null {
  const data = parseDataUrl(url)
  if (data) {
    return { type: 'image', data: data.data, mime_type: data.mediaType }
  }
  // Public https(s) URLs and Files API URIs (also https) use ImageContent.uri.
  if (/^https?:\/\//i.test(url)) {
    const mime = mimeFromImageUrl(url)
    return mime ? { type: 'image', uri: url, mime_type: mime } : { type: 'image', uri: url }
  }
  return null
}

export function toInteractionsInput(
  messages: ChatMessage[],
  system: string | undefined,
  continuing: boolean,
  opts?: { systemStable?: string; systemVolatile?: string }
): string | Array<Record<string, unknown>> {
  const source = continuing ? statefulContinuationMessages(messages) : messages
  const zones = resolveSystemZones({
    system,
    systemStable: opts?.systemStable,
    systemVolatile: opts?.systemVolatile
  })
  const parts: Array<Record<string, unknown>> = []
  if (!continuing && zones.stable) parts.push({ type: 'text', text: zones.stable })

  for (const m of source) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        parts.push({ type: 'text', text: m.content })
        continue
      }
      // Flattening to text here would drop rich attachments.
      for (const part of providerContentParts(m.content, {
        image: true,
        audio: true,
        fileNative: true
      })) {
        if (part.type === 'text') {
          if (part.text) parts.push({ type: 'text', text: part.text })
          continue
        }
        if (part.type === 'file_native') {
          parts.push({
            type: 'document',
            data: part.data,
            mime_type: part.mime || 'application/pdf'
          })
          continue
        }
        if (part.type === 'audio') {
          const data = parseDataUrl(part.url)
          if (data) {
            parts.push({
              type: 'audio',
              data: data.data,
              mime_type: data.mediaType || part.mime || 'audio/mpeg'
            })
          } else {
            parts.push({
              type: 'text',
              text: '[audio omitted: Gemini Interactions requires a base64 data URL]'
            })
          }
          continue
        }
        const image = imageContentFromUrl(part.url)
        if (image) {
          parts.push(image)
        } else {
          parts.push({
            type: 'text',
            text: '[image omitted: Gemini Interactions requires a base64 data URL or http(s) image URI]'
          })
        }
      }
    } else if (m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content : contentToText(m.content)
      if (text) parts.push({ type: 'text', text })
      // Replay tool calls so the function_responses that follow aren't orphaned
      // when a full history is sent without previous_interaction_id.
      for (const tc of m.toolCalls ?? []) {
        let args: unknown = {}
        try {
          args = JSON.parse(wireToolCallArguments(tc.name, tc.arguments || '{}'))
        } catch {
          args = { raw: tc.arguments }
        }
        parts.push({
          type: 'function_call',
          function_call: { id: tc.id, name: tc.name, args }
        })
      }
    } else if (m.role === 'tool') {
      // Native function responses keep the tool loop intelligible to the model;
      // a `[tool:name] ...` text blob reads as user input on the next turn.
      parts.push({
        type: 'function_response',
        function_response: {
          id: m.toolCallId,
          name: m.toolName ?? 'tool',
          response: {
            output: typeof m.content === 'string' ? m.content : contentToText(m.content)
          }
        }
      })
    }
  }

  if (zones.volatile) {
    parts.push({ type: 'text', text: volatileSessionMessage(zones.volatile).content })
  }

  if (parts.length === 1 && parts[0].type === 'text') return String(parts[0].text)
  return parts
}

function toInteractionsTools(tools: ProviderChatRequest['tools']): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }))
}

/** Stream chat via Gemini Interactions API for thinking models. */
export async function* streamGeminiInteractions(
  req: ProviderChatRequest
): AsyncGenerator<StreamChunk> {
  if (!req.apiKey) {
    yield { type: 'error', error: 'Gemini API key not set' }
    return
  }

  const candidatePriorState =
    req.reasoningState?.kind === 'gemini_interactions' ? req.reasoningState : undefined
  const promptKey = stablePromptKey(req)
  const priorState =
    candidatePriorState?.interactionId &&
    (promptKey === undefined ||
      continuationPromptKeys.get(candidatePriorState.interactionId) === promptKey)
      ? candidatePriorState
      : undefined
  const continuing = Boolean(priorState?.interactionId)

  const body: Record<string, unknown> = {
    model: req.model,
    input: toInteractionsInput(req.messages, req.system, continuing, {
      systemStable: req.systemStable,
      systemVolatile: req.systemVolatile
    }),
    stream: true,
    store: true
  }

  // Omitted thinking means off.
  if (req.thinking?.enabled === true) {
    body.generation_config = {
      thinking_summaries: 'auto',
      thinking_level: normalizeEffortForGeminiInteractions(req.thinking?.effort)
    }
  }

  if (req.tools.length) {
    body.tools = toInteractionsTools(req.tools)
    body.tool_choice = req.toolChoice ?? 'auto'
  }
  if (priorState?.interactionId) body.previous_interaction_id = priorState.interactionId

  const url = 'https://generativelanguage.googleapis.com/v1beta/interactions'
  let res: Response
  try {
    res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': req.apiKey
        },
        signal: req.signal,
        body: JSON.stringify(body)
      },
      { maxAttempts: CHAT_FETCH_MAX_ATTEMPTS }
    )
  } catch (err) {
    if (req.signal.aborted) throw err
    yield providerFetchFailureChunk('gemini', err)
    return
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    logProviderFailure('gemini', 'http', { status: res.status })
    yield { type: 'error', error: formatProviderHttpError(res.status, text, 'gemini'), errorCode: 'PROVIDER_HTTP', httpStatus: res.status }
    return
  }

  let interactionId: string | undefined = priorState?.interactionId
  const thoughtSteps: unknown[] = []
  const pending = new Map<string, ToolCall>()
  let thinkingText = ''
  let lastUsage: TokenUsage | undefined
  let stopReason: StopReason | undefined

  const drops = { dropped: 0 }

  for await (const event of iterateSseJson(res, req.signal, drops)) {
    const eventType = event.event_type as string | undefined
    const interaction = event.interaction as Record<string, unknown> | undefined
    if (interaction && typeof interaction.id === 'string') interactionId = interaction.id

    if (eventType === 'step.delta') {
      const delta = event.delta as Record<string, unknown> | undefined
      if (!delta) continue
      if (delta.type === 'thought_summary') {
        const content = delta.content as { text?: string } | undefined
        const text = content?.text ?? ''
        if (text) {
          thinkingText += text
          yield { type: 'thinking_delta', text }
        }
      } else if (delta.type === 'text' && typeof delta.text === 'string') {
        yield { type: 'text', text: delta.text }
      } else if (delta.type === 'function_call') {
        const fn = delta.function_call as Record<string, unknown> | undefined
        if (fn) {
          const callId = String(fn.id ?? fn.call_id ?? `call_${pending.size}`)
          // Merge (not replace) so streamed argument fragments accumulate;
          // each delta previously overwrote the pending call and dropped the
          // earlier fragment bytes.
          const existing = pending.get(callId) ?? { id: callId, name: '', arguments: '' }
          if (fn.name) existing.name = mergeStreamedToolName(existing.name, String(fn.name))
          const incoming = serializeToolArgs(fn.args ?? fn.arguments)
          if (incoming) {
            existing.arguments = mergeOpenAiCompatToolArgDelta(existing.arguments, incoming).arguments
          }
          pending.set(callId, existing)
          yield { type: 'tool_call', toolCall: existing }
        }
      }
    }

    if (eventType === 'step.start') {
      const step = event.step as Record<string, unknown> | undefined
      if (step?.type === 'thought') thoughtSteps.push(step)
    }

    if (eventType === 'interaction.completed' || eventType === 'interaction.incomplete') {
      stopReason =
        normalizeStopReason(interaction?.finish_reason) ??
        normalizeStopReason((interaction?.incomplete_details as Record<string, unknown> | undefined)?.reason) ??
        (eventType === 'interaction.incomplete' ? 'unknown' : 'stop')
      const usage = interaction?.usage as Record<string, unknown> | undefined
      if (usage) {
        const cachedInputTokens =
          typeof usage.total_cached_tokens === 'number'
            ? usage.total_cached_tokens
            : typeof usage.totalCachedTokens === 'number'
              ? usage.totalCachedTokens
              : typeof usage.cached_content_token_count === 'number'
                ? usage.cached_content_token_count
                : typeof usage.cachedContentTokenCount === 'number'
                  ? usage.cachedContentTokenCount
                  : typeof usage.cached_input_tokens === 'number'
                    ? usage.cached_input_tokens
                    : typeof usage.cachedInputTokens === 'number'
                      ? usage.cachedInputTokens
                      : undefined
          lastUsage = {
            inputTokens:
              typeof usage.total_input_tokens === 'number' ? usage.total_input_tokens : undefined,
            inputTokensIncludesCache: true,
            outputTokens:
            typeof usage.total_output_tokens === 'number' ? usage.total_output_tokens : undefined,
          totalTokens:
            typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
          cachedInputTokens,
          reasoningTokens:
            typeof usage.total_thought_tokens === 'number' ? usage.total_thought_tokens : undefined,
          ...billedCostFromUsage(usage)
        }
      }
    }
  }

  if (thinkingText) yield { type: 'thinking_done', text: thinkingText }

  const reasoningState: ProviderReasoningState | undefined =
    interactionId || thoughtSteps.length
      ? {
          kind: 'gemini_interactions',
          interactionId,
          thoughtSteps: thoughtSteps.length ? thoughtSteps : undefined
        }
      : undefined

  if (interactionId && promptKey) rememberContinuationPrompt(interactionId, promptKey)

  yield {
    type: 'done',
    usage: lastUsage,
    stopReason,
    ...(drops.dropped > 0 ? { droppedFrames: drops.dropped } : {}),
    reasoningState
  }
}
