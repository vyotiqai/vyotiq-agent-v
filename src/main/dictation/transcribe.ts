import { getSecret } from '../settings/secrets'
import { getSettings } from '../settings/settings'
import { fetchWithRetry } from '../agent/providers/fetchWithRetry'
import {
  MAX_DICTATION_BYTES,
  type DictationEngine,
  type DictationTranscribeRequest,
  type DictationTranscribeResult
} from '../../shared/ipc'
import { DictationError } from './errors'
import { transcribeLocalDictation } from './local'

const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions'
const OPENAI_TRANSCRIBE_MODEL = 'gpt-transcribe'
export const OPENROUTER_TRANSCRIBE_URL = 'https://openrouter.ai/api/v1/audio/transcriptions'
export const OPENROUTER_TRANSCRIBE_MODEL = 'openai/gpt-transcribe'
export const OPENROUTER_REFERER = 'https://vyotiq.com'
export const OPENROUTER_TITLE = 'Vyotiq'

export const DICTATION_FIXTURE_TEXT = 'E2E dictation transcript.'

const PCM_SAMPLE_RATE = 16000

type CloudEngine = Exclude<DictationEngine, 'local'>

const CLOUD_LABEL: Record<CloudEngine, string> = { openai: 'OpenAI', openrouter: 'OpenRouter' }

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

function decodeBase64(data: string, what: string): Buffer {
  const bytes = Buffer.from(data, 'base64')
  if (bytes.byteLength === 0) throw new DictationError('engine_failed', `The ${what} is empty`)
  return bytes
}

/** A 44-byte RIFF header in front of 16 kHz mono Int16 PCM: what the cloud APIs take. */
export function pcm16kToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.byteLength, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(PCM_SAMPLE_RATE, 24)
  header.writeUInt32LE(PCM_SAMPLE_RATE * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.byteLength, 40)
  return Buffer.concat([header, pcm])
}

/** The audio as the cloud APIs take it: a WAV from the take's PCM, or the file as given. */
function cloudAudio(request: DictationTranscribeRequest, engine: CloudEngine): { bytes: Buffer; mime: string } {
  const bytes = request.pcm16k
    ? pcm16kToWav(decodeBase64(request.pcm16k, 'recording'))
    : decodeBase64(request.data ?? '', 'recording')
  if (bytes.byteLength > MAX_DICTATION_BYTES) {
    throw new DictationError('too_long', `This take is too long for ${CLOUD_LABEL[engine]}`)
  }
  const mime = request.pcm16k ? 'audio/wav' : (request.mime || 'audio/webm').split(';')[0]?.trim() || 'audio/webm'
  return { bytes, mime }
}

function isAbort(err: unknown): boolean {
  return (err instanceof Error || err instanceof DOMException) && err.name === 'AbortError'
}

/** The provider's own words, trimmed to one readable line. */
function providerDetail(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } }
    if (parsed.error?.message) return parsed.error.message.split('\n')[0]!.slice(0, 160)
  } catch {
    // not JSON
  }
  return raw.replace(/\s+/g, ' ').trim().slice(0, 160)
}

