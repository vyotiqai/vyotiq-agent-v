import type { ChatMessage, MessageContent, ModelInfo } from '../../../shared/ipc'
import { contentToText, providerContentParts } from '../../../shared/ipc'
import { formatError } from '../../../shared/errors'
import { signAwsRequest, type AwsCredentials } from './aws/sigv4'
import { iterateEventStream } from './aws/eventStream'
import { baseModelInfo, parseDataUrl } from './normalize'
import type {
  ListModelsRequest,
  LlmProvider,
  ProviderChatRequest,
  StopReason,
  StreamChunk,
  TokenUsage,
  ToolCall
} from './types'
import { normalizeStopReason } from './stopReason'
import { logProviderFailure, providerFetchFailureChunk } from './log'
import { CHAT_FETCH_MAX_ATTEMPTS, fetchWithRetry } from './fetchWithRetry'
import { formatProviderHttpError, scrubProviderErrorText } from './httpErrors'
import { anthropicThinkingFields } from './thinkingPolicy'
import { resolveSystemZones, volatileSessionMessage } from './systemZones'
import { wireToolCallArguments } from '../toolArgWire'
import { splitToolContent } from './toolImages'
import { readFiniteNumber } from './usageFields'
import { bedrockRegionFromBaseUrl, bedrockRuntimeBaseUrl } from '../../../shared/domain/cloudProviders'

/**
 * Amazon Bedrock through the Converse API — one request shape for every
 * Bedrock model (Claude, Nova, Llama, Mistral…). Auth is a Bedrock API key
 * (`Authorization: Bearer`) or an access key pair signed with SigV4. The
 * stream is AWS event-stream framing, not SSE.
 */

export type BedrockAuth =
  | { kind: 'apiKey'; token: string }
  | { kind: 'sigv4'; credentials: AwsCredentials }

/**
 * The saved Bedrock secret is either a Bedrock API key (plain text) or an
 * access key pair as JSON: `{"accessKeyId","secretAccessKey","sessionToken"?}`.
 */
export function parseBedrockSecret(raw: string | null | undefined): BedrockAuth | { error: string } {
  const value = raw?.trim()
  if (!value) return { error: 'Amazon Bedrock is not set up.' }
  if (value.startsWith('{')) {
    let o: Record<string, unknown>
    try {
      o = JSON.parse(value) as Record<string, unknown>
    } catch {
      return { error: 'The saved AWS access keys are not valid JSON.' }
    }
    const id = typeof o.accessKeyId === 'string' ? o.accessKeyId.trim() : ''
    const secret = typeof o.secretAccessKey === 'string' ? o.secretAccessKey.trim() : ''
    const token = typeof o.sessionToken === 'string' ? o.sessionToken.trim() : ''
    if (!id || !secret) return { error: 'The saved AWS access keys need an access key ID and a secret.' }
    return { kind: 'sigv4', credentials: { accessKeyId: id, secretAccessKey: secret, ...(token ? { sessionToken: token } : {}) } }
  }
  if (/\s/.test(value)) return { error: 'The Bedrock API key has spaces in it.' }
  return { kind: 'apiKey', token: value }
}

/** Headers for one attempt: a bearer key, or a fresh SigV4 signature. */
function authHeaders(
  auth: BedrockAuth,
  method: string,
  url: string,
  body: string,
  region: string,
  service: 'bedrock' | 'bedrock-runtime'
): Record<string, string> {
  const base: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
  if (auth.kind === 'apiKey') return { ...base, authorization: `Bearer ${auth.token}` }
  return signAwsRequest({
    method,
    url,
    headers: base,
    body,
    region,
    // Bedrock signs both planes under the `bedrock` signing name.
    service: service === 'bedrock-runtime' ? 'bedrock' : service,
    credentials: auth.credentials
  })
}

const IMAGE_FORMATS = new Set(['png', 'jpeg', 'gif', 'webp'])

