import type { ChatMessage, MessageContent, ModelInfo } from '../../../shared/ipc'
import { contentToText, providerContentParts } from '../../../shared/ipc'
import { formatError } from '../../../shared/errors'
import { baseModelInfo, looksLikeChatModel, parseDataUrl, thinkingPartialFromCatalogRow } from './normalize'
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
import { streamGeminiInteractions } from './geminiInteractions'
import { resolveSystemZones, volatileSessionMessage } from './systemZones'
import { wireToolCallArguments } from '../toolArgWire'

/** Exported for tests — parse Gemini usage metadata including implicit cache hits. */
export function parseGeminiUsage(usageMetadata: Record<string, unknown>): TokenUsage {
  const cached =
    typeof usageMetadata.cachedContentTokenCount === 'number'
      ? usageMetadata.cachedContentTokenCount
      : typeof usageMetadata.cached_content_token_count === 'number'
        ? usageMetadata.cached_content_token_count
        : undefined
  return {
    inputTokens:
      typeof usageMetadata.promptTokenCount === 'number'
        ? usageMetadata.promptTokenCount
        : typeof usageMetadata.prompt_token_count === 'number'
          ? usageMetadata.prompt_token_count
          : undefined,
    inputTokensIncludesCache: true,
    outputTokens:
      typeof usageMetadata.candidatesTokenCount === 'number'
        ? usageMetadata.candidatesTokenCount
        : typeof usageMetadata.candidates_token_count === 'number'
          ? usageMetadata.candidates_token_count
          : undefined,
    totalTokens:
      typeof usageMetadata.totalTokenCount === 'number'
        ? usageMetadata.totalTokenCount
        : typeof usageMetadata.total_token_count === 'number'
          ? usageMetadata.total_token_count
          : undefined,
    cachedInputTokens: cached,
    reasoningTokens:
      typeof usageMetadata.thoughtsTokenCount === 'number'
        ? usageMetadata.thoughtsTokenCount
        : typeof usageMetadata.thoughts_token_count === 'number'
          ? usageMetadata.thoughts_token_count
          : undefined,
    ...billedCostFromUsage(usageMetadata)
  }
}

function toGeminiParts(content: MessageContent): Array<Record<string, unknown>> {
  if (typeof content === 'string') return [{ text: content }]
  const parts: Array<Record<string, unknown>> = []
  for (const p of providerContentParts(content, { image: true, audio: true, fileNative: true })) {
    if (p.type === 'text') {
      parts.push({ text: p.text })
      continue
    }
    if (p.type === 'file_native') {
      parts.push({
        inlineData: { mimeType: p.mime || 'application/pdf', data: p.data }
      })
      continue
    }
    if (p.type === 'audio') {
      const data = parseDataUrl(p.url)
      if (data) {
        parts.push({
          inlineData: { mimeType: data.mediaType || p.mime || 'audio/mpeg', data: data.data }
        })
      } else {
        parts.push({ text: '[audio omitted: Gemini requires a base64 data URL]' })
      }
      continue
    }
    const data = parseDataUrl(p.url)
    if (data) {
      parts.push({
        inlineData: { mimeType: data.mediaType, data: data.data }
      })
    } else if (p.url.startsWith('https://generativelanguage.googleapis.com/')) {
      // Gemini fileData only accepts Files API URIs, not arbitrary https links.
      parts.push({ fileData: { fileUri: p.url } })
    } else {
      parts.push({
        text: '[image omitted: Gemini requires a base64 data URL or Files API URI]'
      })
    }
  }
  return parts
}

function toGeminiContents(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const contents: Array<Record<string, unknown>> = []

  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: m.toolName ?? 'tool',
              ...(m.toolCallId ? { id: m.toolCallId } : {}),
              response: {
                result: typeof m.content === 'string' ? m.content : contentToText(m.content)
              }
            }
          }
        ]
      })
      continue
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const parts: Array<Record<string, unknown>> = []
      const text = typeof m.content === 'string' ? m.content : contentToText(m.content)
      if (text) parts.push({ text })
      for (const t of m.toolCalls) {
        let args: unknown = {}
        try {
          args = JSON.parse(wireToolCallArguments(t.name, t.arguments))
        } catch {
          args = {}
        }
        parts.push({
          functionCall: {
            name: t.name,
            args,
            ...(t.id ? { id: t.id } : {})
          }
        })
      }
      contents.push({ role: 'model', parts })
      continue
    }
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: toGeminiParts(m.content)
    })
  }

  const merged: Array<Record<string, unknown>> = []
  for (const msg of contents) {
    const last = merged[merged.length - 1]
    if (last && last.role === msg.role) {
      const lastParts = (last.parts as Array<Record<string, unknown>>) ?? []
      const nextParts = (msg.parts as Array<Record<string, unknown>>) ?? []
      last.parts = [...lastParts, ...nextParts]
    } else {
      merged.push({ ...msg, parts: [...((msg.parts as Array<Record<string, unknown>>) ?? [])] })
    }
  }
  return merged
}

