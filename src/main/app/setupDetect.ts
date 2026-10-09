import type { ProviderId, SetupDetection, SetupLocalServer } from '../../shared/ipc'

/**
 * What Set up can offer before anyone types a key: API keys already in the
 * environment the app was started with, and model servers running on this
 * machine. Keys never leave main: the renderer learns only which providers
 * have one, and "Use it" copies the value into the key vault here.
 */

/** Environment variables each provider's own tools read, first match wins. */
export const PROVIDER_ENV_KEYS: Readonly<Partial<Record<ProviderId, readonly string[]>>> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  groq: ['GROQ_API_KEY'],
  xai: ['XAI_API_KEY'],
  mistral: ['MISTRAL_API_KEY']
}

/** Plausibly a key: long enough, one token, printable. */
function looksLikeKey(value: string | undefined): value is string {
  const v = value?.trim()
  return Boolean(v && v.length >= 16 && v.length <= 512 && !/\s/.test(v))
}

export function envKeyFor(provider: ProviderId, env: NodeJS.ProcessEnv = process.env): { name: string; value: string } | null {
  for (const name of PROVIDER_ENV_KEYS[provider] ?? []) {
    const value = env[name]
    if (looksLikeKey(value)) return { name, value: value.trim() }
  }
  return null
}

const LOCAL_SERVERS: readonly { id: SetupLocalServer['id']; name: string; baseUrl: string; listUrl: string }[] = [
  { id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434', listUrl: 'http://127.0.0.1:11434/api/tags' },
  { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', listUrl: 'http://127.0.0.1:1234/v1/models' }
]

const PROBE_TIMEOUT_MS = 1_500

/** Model ids from Ollama's `/api/tags` or an OpenAI-style `/v1/models`. */
export function localModelIds(body: unknown): string[] {
  const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const rows = Array.isArray(o.models) ? o.models : Array.isArray(o.data) ? o.data : []
  return rows
    .map((row) => {
      const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {}
      return typeof r.name === 'string' ? r.name : typeof r.id === 'string' ? r.id : typeof r.model === 'string' ? r.model : ''
    })
    .filter(Boolean)
}

export async function detectSetupOptions(
  deps: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; hasKey?: (provider: ProviderId) => boolean } = {}
): Promise<SetupDetection> {
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetchImpl ?? fetch
  const envKeys = (Object.keys(PROVIDER_ENV_KEYS) as ProviderId[])
    .filter((provider) => !deps.hasKey?.(provider))
    .flatMap((provider) => {
      const found = envKeyFor(provider, env)
      return found ? [{ provider, envVar: found.name }] : []
    })
  const local = (
    await Promise.all(
      LOCAL_SERVERS.map(async (server): Promise<SetupLocalServer | null> => {
        try {
          const res = await fetchImpl(server.listUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
          if (!res.ok) return null
          const models = localModelIds(await res.json())
          return { id: server.id, name: server.name, baseUrl: server.baseUrl, models: models.slice(0, 50) }
        } catch {
          return null
        }
      })
    )
  ).filter((s): s is SetupLocalServer => s !== null)
  return { envKeys, local }
}
