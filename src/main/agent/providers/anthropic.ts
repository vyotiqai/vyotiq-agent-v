import type { ChatMessage, MessageContent, ModelInfo } from '../../../shared/ipc'
import { contentToText, providerContentParts } from '../../../shared/ipc'
import { formatError } from '../../../shared/errors'
import type { AnthropicThinkingBlock } from '../../../shared/reasoning'
import { baseModelInfo, parseDataUrl, thinkingPartialFromCatalogRow, wireSupportedInputModalities } from './normalize'
import type {
  LlmProvider,
  ListModelsRequest,
  ProviderChatRequest,
  StopReason,
  StreamChunk,
  ToolCall,
  TokenUsage
} from './types'
import { billedCostFromUsage } from './usageFields'
import { normalizeStopReason } from './stopReason'
import { iterateSseJson } from './sse'
import { logProviderFailure, providerFetchFailureChunk } from './log'
import { CHAT_FETCH_MAX_ATTEMPTS, fetchWithRetry } from './fetchWithRetry'
import { formatProviderHttpError, scrubProviderErrorText } from './httpErrors'
import { anthropicThinkingBlocksFromMessage, anthropicThinkingFields } from './thinkingPolicy'
import { volatileSessionMessage } from './systemZones'
import { wireToolCallArguments } from '../toolArgWire'

function asContentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(content)) return content as Array<Record<string, unknown>>
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return []
}

function mergeContent(a: unknown, b: unknown): Array<Record<string, unknown>> {
  return [...asContentBlocks(a), ...asContentBlocks(b)]
}

function toAnthropicContent(content: MessageContent): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content
  const blocks: Array<Record<string, unknown>> = []
  for (const p of providerContentParts(content, { image: true, fileNative: true, audio: false })) {
    if (p.type === 'text') {
      blocks.push({ type: 'text', text: p.text })
      continue
    }
    if (p.type === 'file_native') {
      blocks.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: p.mime || 'application/pdf',
          data: p.data
        }
      })
      continue
    }
    if (p.type === 'audio') {
      blocks.push({
        type: 'text',
        text: '[audio omitted: Anthropic does not support native audio input]'
      })
      continue
    }
    const data = parseDataUrl(p.url)
    if (data) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: data.mediaType, data: data.data }
      })
    } else {
      blocks.push({
        type: 'image',
        source: { type: 'url', url: p.url }
      })
    }
  }
  return blocks
}

function toAnthropicMessages(messages: ChatMessage[]): {
  system?: string | Array<Record<string, unknown>>
  messages: Array<Record<string, unknown>>
} {
  let systemText: string | undefined
  const out: Array<Record<string, unknown>> = []

  for (const m of messages) {
    if (m.role === 'system') {
      systemText =
        (systemText ? systemText + '\n\n' : '') +
        (typeof m.content === 'string' ? m.content : contentToText(m.content))
      continue
    }
    if (m.role === 'tool') {
      if (!m.toolCallId) continue
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId,
            content: typeof m.content === 'string' ? m.content : contentToText(m.content)
          }
        ]
      })
      continue
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const content: Array<Record<string, unknown>> = []
      const thinkingBlocks = anthropicThinkingBlocksFromMessage(m.reasoningState)
      for (const block of thinkingBlocks) {
        if (block.type === 'thinking' && block.thinking) {
          content.push({ type: 'thinking', thinking: block.thinking })
        } else if (block.type === 'redacted_thinking' && block.data) {
          content.push({ type: 'redacted_thinking', data: block.data })
        }
      }
      const text = typeof m.content === 'string' ? m.content : contentToText(m.content)
      if (text) content.push({ type: 'text', text })
      for (const t of m.toolCalls) {
        let input: unknown = {}
        try {
          input = JSON.parse(wireToolCallArguments(t.name, t.arguments))
        } catch {
          input = {}
        }
        content.push({ type: 'tool_use', id: t.id, name: t.name, input })
      }
      out.push({ role: 'assistant', content })
      continue
    }
    if (m.role === 'assistant') {
      const thinkingBlocks = anthropicThinkingBlocksFromMessage(m.reasoningState)
      if (thinkingBlocks.length) {
        const content: Array<Record<string, unknown>> = []
        for (const block of thinkingBlocks) {
          if (block.type === 'thinking' && block.thinking) {
            content.push({ type: 'thinking', thinking: block.thinking })
          } else if (block.type === 'redacted_thinking' && block.data) {
            content.push({ type: 'redacted_thinking', data: block.data })
          }
        }
        const text = typeof m.content === 'string' ? m.content : contentToText(m.content)
        if (text) content.push({ type: 'text', text })
        out.push({ role: 'assistant', content })
        continue
      }
    }
    out.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: toAnthropicContent(m.content)
    })
  }

  const merged: Array<Record<string, unknown>> = []
  for (const msg of out) {
    const last = merged[merged.length - 1]
    if (last && last.role === msg.role) {
      last.content = mergeContent(last.content, msg.content)
    } else {
      merged.push({ ...msg })
    }
  }

  return { system: systemText, messages: merged }
}

