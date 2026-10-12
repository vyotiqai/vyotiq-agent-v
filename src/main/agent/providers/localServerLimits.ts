import type { ModelInfo } from '../../../shared/ipc'

/**
 * What a local OpenAI-compatible server says about the window it really runs
 * a model with. Its `/v1/models` carries no context length, so the app used
 * to assume 128k for an 8k llama.cpp server and size prompts for that.
 *
 * - llama.cpp `llama-server`: `GET /props` → `default_generation_settings.n_ctx`
 *   (one model per server, so it applies to every listed id).
 * - LM Studio: `GET /api/v0/models` → per model `loaded_context_length`
 *   (what it is loaded with), else `max_context_length`.
 *
 * Only for a server on this machine, with a short timeout: a probe must never
 * slow a remote endpoint's model list.
 */

const PROBE_TIMEOUT_MS = 800

function isLocalHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost')
  } catch {
    return false
  }
}

/** The server root: the base URL without a trailing `/v1`. */
function serverRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '')
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  if (!res.ok) return null
  return res.json().catch(() => null)
}

/** llama.cpp's running context, or undefined when this is not a llama.cpp server. */
export async function llamaCppContext(baseUrl: string, signal?: AbortSignal): Promise<number | undefined> {
  try {
    const props = (await getJson(`${serverRoot(baseUrl)}/props`, signal)) as Record<string, unknown> | null
    const settings = props?.default_generation_settings as Record<string, unknown> | undefined
    return positiveInt(settings?.n_ctx) ?? positiveInt(props?.n_ctx)
  } catch {
    return undefined
  }
}

/** LM Studio's per-model windows, or an empty map when this is not LM Studio. */
export async function lmStudioContexts(baseUrl: string, signal?: AbortSignal): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  try {
    const body = (await getJson(`${serverRoot(baseUrl)}/api/v0/models`, signal)) as { data?: unknown } | null
    if (!Array.isArray(body?.data)) return out
    for (const row of body.data as Array<Record<string, unknown>>) {
      const id = typeof row.id === 'string' ? row.id : ''
      const window = positiveInt(row.loaded_context_length) ?? positiveInt(row.max_context_length)
      if (id && window) out.set(id, window)
    }
  } catch {
    // Not LM Studio.
  }
  return out
}

/** The listed models with the local server's real windows (source `server`). */
export async function withLocalServerLimits(
  baseUrl: string,
  models: ModelInfo[],
  signal?: AbortSignal
): Promise<ModelInfo[]> {
  if (!isLocalHost(baseUrl) || models.length === 0) return models
  const [nCtx, lmStudio] = await Promise.all([llamaCppContext(baseUrl, signal), lmStudioContexts(baseUrl, signal)])
  if (!nCtx && lmStudio.size === 0) return models
  return models.map((m) => {
    const window = lmStudio.get(m.id) ?? nCtx
    return window ? { ...m, contextWindow: window, limitsSource: 'server' as const } : m
  })
}

/**
 * Ollama's real window for a model it has loaded: `GET /api/ps` →
 * `context_length` (the `num_ctx` it was loaded with). The OpenAI-compatible
 * endpoint cannot ask for more, so this — not the architecture maximum from
 * `/api/show` — is what a prompt must fit. Undefined when the model is not
 * loaded or the server does not report it.
 */
export async function ollamaLoadedContext(host: string, modelId: string, signal?: AbortSignal): Promise<number | undefined> {
  if (!isLocalHost(host)) return undefined
  try {
    const body = (await getJson(`${host.replace(/\/+$/, '')}/api/ps`, signal)) as { models?: unknown } | null
    if (!Array.isArray(body?.models)) return undefined
    const want = modelId.includes(':') ? modelId : `${modelId}:latest`
    for (const row of body.models as Array<Record<string, unknown>>) {
      const name = typeof row.name === 'string' ? row.name : typeof row.model === 'string' ? row.model : ''
      if (name === modelId || name === want) return positiveInt(row.context_length)
    }
  } catch {
    // Older servers, or none running.
  }
  return undefined
}