function imageBlock(url: string): Record<string, unknown> | null {
  const data = parseDataUrl(url)
  if (!data) return null
  const format = data.mediaType.replace(/^image\//, '').replace('jpg', 'jpeg')
  if (!IMAGE_FORMATS.has(format)) return null
  return { image: { format, source: { bytes: data.data } } }
}

function toConverseContent(content: MessageContent): Array<Record<string, unknown>> {
  if (typeof content === 'string') return content ? [{ text: content }] : []
  const blocks: Array<Record<string, unknown>> = []
  let doc = 0
  for (const p of providerContentParts(content, { image: true, fileNative: true, audio: false })) {
    if (p.type === 'text') {
      if (p.text) blocks.push({ text: p.text })
      continue
    }
    if (p.type === 'file_native') {
      if ((p.mime || 'application/pdf') === 'application/pdf') {
        doc += 1
        blocks.push({ document: { format: 'pdf', name: `document ${doc}`, source: { bytes: p.data } } })
      }
      continue
    }
    const image = imageBlock(p.url)
    blocks.push(image ?? { text: '[image omitted: Bedrock needs an inline png, jpeg, gif or webp]' })
  }
  return blocks
}

function toolResultContent(content: MessageContent): Array<Record<string, unknown>> {
  if (typeof content === 'string') return [{ text: content || '(no output)' }]
  const { text, images } = splitToolContent(content)
  const out: Array<Record<string, unknown>> = [{ text: text || '(no output)' }]
  for (const image of images) {
    const block = imageBlock(image.url)
    if (block) out.push(block)
  }
  return out
}

function replayedReasoning(m: ChatMessage): Array<Record<string, unknown>> {
  const state = m.reasoningState as { kind?: string; blocks?: unknown } | undefined
  if (state?.kind !== 'bedrock_converse' || !Array.isArray(state.blocks)) return []
  return state.blocks.filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
}

/**
 * Exported for tests — chat history as Converse `system` + `messages`.
 * `asText` writes tool calls and results as plain text: Converse rejects
 * toolUse/toolResult blocks in a request that declares no tools (compaction).
 */
export function toConverseMessages(
  messages: ChatMessage[],
  opts: { asText?: boolean } = {}
): {
  system: string[]
  messages: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }>
} {
  const system: string[] = []
  const out: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = []
  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : contentToText(m.content)
      if (text.trim()) system.push(text)
      continue
    }
    if (m.role === 'tool') {
      if (!m.toolCallId) continue
      if (opts.asText) {
        const text = typeof m.content === 'string' ? m.content : contentToText(m.content)
        out.push({ role: 'user', content: [{ text: `[${m.toolName ?? 'tool'} result]\n${text || '(no output)'}` }] })
        continue
      }
      out.push({
        role: 'user',
        content: [{ toolResult: { toolUseId: m.toolCallId, content: toolResultContent(m.content) } }]
      })
      continue
    }
    if (m.role === 'assistant') {
      const content = opts.asText ? [] : [...replayedReasoning(m)]
      const text = typeof m.content === 'string' ? m.content : contentToText(m.content)
      if (text.trim()) content.push({ text })
      for (const t of m.toolCalls ?? []) {
        const args = wireToolCallArguments(t.name, t.arguments)
        if (opts.asText) {
          content.push({ text: `[called ${t.name}] ${args}` })
          continue
        }
        let input: unknown = {}
        try {
          input = JSON.parse(args)
        } catch {
          input = {}
        }
        content.push({ toolUse: { toolUseId: t.id, name: t.name, input } })
      }
      if (content.length) out.push({ role: 'assistant', content })
      continue
    }
    const content = toConverseContent(m.content)
    if (content.length) out.push({ role: 'user', content })
  }
  // Converse wants strict user/assistant alternation, starting with a user turn.
  const merged: typeof out = []
  for (const msg of out) {
    const last = merged[merged.length - 1]
    if (last && last.role === msg.role) last.content = [...last.content, ...msg.content]
    else merged.push({ role: msg.role, content: [...msg.content] })
  }
  if (merged[0]?.role === 'assistant') merged.unshift({ role: 'user', content: [{ text: '(continue)' }] })
  return { system, messages: merged }
}

const isClaude = (model: string) => /(?:^|[.:/])anthropic\.claude/i.test(model)
/** Models that take Converse `cachePoint` blocks (Claude and Nova). */
const takesCachePoints = (model: string) => /(?:^|[.:/])(?:anthropic\.claude|amazon\.nova)/i.test(model)

export type ConverseBodyOptions = { cachePoints: boolean; outputConfig: boolean }