/** Official cache order is tools → system → messages. Last-tool breakpoint keeps the tools prefix when system later changes. */
function toAnthropicTools(tools: ProviderChatRequest['tools']): Array<Record<string, unknown>> {
  return tools.map((t, i) => {
    const def: Record<string, unknown> = {
      name: t.name,
      description: t.description,
      input_schema: t.parameters
    }
    if (i === tools.length - 1) {
      def.cache_control = { type: 'ephemeral' }
    }
    return def
  })
}

function applyCacheControl(
  system: string | { stable: string; volatile: string } | undefined,
  messages: Array<Record<string, unknown>>
): {
  system: Array<Record<string, unknown>> | undefined
  messages: Array<Record<string, unknown>>
} {
  let systemBlocks: Array<Record<string, unknown>> | undefined
  let volatileText: string | undefined
  if (system && typeof system === 'object') {
    systemBlocks = []
    if (system.stable) {
      // Stable prefix only — volatile must not sit in system before messages or it
      // busts the tools→system→history cache prefix every step.
      systemBlocks.push({
        type: 'text',
        text: system.stable,
        cache_control: { type: 'ephemeral' }
      })
    }
    const vol = system.volatile?.trim()
    if (vol) volatileText = vol
    if (!systemBlocks.length) systemBlocks = undefined
  } else if (typeof system === 'string' && system) {
    systemBlocks = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
  }

  // Mark the last cacheable history block, then append volatile after it (OpenAI/Gemini pattern).
  const cloned: Array<Record<string, unknown>> = messages.map((m) => ({ ...m, content: m.content }))
  for (let i = cloned.length - 1; i >= 0; i--) {
    const content = cloned[i].content
    if (Array.isArray(content) && content.length) {
      const last = { ...(content[content.length - 1] as Record<string, unknown>) }
      last.cache_control = { type: 'ephemeral' }
      cloned[i] = {
        ...cloned[i],
        content: [...content.slice(0, -1), last]
      }
      break
    }
    if (typeof content === 'string' && content) {
      cloned[i] = {
        ...cloned[i],
        content: [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }]
      }
      break
    }
  }

  if (volatileText) {
    const vol = volatileSessionMessage(volatileText)
    cloned.push({
      role: 'user',
      content: [{ type: 'text', text: vol.content }]
    })
  }

  return { system: systemBlocks, messages: cloned }
}

function defaultMaxTokens(model: string, hint?: number): number {
  if (hint && hint > 0) return Math.min(hint, 64_000)
  if (/haiku/i.test(model)) return 8192
  if (/opus|fable/i.test(model)) return 16_384
  return 8192
}

function stripAnthropicBetas(header: string, ...fragments: string[]): string | undefined {
  const next = header
    .split(',')
    .map((b) => b.trim())
    .filter((b) => b && !fragments.some((f) => b.includes(f)))
    .join(',')
  return next || undefined
}

