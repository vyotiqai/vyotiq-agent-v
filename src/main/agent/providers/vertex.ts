import type { ModelInfo } from '../../../shared/ipc'
import { formatError } from '../../../shared/errors'
import { modelsDevListings } from '../../../shared/domain/modelsDevRegistry'
import { streamAnthropicMessages } from './anthropic'
import { buildGeminiBody, consumeGeminiStream } from './gemini'
import {
  dropGoogleAccessToken,
  googleAccessToken,
  resolveVertexCredentials,
  type GoogleCredentials,
  type GoogleTokenOptions
} from './google/googleAuth'
import { baseModelInfo } from './normalize'
import type { ListModelsRequest, LlmProvider, ProviderChatRequest, StreamChunk } from './types'
import { logProviderFailure, providerFetchFailureChunk } from './log'
import { CHAT_FETCH_MAX_ATTEMPTS, fetchWithRetry } from './fetchWithRetry'
import { formatProviderHttpError } from './httpErrors'
import { createOpenAiCompatibleProvider } from './openai'

export { vertexBaseUrl } from '../../../shared/domain/cloudProviders'

/**
 * Google Cloud Vertex AI: Gemini through `streamGenerateContent`, Claude
 * through `streamRawPredict` in the Anthropic Messages shape, and the open and
 * partner models served as a service (Llama, DeepSeek, Qwen, gpt-oss, Kimi…)
 * through Vertex's OpenAI-compatible Chat Completions endpoint, named
 * `publisher/model` (`meta/llama-3.3-70b-instruct-maas`). Signs in with a
 * service-account key or this computer's gcloud login (see googleAuth).
 */

export function isVertexClaude(model: string): boolean {
  return /^(?:anthropic\/)?claude-/i.test(model.trim())
}

/** Publishers whose models Vertex serves through its own native routes, not Chat Completions. */
const NATIVE_ONLY_PUBLISHERS = /^(?:mistralai|ai21)\//i

/**
 * `gemini-2.5-pro` or `google/gemini-2.5-pro` → Google's route; Claude →
 * Anthropic's; any other `publisher/model` → the OpenAI-compatible endpoint,
 * which takes the name whole. Null for what neither speaks.
 */