/** Exported for tests — the ConverseStream request body. */
export function buildConverseBody(
  req: ProviderChatRequest,
  opts: ConverseBodyOptions = { cachePoints: true, outputConfig: true }
): Record<string, unknown> {
  const zones = resolveSystemZones(req)
  const converted = toConverseMessages(req.messages, { asText: req.tools.length === 0 })
  const cache = opts.cachePoints && takesCachePoints(req.model)
  const systemTexts = [...(zones.stable ? [zones.stable] : []), ...converted.system]
  const system: Array<Record<string, unknown>> = systemTexts.map((text) => ({ text }))
  if (cache && system.length) system.push({ cachePoint: { type: 'default' } })

  const messages = converted.messages
  if (zones.volatile) {
    const vol = volatileSessionMessage(zones.volatile)
    const last = messages[messages.length - 1]
    if (last?.role === 'user') last.content = [...last.content, { text: vol.content }]
    else messages.push({ role: 'user', content: [{ text: vol.content }] })
  }
  if (!messages.length) messages.push({ role: 'user', content: [{ text: '(continue)' }] })

  const body: Record<string, unknown> = { messages }
  if (system.length) body.system = system

  const inferenceConfig: Record<string, unknown> = {}
  const additional: Record<string, unknown> = {}
  if (isClaude(req.model)) {
    const thinking = anthropicThinkingFields(req)
    if (thinking.thinking) additional.thinking = thinking.thinking
    if (thinking.output_config && opts.outputConfig) additional.output_config = thinking.output_config
    if (typeof thinking.max_tokens === 'number') inferenceConfig.maxTokens = thinking.max_tokens
  }
  const thinkingOn = (additional.thinking as { type?: string } | undefined)?.type !== undefined &&
    (additional.thinking as { type?: string }).type !== 'disabled'
  if (inferenceConfig.maxTokens === undefined && req.maxOutputTokens && req.maxOutputTokens > 0) {
    inferenceConfig.maxTokens = req.maxOutputTokens
  }
  // Claude refuses a sampling temperature while it thinks.
  if (typeof req.temperature === 'number' && !thinkingOn) inferenceConfig.temperature = req.temperature
  if (req.stop?.length) inferenceConfig.stopSequences = req.stop.slice(0, 4)
  if (Object.keys(inferenceConfig).length) body.inferenceConfig = inferenceConfig
  if (Object.keys(additional).length) body.additionalModelRequestFields = additional

  // A history holding toolUse/toolResult blocks is rejected without a
  // toolConfig, so tools stay declared even when the step asks for none.
  if (req.tools.length) {
    const tools: Array<Record<string, unknown>> = req.tools.map((t) => ({
      toolSpec: { name: t.name, description: t.description || t.name, inputSchema: { json: t.parameters } }
    }))
    if (cache) tools.push({ cachePoint: { type: 'default' } })
    body.toolConfig = {
      tools,
      ...(req.toolChoice === 'required' && !thinkingOn ? { toolChoice: { any: {} } } : { toolChoice: { auto: {} } })
    }
  }
  return body
}

function converseStopReason(raw: unknown): StopReason | undefined {
  if (raw === 'guardrail_intervened' || raw === 'content_filtered') return 'content_filter'
  if (raw === 'model_context_window_exceeded') return 'length'
  return normalizeStopReason(raw)
}

/** In-stream exception types that are the server's trouble, not the request's. */
const STREAM_EXCEPTION_STATUS: Record<string, number> = {
  throttlingException: 429,
  serviceUnavailableException: 503,
  internalServerException: 500,
  modelStreamErrorException: 424,
  validationException: 400
}

export type BedrockEndpoint = { baseUrl: string; region: string; auth: BedrockAuth }