/** Retry without unsupported beta features instead of stripping everything on any 400. */
async function postAnthropicMessages(
  baseHeaders: Record<string, string>,
  betas: string[],
  body: Record<string, unknown>,
  signal: AbortSignal,
  messagesUrl = 'https://api.anthropic.com/v1/messages'
): Promise<Response> {
  const url = messagesUrl
  type Attempt = { headers: Record<string, string>; body: Record<string, unknown> }
  const attempts: Attempt[] = []
  const betaStr = betas.join(',')

  const push = (b: Record<string, unknown>, betaHeader?: string) => {
    attempts.push({
      headers: betaHeader ? { ...baseHeaders, 'anthropic-beta': betaHeader } : { ...baseHeaders },
      body: b
    })
  }

  push(body, betaStr || undefined)

  if (body.context_management) {
    const next = { ...body }
    delete next.context_management
    push(next, stripAnthropicBetas(betaStr, 'context-management', 'compact'))
  }

  if (body.output_config) {
    const next = { ...body }
    delete next.output_config
    push(
      next,
      stripAnthropicBetas(betaStr, 'output-config', 'thinking')
    )
  }

  const plain = { ...body }
  delete plain.context_management
  delete plain.output_config
  push(plain)

  const seen = new Set<string>()
  let last: Response | null = null
  for (const attempt of attempts) {
    const key = JSON.stringify(attempt)
    if (seen.has(key)) continue
    seen.add(key)

    // Drain prior failed response before the next fetch (leave final body for caller).
    if (last && !last.bodyUsed) {
      await last.text().catch(() => undefined)
    }

    last = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: attempt.headers,
        signal,
        body: JSON.stringify(attempt.body)
      },
      { maxAttempts: CHAT_FETCH_MAX_ATTEMPTS }
    )
    if (last.ok) return last
    if (last.status === 401 || last.status === 403) return last
  }
  return last!
}

/** Exported for tests — build Anthropic messages request body. */
export function buildAnthropicBody(req: ProviderChatRequest): Record<string, unknown> {
  const converted = toAnthropicMessages(req.messages)
  const systemForCache =
    req.systemStable !== undefined || req.systemVolatile !== undefined
      ? { stable: req.systemStable ?? '', volatile: req.systemVolatile ?? '' }
      : req.system
  const cached = applyCacheControl(systemForCache, converted.messages)
  const tools = toAnthropicTools(req.tools)
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: defaultMaxTokens(req.model, req.maxOutputTokens),
    system: cached.system,
    messages: cached.messages,
    tools: tools.length ? tools : undefined,
    stream: true
  }
  if (req.toolChoice && tools.length) {
    body.tool_choice = {
      type: req.toolChoice === 'required' ? 'any' : req.toolChoice
    }
  }
  if (req.responseFormat) {
    body.output_config = {
      format: {
        type: 'json_schema',
        schema: req.responseFormat.schema
      }
    }
  }
  Object.assign(body, anthropicThinkingFields(req))
  applySampling(body, req)
  return body
}

function applySampling(body: Record<string, unknown>, req: ProviderChatRequest): void {
  if (typeof req.temperature === 'number') body.temperature = req.temperature
  if (req.stop && req.stop.length > 0) body.stop_sequences = req.stop.slice(0, 4)
}

/** OpenAI-compatible-style entry point that posts to a caller-supplied Messages URL. */
export function streamAnthropicMessages(
  req: ProviderChatRequest,
  messagesUrl = 'https://api.anthropic.com/v1/messages',
  extraHeaders?: Record<string, string>
): AsyncGenerator<StreamChunk> {
  // LlmProvider.streamChat is typed with a single argument; anthropic's implementation
  // accepts an optional messages URL and extra headers that callers (e.g. OpenCode Go)
  // supply.
  const stream = anthropicProvider.streamChat as (
    req: ProviderChatRequest,
    messagesUrl?: string,
    extraHeaders?: Record<string, string>
  ) => AsyncGenerator<StreamChunk>
  return stream(req, messagesUrl, extraHeaders)
}

