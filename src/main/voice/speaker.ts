/**
 * Speaking one piece of text aloud, outside a live voice session: the voice
 * preview in Settings and the speaker button on an answer
 * (docs/voice-mode.md §13.4, Phase 3). One utterance at a time; a new one
 * stops the last. Audio goes to the renderer through the sink.
 */
import { randomUUID } from 'crypto'
import { extractSpokenBlock } from '../../shared/spokenSummary'
import {
  clampSpeed,
  resolveModel,
  resolveTtsProvider,
  ttsEntry,
  type TtsProviderId,
  type VoiceErrorCode
} from '../../shared/voice'
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from '../../shared/ipc/schemas/voice'
import { VoiceError, toVoiceError } from './errors'
import { readVoiceSourceKey, requireVoiceSourceKey, voiceKeyAvailability } from './keys'
import { ttsProvider } from './providers/registry'
import type { VoiceOption } from './providers/types'
import { SentenceSplitter, fallbackSummary, toSpeakable } from './speechText'

export type SpeakKind =
  /** An agent answer: its `<spoken>` block, or the first few sentences of it. */
  | 'answer'
  /** Exactly this text (Settings preview). */
  | 'plain'

export type SpeakOptions = {
  text: string
  kind: SpeakKind
  /** Overrides for a preview of a not-yet-saved choice. */
  provider?: TtsProviderId
  voiceId?: string
  speed?: number
}

export type SpeakAudio = { utteranceId: string; seq: number; sampleRate: number; pcm: Int16Array }

export type SpeakSink = {
  audio(chunk: SpeakAudio): void
  /** All audio delivered (or stopped, or failed with `error`). */
  end(utteranceId: string, error?: VoiceErrorCode): void
}

export type SpeakStarted = { utteranceId: string; provider: TtsProviderId; voiceId: string }

/** What to say for an agent answer (§8.2). */
export function spokenTextForAnswer(answer: string): string {
  const block = extractSpokenBlock(answer)
  if (block) return toSpeakable(block)
  return fallbackSummary(answer)
}

type Current = { id: string; ctrl: AbortController }
let current: Current | null = null

export function stopSpeaking(utteranceId?: string): void {
  if (!current || (utteranceId && current.id !== utteranceId)) return
  current.ctrl.abort()
  current = null
}

export function speak(opts: SpeakOptions, sink: SpeakSink, settings: VoiceSettings = DEFAULT_VOICE_SETTINGS): SpeakStarted {
  const resolved = opts.provider
    ? { ok: true as const, id: opts.provider }
    : resolveTtsProvider(settings.ttsProvider, voiceKeyAvailability())
  if (!resolved.ok) throw new VoiceError('no_key', 'No text-to-speech provider has a key')
  const entry = ttsEntry(resolved.id)
  const apiKey = requireVoiceSourceKey(entry.key)
  const text = opts.kind === 'answer' ? spokenTextForAnswer(opts.text) : opts.text.trim()
  if (!text) throw new VoiceError('engine_failed', 'Nothing to say')

  stopSpeaking()
  const utteranceId = randomUUID()
  const ctrl = new AbortController()
  current = { id: utteranceId, ctrl }
  const voiceId = opts.voiceId ?? settings.tts[entry.id]?.voiceId ?? entry.defaultVoice.id
  let seq = 0
  let failed: VoiceErrorCode | undefined

  const stream = ttsProvider(entry.id).stream({
    apiKey,
    model: resolveModel(entry.models, settings.tts[entry.id]?.model),
    voiceId,
    speed: clampSpeed(opts.speed ?? settings.speed, entry.caps.speed),
    contextId: utteranceId,
    signal: ctrl.signal,
    onAudio: (chunk) => {
      if (!ctrl.signal.aborted) sink.audio({ utteranceId, seq: seq++, sampleRate: chunk.sampleRate, pcm: chunk.pcm })
    },
    onError: (code) => {
      failed ??= code
    }
  })

  const splitter = new SentenceSplitter()
  for (const piece of [...splitter.push(text), ...splitter.flush()]) {
    stream.pushText(piece)
    stream.flush()
  }
  stream.end()

  void stream.done().then(
    () => {
      if (current?.id === utteranceId) current = null
      sink.end(utteranceId, failed)
    },
    (err: unknown) => {
      if (current?.id === utteranceId) current = null
      sink.end(utteranceId, toVoiceError(err).code)
    }
  )
  return { utteranceId, provider: entry.id, voiceId }
}

const voiceCache = new Map<string, { at: number; voices: VoiceOption[] }>()
const VOICE_CACHE_MS = 24 * 60 * 60 * 1000

/** The voices for a provider, fetched with your key and cached for a day (§13.7). */
export async function listVoices(id: TtsProviderId, refresh = false): Promise<VoiceOption[]> {
  const entry = ttsEntry(id)
  const provider = ttsProvider(id)
  const key = readVoiceSourceKey(entry.key)
  const fallback: VoiceOption[] = entry.defaultVoice.id ? [{ id: entry.defaultVoice.id, label: entry.defaultVoice.label }] : []
  if (!provider.listVoices) return fallback
  if (!key && entry.key.kind !== 'none') {
    // No key yet: fixed lists (OpenAI) still show; vendor lists need the key.
    return entry.caps.voiceList ? fallback : provider.listVoices('')
  }
  const cacheKey = `${id}:${key?.slice(-6) ?? ''}`
  const hit = voiceCache.get(cacheKey)
  if (!refresh && hit && Date.now() - hit.at < VOICE_CACHE_MS) return hit.voices
  try {
    const voices = await provider.listVoices(key ?? '', AbortSignal.timeout(10_000))
    voiceCache.set(cacheKey, { at: Date.now(), voices })
    return voices.length > 0 ? voices : fallback
  } catch (err) {
    const status = (err as { status?: number }).status
    if (status === 401 || status === 403) throw new VoiceError('rejected_key', `voice list HTTP ${status}`)
    throw toVoiceError(err)
  }
}
