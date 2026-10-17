/**
 * Voice models from the providers themselves (D-36, D-37): what Settings
 * offers, and which voices each OpenRouter speech model takes. Fetched in
 * main (keys never leave it) and cached for a day per provider and key.
 *
 * - OpenRouter, both directions: its public model list, no key.
 *   Speech models carry `supported_voices`.
 * - OpenAI: `/v1/models` with your key, filtered to speech and transcription.
 * - ElevenLabs (speaking): `/v1/models` with your key.
 * - Everyone else is curated in `shared/voice.ts`, with the reason.
 *
 * A failed fetch falls back to the curated models and says why, so the
 * picker is never empty.
 */
import {
  sttEntry,
  ttsEntry,
  voiceDetail,
  voiceErrorFromStatus,
  type SttProviderId,
  type TtsProviderId,
  type VoiceModelOption
} from '../../shared/voice'
import type { VoiceModelInfo, VoiceModelList, VoiceOpenRouterCredit } from '../../shared/ipc/schemas/voice'
import { toVoiceError, VoiceError } from './errors'
import { readVoiceSourceKey } from './keys'

export const MODEL_CACHE_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
export const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key'
export const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models'
export const ELEVENLABS_MODELS_URL = 'https://api.elevenlabs.io/v1/models'

/**
 * Per-second audio prices above this aren't per second (two models list
 * 0.1 and 0.36, i.e. $6–$21 a minute): their unit is unclear, so no price
 * is shown rather than a wrong one.
 */
const MAX_PLAUSIBLE_PER_MIN = 1

type Direction = 'stt' | 'tts'
type Fetched = { models: VoiceModelInfo[]; voices: Map<string, string[]> }
type Entry = { at: number; list: VoiceModelList; voices: Map<string, string[]> }

const cache = new Map<string, Entry>()
/**
 * A fetch that just failed is not tried again for this long: offline, every
 * Settings render and every reply's `prepareVoiceModels` asked again, each
 * waiting out the timeout. Refresh in Settings still asks at once.
 */
export const FAILED_RETRY_MS = 60_000
const failed = new Map<string, { at: number; error: VoiceModelList['error']; detail?: string }>()
let fetchImpl: typeof fetch = (...args) => fetch(...args)

/** Tests only: a fake `fetch`, and an empty cache. */
export function setModelCatalogFetchForTests(fn: typeof fetch | null): void {
  fetchImpl = fn ?? ((...args) => fetch(...args))
  cache.clear()
  failed.clear()
}

function entryFor(direction: Direction, provider: string) {
  return direction === 'stt' ? sttEntry(provider as SttProviderId) : ttsEntry(provider as TtsProviderId)
}

function curated(models: readonly VoiceModelOption[]): VoiceModelInfo[] {
  return models.map((m) => ({ id: m.id, label: m.label, ...(m.recommended ? { recommended: true } : {}) }))
}

