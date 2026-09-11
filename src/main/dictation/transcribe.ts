import { getSecret } from '../settings/secrets'
import { getSettings } from '../settings/settings'
import { fetchWithRetry } from '../agent/providers/fetchWithRetry'
import {
  MAX_DICTATION_BYTES,
  type DictationEngine,
  type DictationTranscribeRequest,
  type DictationTranscribeResult
} from '../../shared/ipc'
import { transcribeLocalDictation } from './local'

const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions'
const OPENAI_TRANSCRIBE_MODEL = 'gpt-transcribe'
export const OPENROUTER_TRANSCRIBE_URL = 'https://openrouter.ai/api/v1/audio/transcriptions'
export const OPENROUTER_TRANSCRIBE_MODEL = 'openai/gpt-transcribe'
export const OPENROUTER_REFERER = 'https://vyotiq.com'
export const OPENROUTER_TITLE = 'Vyotiq'

export const DICTATION_FIXTURE_TEXT = 'E2E dictation transcript.'

export function isDictationFixtureEnabled(): boolean {
  if (process.env.VITEST === 'true') return false
  return process.env.VYOTIQ_E2E_FIXTURE === '1'
}

function extensionForMime(mime: string): string {
  const base = mime.split(';')[0]?.trim().toLowerCase() ?? ''
  if (base === 'audio/wav' || base === 'audio/wave' || base === 'audio/x-wav') return 'wav'
  if (base === 'audio/mpeg' || base === 'audio/mp3') return 'mp3'
  if (base === 'audio/mp4' || base === 'audio/m4a' || base === 'audio/x-m4a') return 'm4a'
  if (base === 'audio/ogg') return 'ogg'
  return 'webm'
}

function decodeAudioBytes(data: string): Buffer {
  let bytes: Buffer
  try {
    bytes = Buffer.from(data, 'base64')
  } catch {
    throw new Error('Invalid dictation audio encoding')
  }
  if (bytes.byteLength === 0) {
    throw new Error('Dictation audio is empty')
  }
  if (bytes.byteLength > MAX_DICTATION_BYTES) {
    throw new Error(`Dictation audio exceeds the ${MAX_DICTATION_BYTES} byte limit`)
  }
  return bytes
}

async function postCloudTranscription(opts: {
  url: string
  apiKey?: string
  model: string
  bytes: Buffer
  mime: string
  extraHeaders?: Record<string, string>
  signal?: AbortSignal
}): Promise<DictationTranscribeResult> {
  const form = new FormData()
  const blob = new Blob([new Uint8Array(opts.bytes)], { type: opts.mime })
  form.append('file', blob, `dictation.${extensionForMime(opts.mime)}`)
  form.append('model', opts.model)

  const apiKey = opts.apiKey?.trim()
  let res: Response
  try {
    res = await fetchWithRetry(
      opts.url,
      {
        method: 'POST',
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...(opts.extraHeaders ?? {})
        },
        body: form,
        signal: opts.signal
      },
      { maxAttempts: 2, circuitKey: false }
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Dictation request failed: ${msg}`)
  }

  const raw = await res.text()
  if (!res.ok) {
    let detail = raw.slice(0, 400)
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string } }
      if (parsed.error?.message) detail = parsed.error.message
    } catch {
      // keep raw snippet
    }
    throw new Error(`Dictation failed (${res.status}): ${detail}`)
  }

  let text = ''
  try {
    const parsed = JSON.parse(raw) as { text?: unknown }
    if (typeof parsed.text === 'string') text = parsed.text
  } catch {
    text = raw
  }
  text = text.trim()
  if (!text) {
    throw new Error('Dictation returned empty transcript')
  }
  return { text }
}

async function transcribeOpenAi(
  request: DictationTranscribeRequest,
  signal?: AbortSignal
): Promise<DictationTranscribeResult> {
  const bytes = decodeAudioBytes(request.data)
  const apiKey = getSecret('openai')
  if (!apiKey?.trim()) {
    throw new Error('Add an OpenAI API key in Settings → Providers to use dictation')
  }
  const mime = (request.mime || 'audio/webm').split(';')[0]?.trim() || 'audio/webm'
  return postCloudTranscription({
    url: OPENAI_TRANSCRIBE_URL,
    apiKey: apiKey.trim(),
    model: OPENAI_TRANSCRIBE_MODEL,
    bytes,
    mime,
    signal
  })
}

async function transcribeOpenRouter(
  request: DictationTranscribeRequest,
  signal?: AbortSignal
): Promise<DictationTranscribeResult> {
  const bytes = decodeAudioBytes(request.data)
  const apiKey = getSecret('openrouter')
  if (!apiKey?.trim()) {
    throw new Error('Add an OpenRouter API key in Settings → Providers to use dictation')
  }
  const mime = (request.mime || 'audio/webm').split(';')[0]?.trim() || 'audio/webm'
  return postCloudTranscription({
    url: OPENROUTER_TRANSCRIBE_URL,
    apiKey: apiKey.trim(),
    model: OPENROUTER_TRANSCRIBE_MODEL,
    bytes,
    mime,
    extraHeaders: {
      'HTTP-Referer': OPENROUTER_REFERER,
      'X-Title': OPENROUTER_TITLE
    },
    signal
  })
}

function currentEngine(): DictationEngine {
  try {
    return getSettings().dictation?.engine ?? 'openai'
  } catch {
    return 'openai'
  }
}

/**
 * Transcribe a short mic recording. Engine is read from settings at call time.
 * Keys stay in main; renderer never sees the secret.
 */
export async function transcribeDictation(
  request: DictationTranscribeRequest,
  signal?: AbortSignal
): Promise<DictationTranscribeResult> {
  if (isDictationFixtureEnabled()) {
    return { text: DICTATION_FIXTURE_TEXT }
  }

  const engine = currentEngine()
  switch (engine) {
    case 'openai':
      return transcribeOpenAi(request, signal)
    case 'openrouter':
      return transcribeOpenRouter(request, signal)
    case 'local':
      return transcribeLocalDictation(request, signal)
    default: {
      const _exhaustive: never = engine
      return _exhaustive
    }
  }
}