/** Stream one Converse call. Exported so tests can aim it at a local mock. */
export async function* streamBedrockConverse(
  req: ProviderChatRequest,
  endpoint: BedrockEndpoint
): AsyncGenerator<StreamChunk> {
  const url = `${endpoint.baseUrl.replace(/\/$/, '')}/model/${encodeURIComponent(req.model)}/converse-stream`
  let opts: ConverseBodyOptions = { cachePoints: true, outputConfig: true }
  let res: Response | undefined
  let lastText = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = JSON.stringify(buildConverseBody(req, opts))
    try {
      res = await fetchWithRetry(
        url,
        { method: 'POST', body, signal: req.signal },
        {
          maxAttempts: CHAT_FETCH_MAX_ATTEMPTS,
          headersForAttempt: () => authHeaders(endpoint.auth, 'POST', url, body, endpoint.region, 'bedrock-runtime')
        }
      )
    } catch (err) {
      if (req.signal.aborted) throw err
      yield providerFetchFailureChunk('bedrock', err)
      return
    }
    if (res.ok) break
    lastText = await res.text().catch(() => '')
    // Older models refuse cache points or Claude's effort field; drop the one
    // named and try once more rather than failing the step.
    if (res.status === 400 && opts.cachePoints && /cache ?point|caching/i.test(lastText)) {
      opts = { ...opts, cachePoints: false }
      continue
    }
    if (res.status === 400 && opts.outputConfig && /output_config|effort/i.test(lastText)) {
      opts = { ...opts, outputConfig: false }
      continue
    }
    break
  }
  if (!res || !res.ok) {
    const status = res?.status ?? 0
    logProviderFailure('bedrock', 'http', { status })
    yield {
      type: 'error',
      error: formatProviderHttpError(status, lastText, 'bedrock'),
      errorCode: 'PROVIDER_HTTP',
      httpStatus: status
    }
    return
  }

  const toolCalls = new Map<number, ToolCall>()
  const reasoning = new Map<number, { text: string; signature?: string; redacted?: string }>()
  const reasoningBlocks: Array<Record<string, unknown>> = []
  let usage: TokenUsage | undefined
  let stopReason: StopReason | undefined
  let textSeen = false
  let callSinceText = false
  let dropped = 0
  const decoder = new TextDecoder()

  const closeReasoning = function* (index: number): Generator<StreamChunk> {
    const r = reasoning.get(index)
    if (!r) return
    reasoning.delete(index)
    if (r.redacted) {
      reasoningBlocks.push({ reasoningContent: { redactedContent: r.redacted } })
      return
    }
    reasoningBlocks.push({
      reasoningContent: { reasoningText: { text: r.text, ...(r.signature ? { signature: r.signature } : {}) } }
    })
    if (r.text) yield { type: 'thinking_done', text: r.text }
  }

  try {
    for await (const message of iterateEventStream(res, req.signal)) {
      const messageType = message.headers[':message-type']
      if (messageType === 'exception' || messageType === 'error') {
        const kind = String(message.headers[':exception-type'] ?? message.headers[':error-code'] ?? 'error')
        let detail = String(message.headers[':error-message'] ?? '')
        try {
          const parsed = JSON.parse(decoder.decode(message.payload)) as { message?: unknown }
          if (typeof parsed.message === 'string') detail = parsed.message
        } catch {
          // exception payloads are JSON; an unparseable one keeps the header text
        }
        logProviderFailure('bedrock', 'stream', {})
        const status = STREAM_EXCEPTION_STATUS[kind]
        yield {
          type: 'error',
          error: scrubProviderErrorText(`Bedrock ${kind}: ${detail || 'stream failed'}`),
          errorCode: status && status !== 400 ? 'PROVIDER_HTTP' : 'PROVIDER_STREAM',
          ...(status && status !== 400 ? { httpStatus: status } : {})
        }
        return
      }
      if (messageType !== 'event') continue
      const eventType = String(message.headers[':event-type'] ?? '')
      let event: Record<string, unknown>
      try {
        event = JSON.parse(decoder.decode(message.payload)) as Record<string, unknown>
      } catch {
        dropped += 1
        continue
      }
      const index = typeof event.contentBlockIndex === 'number' ? event.contentBlockIndex : -1

      if (eventType === 'contentBlockStart') {
        const toolUse = (event.start as { toolUse?: { toolUseId?: unknown; name?: unknown } } | undefined)?.toolUse
        if (toolUse && typeof toolUse.toolUseId === 'string' && typeof toolUse.name === 'string') {
          if (textSeen) callSinceText = true
          toolCalls.set(index, { id: toolUse.toolUseId, name: toolUse.name, arguments: '' })
          yield { type: 'tool_call_delta', toolCallDelta: { index, id: toolUse.toolUseId, name: toolUse.name, arguments: '' } }
        }
        continue
      }
      if (eventType === 'contentBlockDelta') {
        const delta = (event.delta ?? {}) as Record<string, unknown>
        if (typeof delta.text === 'string') {
          if (delta.text && textSeen && callSinceText) {
            callSinceText = false
            yield { type: 'text', text: '\n\n' }
          }
          if (delta.text) textSeen = true
          yield { type: 'text', text: delta.text }
          continue
        }
        const toolInput = (delta.toolUse as { input?: unknown } | undefined)?.input
        if (typeof toolInput === 'string') {
          const call = toolCalls.get(index)
          if (!call) {
            dropped += 1
            continue
          }
          call.arguments += toolInput
          yield { type: 'tool_call_delta', toolCallDelta: { index, id: call.id, name: call.name, arguments: toolInput } }
          continue
        }
        const rc = delta.reasoningContent as { text?: unknown; signature?: unknown; redactedContent?: unknown } | undefined
        if (rc) {
          const r = reasoning.get(index) ?? { text: '' }
          if (typeof rc.text === 'string') {
            r.text += rc.text
            if (rc.text) yield { type: 'thinking_delta', text: rc.text }
          }
          if (typeof rc.signature === 'string') r.signature = rc.signature
          if (typeof rc.redactedContent === 'string') r.redacted = rc.redactedContent
          reasoning.set(index, r)
        }
        continue
      }
      if (eventType === 'contentBlockStop') {
        yield* closeReasoning(index)
        continue
      }
      if (eventType === 'messageStop') {
        stopReason = converseStopReason(event.stopReason)
        continue
      }
      if (eventType === 'metadata') {
        const u = event.usage as Record<string, unknown> | undefined
        if (u) {
          const input = readFiniteNumber(u.inputTokens)
          const output = readFiniteNumber(u.outputTokens)
          usage = {
            inputTokens: input,
            // Converse counts cache reads and writes apart from inputTokens.
            inputTokensIncludesCache: false,
            outputTokens: output,
            cachedInputTokens: readFiniteNumber(u.cacheReadInputTokens),
            cacheCreationInputTokens: readFiniteNumber(u.cacheWriteInputTokens),
            ...(input !== undefined && output !== undefined ? { totalTokens: input + output } : {})
          }
        }
      }
    }
  } catch (err) {
    if (req.signal.aborted) throw err
    if ((err as Error)?.name === 'EventStreamDecodeError') {
      logProviderFailure('bedrock', 'stream', {})
      yield { type: 'error', error: formatError(err), errorCode: 'PROVIDER_STREAM' }
      return
    }
    throw err
  }

  for (const index of [...reasoning.keys()]) yield* closeReasoning(index)
  for (const call of toolCalls.values()) yield { type: 'tool_call', toolCall: call }
  yield {
    type: 'done',
    usage,
    stopReason,
    ...(dropped > 0 ? { droppedFrames: dropped } : {}),
    ...(reasoningBlocks.length ? { reasoningState: { kind: 'bedrock_converse' as const, blocks: reasoningBlocks } } : {})
  }
}