export const anthropicProvider: LlmProvider = {
  id: 'anthropic',
  async listModels(req: ListModelsRequest): Promise<ModelInfo[]> {
    if (!req.apiKey) throw new Error('Anthropic API key not set')
    let res: Response
    try {
      res = await fetchWithRetry(
        'https://api.anthropic.com/v1/models?limit=100',
        {
          method: 'GET',
          headers: {
            'x-api-key': req.apiKey,
            'anthropic-version': '2023-06-01'
          },
          signal: req.signal
        },
        { circuitKey: false }
      )
    } catch (err) {
      if (req.signal?.aborted) throw err
      logProviderFailure('anthropic', 'network', {})
      throw new Error(formatError(err))
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      logProviderFailure('anthropic', 'http', { status: res.status })
      throw new Error(formatProviderHttpError(res.status, text, 'anthropic'))
    }
    const data = (await res.json()) as { data?: Array<Record<string, unknown>> }
    const out: ModelInfo[] = []
    for (const row of data.data ?? []) {
      const id = typeof row.id === 'string' ? row.id : null
      if (!id) continue
      const caps = row.capabilities as Record<string, unknown> | undefined
      const inputMods = Array.isArray(caps?.input_modalities)
        ? (caps.input_modalities as string[])
        : undefined
      const supportsVision =
        caps?.vision === true ||
        (inputMods?.includes('image') ?? false) ||
        /claude|vision/i.test(id)
      const thinkingPartial = thinkingPartialFromCatalogRow(row, 'anthropic')
      out.push(
        baseModelInfo(id, {
          displayName: typeof row.display_name === 'string' ? row.display_name : id,
          contextWindow:
            typeof row.max_input_tokens === 'number' ? row.max_input_tokens : undefined,
          maxOutputTokens:
            typeof row.max_tokens === 'number' ? row.max_tokens : undefined,
          inputModalities: inputMods
            ? wireSupportedInputModalities(inputMods, supportsVision, 'anthropic')
            : undefined,
          supportsTools: caps?.tools !== false,
          supportsVision,
          ...thinkingPartial
        }, 'anthropic')
      )
    }
    return out
  },
  async *streamChat(
    req: ProviderChatRequest,
    messagesUrl = 'https://api.anthropic.com/v1/messages',
    extraHeaders?: Record<string, string>
  ): AsyncGenerator<StreamChunk> {
    if (!req.apiKey) {
      yield { type: 'error', error: 'Anthropic API key not set' }
      return
    }

    const converted = toAnthropicMessages(req.messages)

    const systemForCache =
      req.systemStable !== undefined || req.systemVolatile !== undefined
        ? { stable: req.systemStable ?? '', volatile: req.systemVolatile ?? '' }
        : req.system

    const cached = applyCacheControl(systemForCache, converted.messages)

    const tools = toAnthropicTools(req.tools)

    const native = req.anthropicNative
    const betas = ['prompt-caching-2024-07-31']
    if (req.responseFormat) {
      betas.push('structured-outputs-2025-11-13')
    }
    if (native?.enableContextManagement) {
      betas.push('context-management-2025-06-27', 'compact-2026-01-12')
    }

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: defaultMaxTokens(req.model, req.maxOutputTokens),
      system: cached.system,
      messages: cached.messages,
      tools: tools.length ? tools : undefined,
      stream: true
    }

    if (req.toolChoice && tools.length) {
      body.tool_choice = {
        type: req.toolChoice === 'required' ? 'any' : req.toolChoice
      }
    }

    if (req.responseFormat) {
      body.output_config = {
        format: {
          type: 'json_schema',
          schema: req.responseFormat.schema
        }
      }
    }

    if (native && native.enableContextManagement) {
      const clearEdit: Record<string, unknown> = {
        type: 'clear_tool_uses_20250919',
        keep: { type: 'tool_uses', value: native.clearToolUsesKeep ?? 0 }
      }
      if (
        typeof native.clearToolUsesTriggerTokens === 'number' &&
        native.clearToolUsesTriggerTokens > 0
      ) {
        clearEdit.trigger = {
          type: 'input_tokens',
          value: native.clearToolUsesTriggerTokens
        }
      }
      if (
        typeof native.clearToolUsesAtLeastTokens === 'number' &&
        native.clearToolUsesAtLeastTokens > 0
      ) {
        clearEdit.clear_at_least = {
          type: 'input_tokens',
          value: native.clearToolUsesAtLeastTokens
        }
      }
      if (native.clearToolUsesExcludeTools && native.clearToolUsesExcludeTools.length > 0) {
        clearEdit.exclude_tools = [...native.clearToolUsesExcludeTools]
      }
      const edits: Array<Record<string, unknown>> = [clearEdit]
      const compactTrigger = native.compactTriggerTokens ?? 8_000
      edits.push({
        type: 'compact_20260112',
        trigger: { type: 'input_tokens', value: compactTrigger }
      })
      body.context_management = { edits }
    }

    Object.assign(body, anthropicThinkingFields(req))
    applySampling(body, req)

    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': req.apiKey,
      'anthropic-version': '2023-06-01',
      ...(extraHeaders ?? {})
    }

    let res: Response
    try {
      res = await postAnthropicMessages(baseHeaders, betas, body, req.signal, messagesUrl)
    } catch (err) {
      if (req.signal.aborted) throw err
      yield providerFetchFailureChunk('anthropic', err)
      return
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      logProviderFailure('anthropic', 'http', {
        status: res.status
      })
      yield { type: 'error', error: formatProviderHttpError(res.status, text, 'anthropic'), errorCode: 'PROVIDER_HTTP', httpStatus: res.status }
      return
    }

    const toolCalls = new Map<number, ToolCall>()
    let currentIndex = -1
    let lastUsage: TokenUsage | undefined
    let stopReason: StopReason | undefined
    let compactionText = ''
    const thinkingBlocks: AnthropicThinkingBlock[] = []
    let currentThinkingText = ''
    let currentBlockType: 'thinking' | 'redacted_thinking' | null = null

    const drops = { dropped: 0 }

    function applyUsage(usage: Record<string, unknown> | undefined): void {
      if (!usage) return
      const hasInput = typeof usage.input_tokens === 'number'
      const hasCacheRead = typeof usage.cache_read_input_tokens === 'number'
      const hasCacheCreate = typeof usage.cache_creation_input_tokens === 'number'
      const hasOutput = typeof usage.output_tokens === 'number'
      const hasReasoning = typeof usage.thinking_tokens === 'number'

      // Anthropic input_tokens excludes cache reads/writes; keep those buckets in
      // their own fields instead of summing possibly-overlapping numbers into the
      // meter input (cache split rides cachedInputTokens / cacheCreationInputTokens).
      const inputTokens = hasInput ? (usage.input_tokens as number) : lastUsage?.inputTokens
      const outputTokens = hasOutput ? usage.output_tokens : lastUsage?.outputTokens
      const cachedInputTokens = hasCacheRead
        ? usage.cache_read_input_tokens
        : lastUsage?.cachedInputTokens
      const cacheCreationInputTokens = hasCacheCreate
        ? usage.cache_creation_input_tokens
        : lastUsage?.cacheCreationInputTokens
      const reasoningTokens = hasReasoning ? usage.thinking_tokens : lastUsage?.reasoningTokens

      const billed = billedCostFromUsage(usage)

      const next: TokenUsage = {
        inputTokens: inputTokens as number | undefined,
        inputTokensIncludesCache: false,
        outputTokens: outputTokens as number | undefined,
        cachedInputTokens: cachedInputTokens as number | undefined,
        cacheCreationInputTokens: cacheCreationInputTokens as number | undefined,
        reasoningTokens: reasoningTokens as number | undefined,
        ...billed
      }
      if (next.inputTokens !== undefined && next.outputTokens !== undefined) {
        next.totalTokens = next.inputTokens + next.outputTokens
      }
      lastUsage = next
    }

    for await (const event of iterateSseJson(res, req.signal, drops)) {
      const type = event.type as string
      if (type === 'message_start') {
        const message = event.message as Record<string, unknown> | undefined
        applyUsage(message?.usage as Record<string, unknown> | undefined)
      }
      if (type === 'message_delta') {
        const delta = event.delta as Record<string, unknown> | undefined
        if (delta?.stop_reason) stopReason = normalizeStopReason(delta.stop_reason)
        applyUsage(event.usage as Record<string, unknown> | undefined)
      }
      if (type === 'content_block_delta') {
        const delta = event.delta as Record<string, unknown>
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          yield { type: 'text', text: delta.text }
        }
        if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          currentThinkingText += delta.thinking
          yield { type: 'thinking_delta', text: delta.thinking }
        }
        if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          // Route by the event's own block index: relying on the mutable
          // currentIndex silently discarded every argument delta when the
          // matching content_block_start frame was dropped or interleaved.
          const blockIndex = typeof event.index === 'number' ? event.index : currentIndex
          const existing = toolCalls.get(blockIndex)
          if (existing) {
            existing.arguments += delta.partial_json
            toolCalls.set(blockIndex, existing)
            yield {
              type: 'tool_call_delta',
              toolCallDelta: {
                index: blockIndex,
                id: existing.id,
                name: existing.name,
                arguments: delta.partial_json
              }
            }
          } else {
            // No matching tool block (its content_block_start was dropped or
            // malformed). Count it — surfaced via droppedFrames below — instead
            // of silently losing the arguments.
            drops.dropped += 1
          }
        }
        if (delta?.type === 'compaction_delta' && typeof delta.text === 'string') {
          compactionText += delta.text
        }
      }
      if (type === 'content_block_start') {
        const block = event.content_block as Record<string, unknown>
        const index = typeof event.index === 'number' ? event.index : currentIndex + 1
        if (block?.type === 'tool_use') {
          currentIndex = index
          toolCalls.set(index, {
            id: String(block.id),
            name: String(block.name),
            arguments: ''
          })
          // Emit immediately so the UI can show tool chrome before argument JSON arrives.
          yield {
            type: 'tool_call_delta',
            toolCallDelta: {
              index,
              id: String(block.id),
              name: String(block.name),
              arguments: ''
            }
          }
        } else if (block?.type === 'thinking') {
          currentIndex = index
          currentBlockType = 'thinking'
          currentThinkingText = ''
        } else if (block?.type === 'redacted_thinking') {
          currentIndex = index
          currentBlockType = 'redacted_thinking'
          currentThinkingText = ''
          if (typeof block.data === 'string') {
            thinkingBlocks.push({ type: 'redacted_thinking', data: block.data })
          }
        } else if (block?.type === 'compaction') {
          currentIndex = index
          if (typeof block.content === 'string') compactionText += block.content
        } else {
          currentIndex = index
        }
      }
      if (type === 'error') {
        const errObj = event.error as { message?: string } | undefined
        const message = scrubProviderErrorText(errObj?.message ?? 'Anthropic stream error')
        logProviderFailure('anthropic', 'stream', {})
        yield {
          type: 'error',
          error: message,
          errorCode: 'PROVIDER_STREAM'
        }
        return
      }
      if (type === 'content_block_stop') {
        if (currentBlockType === 'thinking' && currentThinkingText) {
          thinkingBlocks.push({ type: 'thinking', thinking: currentThinkingText })
          yield { type: 'thinking_done', text: currentThinkingText }
          currentThinkingText = ''
          currentBlockType = null
        }
      }
    }

    if (currentBlockType === 'thinking' && currentThinkingText) {
      thinkingBlocks.push({ type: 'thinking', thinking: currentThinkingText })
      yield { type: 'thinking_done', text: currentThinkingText }
    }

    for (const call of toolCalls.values()) {
      yield { type: 'tool_call', toolCall: call }
    }
    yield {
      type: 'done',
      usage: lastUsage,
      stopReason,
      ...(drops.dropped > 0 ? { droppedFrames: drops.dropped } : {}),
      compaction: compactionText.trim() || undefined,
      reasoningState:
        thinkingBlocks.length > 0
          ? { kind: 'anthropic' as const, blocks: thinkingBlocks }
          : undefined
    }
  }
}