/** Map loop toolChoice to Gemini functionCallingConfig.mode. */
export function geminiFunctionCallingMode(
  choice: ProviderChatRequest['toolChoice']
): 'AUTO' | 'ANY' | 'NONE' {
  if (choice === 'none') return 'NONE'
  if (choice === 'required') return 'ANY'
  return 'AUTO'
}

/**
 * Flash-family models accept `thinkingBudget: 0` to disable thinking; 2.5 Pro
 * cannot be disabled (budget 0 is rejected with a 400), so the config is only
 * sent where it is documented to work. Thinking-enabled 2.5/3 models route to
 * the Interactions transport before this path is reached.
 */
const GEMINI_DISABLEABLE_THINKING_RE = /gemini-(2\.5-)?flash/i

/** Exported for tests — thinkingConfig for the plain generateContent path. */
export function geminiThinkingConfigForPlainPath(
  req: ProviderChatRequest
): Record<string, unknown> | undefined {
  if (req.thinking?.enabled === false && GEMINI_DISABLEABLE_THINKING_RE.test(req.model)) {
    return { thinkingBudget: 0 }
  }
  return undefined
}

/** Exported for tests — build Gemini generateContent request body. */
export function buildGeminiBody(req: ProviderChatRequest): Record<string, unknown> {
  const zones = resolveSystemZones({
    system: req.system,
    systemStable: req.systemStable,
    systemVolatile: req.systemVolatile
  })
  const systemParts = [
    ...(zones.stable ? [zones.stable] : []),
    ...req.messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : contentToText(m.content)))
  ]
  const tools =
    req.tools.length > 0
      ? [
          {
            functionDeclarations: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters
            }))
          }
        ]
      : undefined
  const generationConfig: Record<string, unknown> = {}
  if (req.maxOutputTokens && req.maxOutputTokens > 0) {
    generationConfig.maxOutputTokens = req.maxOutputTokens
  }
  if (typeof req.temperature === 'number') {
    generationConfig.temperature = req.temperature
  }
  if (req.stop && req.stop.length > 0) {
    generationConfig.stopSequences = req.stop.slice(0, 5)
  }
  if (req.responseFormat) {
    generationConfig.responseMimeType = 'application/json'
    generationConfig.responseSchema = req.responseFormat.schema
  }
  const thinkingConfig = geminiThinkingConfigForPlainPath(req)
  if (thinkingConfig) {
    generationConfig.thinkingConfig = thinkingConfig
  }
  const contents = toGeminiContents(req.messages)
  if (zones.volatile) {
    const vol = volatileSessionMessage(zones.volatile)
    contents.push({ role: 'user', parts: [{ text: vol.content }] })
  }
  return {
    contents,
    systemInstruction: systemParts.length
      ? { parts: systemParts.map((t) => ({ text: t })) }
      : undefined,
    tools,
    ...(tools
      ? {
          toolConfig: {
            functionCallingConfig: { mode: geminiFunctionCallingMode(req.toolChoice) }
          }
        }
      : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {})
  }
}