type FoundationModelSummary = {
  modelId?: string
  modelName?: string
  providerName?: string
  inputModalities?: string[]
  outputModalities?: string[]
  responseStreamingSupported?: boolean
  inferenceTypesSupported?: string[]
  modelLifecycle?: { status?: string }
}
type InferenceProfileSummary = {
  inferenceProfileId?: string
  inferenceProfileName?: string
  status?: string
  models?: Array<{ modelArn?: string }>
}

async function getControlPlane(
  path: string,
  region: string,
  auth: BedrockAuth,
  signal: AbortSignal | undefined,
  controlBase: string
): Promise<unknown> {
  const url = `${controlBase}${path}`
  let res: Response
  try {
    res = await fetchWithRetry(
      url,
      { method: 'GET', signal },
      { circuitKey: false, headersForAttempt: () => authHeaders(auth, 'GET', url, '', region, 'bedrock') }
    )
  } catch (err) {
    if (signal?.aborted) throw err
    logProviderFailure('bedrock', 'network', {})
    throw new Error(formatError(err))
  }
  const text = await res.text().catch(() => '')
  if (!res.ok) {
    logProviderFailure('bedrock', 'http', { status: res.status })
    throw new Error(formatProviderHttpError(res.status, text, 'bedrock'))
  }
  return JSON.parse(text) as unknown
}