async function postCloudTranscription(opts: {
  engine: CloudEngine
  url: string
  apiKey: string
  model: string
  audio: { bytes: Buffer; mime: string }
  language?: string
  prompt?: string
  keywords?: readonly string[]
  extraHeaders?: Record<string, string>
  allowEmpty: boolean
  signal?: AbortSignal
}): Promise<DictationTranscribeResult> {
  const label = CLOUD_LABEL[opts.engine]
  const form = new FormData()
  const blob = new Blob([new Uint8Array(opts.audio.bytes)], { type: opts.audio.mime })
  form.append('file', blob, `dictation.${extensionForMime(opts.audio.mime)}`)
  form.append('model', opts.model)
  if (opts.language) form.append('language', opts.language)
  if (opts.prompt) form.append('prompt', opts.prompt)
  for (const keyword of opts.keywords ?? []) form.append('keywords[]', keyword)

  let res: Response
  try {
    res = await fetchWithRetry(
      opts.url,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, ...(opts.extraHeaders ?? {}) },
        body: form,
        signal: opts.signal
      },
      { maxAttempts: 2, circuitKey: false }
    )
  } catch (err) {
    if (isAbort(err)) throw err
    throw new DictationError('offline', `No connection — ${label} could not be reached`)
  }

  const raw = await res.text()
  if (!res.ok) {
    const detail = providerDetail(raw)
    switch (res.status) {
      case 401:
      case 403:
        throw new DictationError('rejected_key', `${label} turned the key down (${res.status})`)
      case 429:
        throw new DictationError('rate_limited', `${label} is rate-limiting this key (429)`)
      case 413:
        throw new DictationError('too_long', `This take is too long for ${label}`)
      default:
        throw new DictationError(
          'engine_failed',
          detail ? `${label} could not transcribe this (${res.status}): ${detail}` : `${label} could not transcribe this (${res.status})`
        )
    }
  }

  let text = ''
  try {
    const parsed = JSON.parse(raw) as { text?: unknown }
    if (typeof parsed.text === 'string') text = parsed.text
  } catch {
    text = raw
  }
  text = text.trim()
  if (!text && !opts.allowEmpty) throw new DictationError('engine_failed', 'Nothing was heard in that take')
  return { text }
}

export function requireKey(engine: CloudEngine): string {
  const key = getSecret(engine)?.trim()
  if (!key) throw new DictationError('no_key', `Add an ${CLOUD_LABEL[engine]} key to dictate with ${CLOUD_LABEL[engine]}`)
  return key
}

/** What main adds to a request that the renderer does not send. */
export type DictationRequestExtras = {
  /** Names from the open workspace to listen for (OpenAI only). */
  keywords?: readonly string[]
}

function transcribeCloud(
  engine: CloudEngine,
  request: DictationTranscribeRequest,
  signal?: AbortSignal,
  extras: DictationRequestExtras = {}
): Promise<DictationTranscribeResult> {
  const apiKey = requireKey(engine)
  const audio = cloudAudio(request, engine)
  const language = request.language?.trim() || undefined
  const prompt = request.prompt?.trim() || undefined
  const allowEmpty = request.allowEmpty === true
  if (engine === 'openai') {
    return postCloudTranscription({
      engine,
      url: OPENAI_TRANSCRIBE_URL,
      apiKey,
      model: OPENAI_TRANSCRIBE_MODEL,
      audio,
      language,
      prompt,
      keywords: extras.keywords?.length ? extras.keywords : undefined,
      allowEmpty,
      signal
    })
  }
  // OpenRouter accepts `prompt` and ignores it, and takes no keywords: send neither.
  return postCloudTranscription({
    engine,
    url: OPENROUTER_TRANSCRIBE_URL,
    apiKey,
    model: OPENROUTER_TRANSCRIBE_MODEL,
    audio,
    language,
    allowEmpty,
    extraHeaders: { 'HTTP-Referer': OPENROUTER_REFERER, 'X-Title': OPENROUTER_TITLE },
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
 * Transcribe one piece of a take (or a whole recording). The engine is the
 * request's override, else the one in settings at call time. Keys stay in
 * main; the renderer never sees a secret. Failures are `DictationError`s.
 */
export async function transcribeDictation(
  request: DictationTranscribeRequest,
  signal?: AbortSignal,
  extras: DictationRequestExtras = {}
): Promise<DictationTranscribeResult> {
  if (isDictationFixtureEnabled()) {
    return { text: DICTATION_FIXTURE_TEXT }
  }

  const engine = request.engine ?? currentEngine()
  switch (engine) {
    case 'openai':
    case 'openrouter':
      return transcribeCloud(engine, request, signal, extras)
    case 'local':
      return transcribeLocalDictation(request, signal)
    default: {
      const _exhaustive: never = engine
      return _exhaustive
    }
  }
}