export const geminiProvider: LlmProvider = {
  id: 'gemini',
  async listModels(req: ListModelsRequest): Promise<ModelInfo[]> {
    if (!req.apiKey) throw new Error('Gemini API key not set')
    const url = 'https://generativelanguage.googleapis.com/v1beta/models'
    let res: Response
    try {
      res = await fetchWithRetry(
        url,
        {
          method: 'GET',
          headers: { 'x-goog-api-key': req.apiKey },
          signal: req.signal
        },
        { circuitKey: false }
      )
    } catch (err) {
      if (req.signal?.aborted) throw err
      logProviderFailure('gemini', 'network', {})
      throw new Error(formatError(err))
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      logProviderFailure('gemini', 'http', { status: res.status })
      throw new Error(formatProviderHttpError(res.status, text, 'gemini'))
    }
    const data = (await res.json()) as { models?: Array<Record<string, unknown>> }
    const out: ModelInfo[] = []
    for (const row of data.models ?? []) {
      const name = typeof row.name === 'string' ? row.name : null
      if (!name) continue
      const methods = row.supportedGenerationMethods as string[] | undefined
      if (methods && !methods.includes('generateContent')) continue
      const id = name.replace(/^models\//, '')
      if (!looksLikeChatModel(id)) continue
      out.push(
        baseModelInfo(
          id,
          {
            displayName: typeof row.displayName === 'string' ? row.displayName : id,
            contextWindow:
              typeof row.inputTokenLimit === 'number' ? row.inputTokenLimit : undefined,
            maxOutputTokens:
              typeof row.outputTokenLimit === 'number' ? row.outputTokenLimit : undefined,
            supportsTools: true,
            supportsVision: /gemini|vision|flash|pro/i.test(id),
            ...thinkingPartialFromCatalogRow(row, 'gemini')
          },
          'gemini'
        )
      )
    }
    return out
  },
  async *streamChat(req: ProviderChatRequest): AsyncGenerator<StreamChunk> {
    const useInteractions =
      req.thinking?.enabled === true &&
      (req.modelInfo?.thinkingApi === 'interactions' ||
        /(?:^|\/)gemini-(2\.5|3(?:\.\d+)?)(?:-|$)/i.test(req.model))
    if (useInteractions) {
      yield* streamGeminiInteractions(req)
      return
    }

    if (!req.apiKey) {
      yield { type: 'error', error: 'Gemini API key not set' }
      return
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`
    // Same zone split as buildGeminiBody (stable systemInstruction + trailing volatile).
    const requestBody = buildGeminiBody(req)

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
          body: JSON.stringify(requestBody)
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

    let toolIndex = 0
    let lastUsage: TokenUsage | undefined
    let stopReason: StopReason | undefined
    const pendingCalls = new Map<string, ToolCall>()
    const drops = { dropped: 0 }

    for await (const event of iterateSseJson(res, req.signal, drops)) {
      if (event.error) {
        const errObj = event.error as { message?: string } | string
        const raw =
          typeof errObj === 'string' ? errObj : (errObj.message ?? 'Gemini stream error')
        const message = scrubProviderErrorText(raw)
        logProviderFailure('gemini', 'stream', {})
        yield {
          type: 'error',
          error: message,
          errorCode: 'PROVIDER_STREAM'
        }
        return
      }

      const um = event.usageMetadata as Record<string, unknown> | undefined
      if (um) {
        lastUsage = parseGeminiUsage(um)
      }

      const candidates = event.candidates as Array<Record<string, unknown>> | undefined
      const finishReason = candidates?.[0]?.finishReason
      if (finishReason) stopReason = normalizeStopReason(finishReason)
      const parts = (candidates?.[0]?.content as Record<string, unknown>)?.parts as
        | Array<Record<string, unknown>>
        | undefined
      if (!parts) continue

      for (const part of parts) {
        const fc = part.functionCall as { name?: string; args?: unknown; id?: string } | undefined
        if (fc?.name) {
          const id =
            typeof fc.id === 'string' && fc.id ? fc.id : `gemini_${toolIndex++}`
          const argsJson = JSON.stringify(fc.args ?? {})
          const existing = pendingCalls.get(id)
          if (existing) {
            existing.arguments = argsJson
            // Mid-stream update: live-forward so chrome/args appear before stream end.
            yield { type: 'tool_call', toolCall: { ...existing } }
          } else {
            const call = { id, name: fc.name, arguments: argsJson }
            pendingCalls.set(id, call)
            yield { type: 'tool_call', toolCall: { ...call } }
          }
        }
      }
      for (const part of parts) {
        // `thought: true` rows are model reasoning, not answer text — the plain
        // path has no thinking channel, so they must never reach the transcript.
        if (part.thought === true) continue
        if (typeof part.text === 'string' && part.text) {
          yield { type: 'text', text: part.text }
        }
      }
    }

    yield {
      type: 'done',
      usage: lastUsage,
      stopReason,
      ...(drops.dropped > 0 ? { droppedFrames: drops.dropped } : {})
    }
  }
}