/** Tools through Converse: everything current; a few legacy text models never took them. */
const NO_TOOLS_RE = /titan-text|ai21\.j2|cohere\.command-(?:text|light)|meta\.llama2|mistral\.mistral-7b|mixtral-8x7b/i

/**
 * Models this account can call on demand: its system inference profiles (the
 * ids newer Claude and Llama models require), then on-demand base models.
 * Exported so tests can aim it at a local mock control plane.
 */
export async function listBedrockModels(
  region: string,
  auth: BedrockAuth,
  signal?: AbortSignal,
  controlBase = `https://bedrock.${region}.amazonaws.com`
): Promise<ModelInfo[]> {
  const fm = (await getControlPlane(
    '/foundation-models?byOutputModality=TEXT',
    region,
    auth,
    signal,
    controlBase
  )) as { modelSummaries?: FoundationModelSummary[] }
  const byId = new Map<string, FoundationModelSummary>()
  for (const m of fm.modelSummaries ?? []) if (m.modelId) byId.set(m.modelId, m)

  let profiles: InferenceProfileSummary[] = []
  try {
    const ip = (await getControlPlane(
      '/inference-profiles?typeEquals=SYSTEM_DEFINED&maxResults=1000',
      region,
      auth,
      signal,
      controlBase
    )) as { inferenceProfileSummaries?: InferenceProfileSummary[] }
    profiles = ip.inferenceProfileSummaries ?? []
  } catch (err) {
    // A key allowed to list models but not profiles still gets base models.
    if (signal?.aborted) throw err
  }

  const info = (id: string, name: string, m: FoundationModelSummary | undefined): ModelInfo => {
    const vision = m?.inputModalities?.includes('IMAGE') ?? false
    return baseModelInfo(
      id,
      {
        displayName: name,
        supportsVision: vision,
        inputModalities: vision ? ['text', 'image'] : ['text'],
        supportsTools: !NO_TOOLS_RE.test(id)
      },
      'bedrock'
    )
  }

  const out: ModelInfo[] = []
  const seen = new Set<string>()
  for (const p of profiles) {
    if (!p.inferenceProfileId || (p.status && p.status !== 'ACTIVE')) continue
    const baseId = p.models?.[0]?.modelArn?.split('foundation-model/')[1]
    const base = baseId ? byId.get(baseId) : undefined
    if (base?.outputModalities && !base.outputModalities.includes('TEXT')) continue
    out.push(info(p.inferenceProfileId, p.inferenceProfileName ?? p.inferenceProfileId, base))
    seen.add(p.inferenceProfileId)
  }
  for (const m of byId.values()) {
    if (!m.modelId || seen.has(m.modelId)) continue
    if (!m.inferenceTypesSupported?.includes('ON_DEMAND')) continue
    if (m.outputModalities && !m.outputModalities.includes('TEXT')) continue
    if (m.responseStreamingSupported === false) continue
    if (m.modelLifecycle?.status && m.modelLifecycle.status !== 'ACTIVE') continue
    out.push(info(m.modelId, [m.providerName, m.modelName].filter(Boolean).join(' ') || m.modelId, m))
  }
  return out
}

export const bedrockProvider: LlmProvider = {
  id: 'bedrock',
  async listModels(req: ListModelsRequest): Promise<ModelInfo[]> {
    const auth = parseBedrockSecret(req.apiKey)
    if ('error' in auth) throw new Error(auth.error)
    return listBedrockModels(bedrockRegionFromBaseUrl(req.baseUrl), auth, req.signal)
  },
  async *streamChat(req: ProviderChatRequest): AsyncGenerator<StreamChunk> {
    const auth = parseBedrockSecret(req.apiKey)
    if ('error' in auth) {
      yield { type: 'error', error: auth.error }
      return
    }
    const region = bedrockRegionFromBaseUrl(req.baseUrl)
    yield* streamBedrockConverse(req, { baseUrl: bedrockRuntimeBaseUrl(region), region, auth })
  }
}