function vertexModelPath(model: string): { publisher: 'google' | 'anthropic' | 'openapi'; name: string } | null {
  const id = model.trim()
  if (isVertexClaude(id)) return { publisher: 'anthropic', name: id.replace(/^anthropic\//i, '') }
  const bare = id.replace(/^google\//i, '')
  if (!bare.includes('/')) return { publisher: 'google', name: bare }
  if (NATIVE_ONLY_PUBLISHERS.test(bare) || !/^[a-z0-9._-]+\/[A-Za-z0-9._:@-]+$/.test(bare)) return null
  return { publisher: 'openapi', name: bare }
}

/** Vertex's Chat Completions endpoint; the token rides as the Bearer key. */
const vertexOpenApi = createOpenAiCompatibleProvider('vertex', {
  defaultBaseUrl: '',
  includeUsage: true,
  // The base is built from the project and location, never typed; tests aim it at a local mock.
  allowLocal: true
})

/** Gemini 3 takes a thinking level; 2.5 thinks by its own budget. */
function vertexGeminiThinking(req: ProviderChatRequest): Record<string, unknown> | undefined {
  if (!/gemini-3/i.test(req.model)) return undefined
  if (!req.thinking?.enabled) return undefined
  const effort = req.thinking.effort
  return { thinkingLevel: effort === 'minimal' || effort === 'low' ? 'low' : 'high' }
}

export type VertexEndpoint = {
  baseUrl: string
  credentials: GoogleCredentials
  tokenOptions?: GoogleTokenOptions
}

async function authHeaders(endpoint: VertexEndpoint, signal: AbortSignal): Promise<Record<string, string>> {
  const token = await googleAccessToken(endpoint.credentials, { ...endpoint.tokenOptions, signal })
  const quota =
    endpoint.credentials.type === 'authorized_user' ? endpoint.credentials.quota_project_id : undefined
  return { Authorization: `Bearer ${token}`, ...(quota ? { 'x-goog-user-project': quota } : {}) }
}

/** Stream one Vertex call. Exported so tests can aim it at local mocks. */
export async function* streamVertex(req: ProviderChatRequest, endpoint: VertexEndpoint): AsyncGenerator<StreamChunk> {
  const path = vertexModelPath(req.model)
  if (!path) {
    yield {
      type: 'error',
      error: `Vertex AI can't run ${req.model} here: Mistral and AI21 models use routes Agent V does not speak yet. Use a Gemini, Claude or open model (publisher/model).`
    }
    return
  }
  let headers: Record<string, string>
  try {
    headers = await authHeaders(endpoint, req.signal)
  } catch (err) {
    if (req.signal.aborted) throw err
    logProviderFailure('vertex', 'http', { status: 401 })
    yield { type: 'error', error: formatError(err), errorCode: 'PROVIDER_AUTH' }
    return
  }
  const base = endpoint.baseUrl.replace(/\/$/, '')

  if (path.publisher === 'openapi') {
    const { Authorization, ...rest } = headers
    for await (const chunk of vertexOpenApi.streamChat({
      ...req,
      model: path.name,
      baseUrl: `${base}/endpoints/openapi`,
      apiKey: Authorization?.replace(/^Bearer\s+/i, '') ?? '',
      headers: { ...(req.headers ?? {}), ...rest }
    })) {
      if (chunk.type === 'error' && chunk.httpStatus === 401) dropGoogleAccessToken(endpoint.credentials)
      yield chunk
    }
    return
  }

  const modelUrl = `${base}/publishers/${path.publisher}/models/${encodeURIComponent(path.name)}`

  if (path.publisher === 'anthropic') {
    for await (const chunk of streamAnthropicMessages(
      { ...req, model: path.name },
      `${modelUrl}:streamRawPredict`,
      undefined,
      { authHeaders: headers, vertex: true }
    )) {
      if (chunk.type === 'error' && chunk.httpStatus === 401) dropGoogleAccessToken(endpoint.credentials)
      yield chunk
    }
    return
  }

  const body = buildGeminiBody({ ...req, model: path.name })
  const thinkingConfig = vertexGeminiThinking(req)
  if (thinkingConfig) {
    const gen = (body.generationConfig ?? {}) as Record<string, unknown>
    body.generationConfig = { ...gen, thinkingConfig }
  }
  let res: Response
  try {
    res = await fetchWithRetry(
      `${modelUrl}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        signal: req.signal,
        body: JSON.stringify(body)
      },
      { maxAttempts: CHAT_FETCH_MAX_ATTEMPTS }
    )
  } catch (err) {
    if (req.signal.aborted) throw err
    yield providerFetchFailureChunk('vertex', err)
    return
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    if (res.status === 401) dropGoogleAccessToken(endpoint.credentials)
    logProviderFailure('vertex', 'http', { status: res.status })
    yield {
      type: 'error',
      error: formatProviderHttpError(res.status, text, 'vertex'),
      errorCode: 'PROVIDER_HTTP',
      httpStatus: res.status
    }
    return
  }
  yield* consumeGeminiStream(res, req, 'vertex')
}

/** Chat models Vertex serves that this adapter speaks: Gemini, Claude, and open models by `publisher/model`. */
const VERTEX_SKIP_RE = /tts|image|embedding|live|audio|-customtools/i

/**
 * Vertex has no "models this project can call" endpoint, so the list comes
 * from the models.dev `google-vertex` catalog — after a real token exchange,
 * so a bad key or login fails here instead of on the first message.
 */
export async function listVertexModels(
  credentials: GoogleCredentials,
  signal?: AbortSignal,
  tokenOptions?: GoogleTokenOptions
): Promise<ModelInfo[]> {
  await googleAccessToken(credentials, { ...tokenOptions, signal })
  const listings = await modelsDevListings('vertex', { signal })
  const out: ModelInfo[] = []
  const seen = new Set<string>()
  for (const m of listings) {
    // `@default` is models.dev's alias; Vertex's own ids for current Claude
    // models are bare (`claude-sonnet-5-5`), dated ones keep `@date`.
    const id = m.id.replace(/@default$/i, '')
    const open = id.includes('/') && vertexModelPath(id)?.publisher === 'openapi'
    if (!(open || /^(?:claude-|gemini-)/i.test(id)) || VERTEX_SKIP_RE.test(id) || seen.has(id)) continue
    // The registry lists some open models without modalities; they are chat models.
    if (!m.outputModalities.includes('text') && !(open && m.outputModalities.length === 0)) continue
    seen.add(id)
    const vision = m.inputModalities.includes('image')
    out.push(
      baseModelInfo(
        id,
        {
          displayName: m.name,
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
          supportsVision: vision,
          inputModalities: vision ? ['text', 'image'] : ['text'],
          supportsTools: m.toolCall
        },
        'vertex'
      )
    )
  }
  return out
}

export const vertexProvider: LlmProvider = {
  id: 'vertex',
  async listModels(req: ListModelsRequest): Promise<ModelInfo[]> {
    const creds = resolveVertexCredentials(req.apiKey)
    if ('error' in creds) throw new Error(creds.error)
    return listVertexModels(creds, req.signal)
  },
  async *streamChat(req: ProviderChatRequest): AsyncGenerator<StreamChunk> {
    const creds = resolveVertexCredentials(req.apiKey)
    if ('error' in creds) {
      yield { type: 'error', error: creds.error, errorCode: 'PROVIDER_AUTH' }
      return
    }
    if (!req.baseUrl) {
      yield { type: 'error', error: 'Vertex AI needs a Google Cloud project. Set it in Settings → Providers.' }
      return
    }
    yield* streamVertex(req, { baseUrl: req.baseUrl, credentials: creds })
  }
}