/** A dollar amount at a readable precision: $0.02, $0.0045, $0.00062. */
export function formatUsd(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`
  if (n >= 0.01) return `$${Number(n.toFixed(3))}`
  return `$${Number(n.toPrecision(2))}`
}

type OpenRouterModel = {
  id?: string
  name?: string
  pricing?: { prompt?: string; completion?: string }
  supported_voices?: unknown
}

/**
 * OpenRouter prices speech per character of input and transcription per
 * second of audio, both as `pricing.prompt` with `completion` "0". Models
 * priced by tokens (completion > 0) get no price: there's no honest per-
 * character figure for them.
 */
export function openRouterPrice(direction: Direction, pricing: OpenRouterModel['pricing']): string | undefined {
  const prompt = Number(pricing?.prompt ?? NaN)
  const completion = Number(pricing?.completion ?? NaN)
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return undefined
  if (prompt === 0 && completion === 0) return 'Free'
  if (completion !== 0 || prompt <= 0) return undefined
  if (direction === 'tts') return `${formatUsd(prompt * 1000)} / 1k characters`
  const perMin = prompt * 60
  return perMin <= MAX_PLAUSIBLE_PER_MIN ? `${formatUsd(perMin)} / min` : undefined
}

async function getJson(url: string, headers: Record<string, string>, label: string): Promise<unknown> {
  let res: Response
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (err) {
    throw toVoiceError(err)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new VoiceError(voiceErrorFromStatus(res.status), `${label} model list (${res.status}): ${text.slice(0, 200)}`)
  }
  return res.json()
}

async function fetchOpenRouter(direction: Direction): Promise<Fetched> {
  const modality = direction === 'tts' ? 'speech' : 'transcription'
  const body = (await getJson(`${OPENROUTER_MODELS_URL}?output_modalities=${modality}`, {}, 'OpenRouter')) as {
    data?: OpenRouterModel[]
  }
  const voices = new Map<string, string[]>()
  const models: VoiceModelInfo[] = []
  for (const m of body.data ?? []) {
    if (!m.id) continue
    const price = openRouterPrice(direction, m.pricing)
    models.push({ id: m.id, label: m.name || m.id, ...(price ? { price } : {}) })
    if (Array.isArray(m.supported_voices)) {
      voices.set(
        m.id,
        m.supported_voices.filter((v): v is string => typeof v === 'string' && v.length > 0)
      )
    }
  }
  return { models, voices }
}

async function fetchOpenAi(direction: Direction, key: string): Promise<Fetched> {
  const body = (await getJson(OPENAI_MODELS_URL, { Authorization: `Bearer ${key}` }, 'OpenAI')) as { data?: Array<{ id?: string }> }
  // Speaking: the TTS models. Listening: the transcription models the realtime socket takes.
  const wanted = direction === 'tts' ? /(^|-)tts(-|$)/ : /transcribe|^whisper/
  const models = (body.data ?? [])
    .flatMap((m) => (m.id && wanted.test(m.id) ? [{ id: m.id, label: m.id }] : []))
    .sort((a, b) => a.id.localeCompare(b.id))
  return { models, voices: new Map() }
}

async function fetchElevenLabs(key: string): Promise<Fetched> {
  const body = (await getJson(ELEVENLABS_MODELS_URL, { 'xi-api-key': key }, 'ElevenLabs')) as Array<{
    model_id?: string
    name?: string
    can_do_text_to_speech?: boolean
  }>
  const models = (Array.isArray(body) ? body : []).flatMap((m) =>
    m.model_id && m.can_do_text_to_speech ? [{ id: m.model_id, label: m.name || m.model_id }] : []
  )
  return { models, voices: new Map() }
}

/** Recommended first (the catalog's pick), then the provider's order. */
function withRecommended(models: VoiceModelInfo[], catalog: readonly VoiceModelOption[]): VoiceModelInfo[] {
  const pick = catalog.find((m) => m.recommended)?.id
  const marked = models.map((m) => (m.id === pick ? { ...m, recommended: true } : m))
  return [...marked.filter((m) => m.recommended), ...marked.filter((m) => !m.recommended)]
}

/**
 * The models for one provider and direction. Never throws: a provider
 * without a list, a missing key or a failed fetch all return the curated
 * models, with the reason when something went wrong.
 */
export async function listVoiceModels(direction: Direction, provider: string, refresh = false): Promise<VoiceModelList> {
  const entry = entryFor(direction, provider)
  const fallback = curated(entry.models)
  if (entry.modelList.from === 'curated') return { source: 'curated', models: fallback }

  const key = provider === 'openrouter' ? '' : readVoiceSourceKey(entry.key)
  // OpenAI and ElevenLabs list models only for a key; until there's one, the curated models stand.
  if (provider !== 'openrouter' && !key) return { source: 'curated', models: fallback }

  const cacheKey = `${direction}:${provider}:${key ? key.slice(-6) : ''}`
  const hit = cache.get(cacheKey)
  if (!refresh && hit && Date.now() - hit.at < MODEL_CACHE_MS) return hit.list
  const lastFailure = failed.get(cacheKey)
  if (!refresh && lastFailure && Date.now() - lastFailure.at < FAILED_RETRY_MS) {
    const why = { error: lastFailure.error, ...(lastFailure.detail ? { detail: lastFailure.detail } : {}) }
    return hit ? { ...hit.list, ...why } : { source: 'curated', models: fallback, ...why }
  }

  try {
    const fetched =
      provider === 'openrouter'
        ? await fetchOpenRouter(direction)
        : provider === 'openai'
          ? await fetchOpenAi(direction, key!)
          : await fetchElevenLabs(key!)
    if (fetched.models.length === 0) throw new VoiceError('engine_failed', 'The provider listed no models for this')
    const list: VoiceModelList = { source: 'api', fetchedAt: Date.now(), models: withRecommended(fetched.models, entry.models) }
    cache.set(cacheKey, { at: Date.now(), list, voices: fetched.voices })
    failed.delete(cacheKey)
    return list
  } catch (err) {
    const e = toVoiceError(err)
    const detail = voiceDetail(e.message)
    failed.set(cacheKey, { at: Date.now(), error: e.code, ...(detail ? { detail } : {}) })
    // A stale list beats none: keep serving it, and say the refresh failed.
    if (hit) return { ...hit.list, error: e.code, ...(detail ? { detail } : {}) }
    return { source: 'curated', models: fallback, error: e.code, ...(detail ? { detail } : {}) }
  }
}

/**
 * The voices an OpenRouter speech model takes, from the cached list; null
 * when the list hasn't been fetched or the model isn't in it. Synchronous,
 * for the speaking paths: call `prepareVoiceModels` first.
 */
export function cachedModelVoices(provider: TtsProviderId, model: string): string[] | null {
  if (provider !== 'openrouter') return null
  for (const [k, entry] of cache) {
    if (k.startsWith('tts:openrouter:')) return entry.voices.get(model) ?? null
  }
  return null
}

/** OpenRouter refuses audio input below this balance (402), checked 2026-10-14. */
export const OPENROUTER_AUDIO_MIN_USD = 0.5

/**
 * What OpenRouter's `/api/v1/key` says about credit, for Settings (A-08).
 * It can't see the balance (that takes a management key), only whether the
 * account ever paid and this key's own limit. Never throws.
 */
export async function openRouterCredit(): Promise<VoiceOpenRouterCredit> {
  const key = readVoiceSourceKey({ kind: 'chat', provider: 'openrouter' })
  if (!key) return { status: 'unknown' }
  try {
    const body = (await getJson(OPENROUTER_KEY_URL, { Authorization: `Bearer ${key}` }, 'OpenRouter key')) as {
      data?: { is_free_tier?: unknown; limit_remaining?: unknown }
    }
    const d = body.data ?? {}
    const keyRemaining = typeof d.limit_remaining === 'number' && Number.isFinite(d.limit_remaining) ? d.limit_remaining : undefined
    const remaining = keyRemaining !== undefined ? { keyRemaining } : {}
    if (d.is_free_tier === true) return { status: 'low', reason: 'never_paid', ...remaining }
    if (keyRemaining !== undefined && keyRemaining < OPENROUTER_AUDIO_MIN_USD) return { status: 'low', reason: 'key_limit', keyRemaining }
    return { status: 'ok', ...remaining }
  } catch {
    return { status: 'unknown' }
  }
}

/** Make sure a speaking provider's list (and its voices) is cached before speaking; never throws. */
export async function prepareVoiceModels(provider: TtsProviderId): Promise<void> {
  if (provider !== 'openrouter') return
  await listVoiceModels('tts', provider)
}
