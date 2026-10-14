/**
 * Voice mode: the provider catalog and the pure rules around it.
 *
 * Settings, the voice bar, key management and the fallback logic all read
 * this catalog, so a provider is added here once and every surface picks it
 * up (docs/voice-mode.md §9.6). Nothing in this file talks to a network or
 * touches a key; it must stay importable from main and renderer alike.
 */
import { redactSecretsInText } from './utils/redactSecrets'

export const STT_PROVIDER_IDS = ['deepgram', 'assemblyai', 'elevenlabs', 'openai', 'openrouter', 'local'] as const
export type SttProviderId = (typeof STT_PROVIDER_IDS)[number]

export const TTS_PROVIDER_IDS = ['elevenlabs', 'cartesia', 'openai', 'openrouter'] as const
export type TtsProviderId = (typeof TTS_PROVIDER_IDS)[number]

/**
 * Vendors whose keys live in the voice namespace of `secrets.ts`. OpenAI and
 * OpenRouter are not here: their keys are the chat-provider keys, reused.
 */
export const VOICE_KEY_VENDORS = ['deepgram', 'assemblyai', 'elevenlabs', 'cartesia'] as const
export type VoiceKeyVendor = (typeof VOICE_KEY_VENDORS)[number]

/** Where a provider's key comes from. `none` runs on this machine. */
export type VoiceKeySource =
  | { kind: 'voice'; vendor: VoiceKeyVendor }
  | { kind: 'chat'; provider: 'openai' | 'openrouter' }
  | { kind: 'none' }

export type VoiceModelOption = {
  id: string
  label: string
  /** Shown as "Recommended" and used when the user hasn't picked one. */
  recommended?: boolean
}

/**
 * Where a provider's models come from (D-36). `api`: fetched from the
 * provider, so any model it lists may be picked and `models` is only the
 * fallback when the fetch fails. `curated`: `models` is the whole list, and
 * `why` says why (shown under the picker).
 */
export type VoiceModelSource = { from: 'api' } | { from: 'curated'; why: string }

export type SttCatalogEntry = {
  id: SttProviderId
  label: string
  /** One short trait for the picker row ("Fastest turn detection"). */
  trait: string
  key: VoiceKeySource
  models: readonly VoiceModelOption[]
  modelList: VoiceModelSource
  caps: {
    /** The provider decides when the speaker has finished. */
    turnDetection: boolean
    /** Accepts vocabulary hints (workspace identifiers). */
    keyterms: boolean
    /** Streams partial words while you speak. */
    streaming: boolean
    languages: 'en' | 'multi'
  }
  /** The privacy line shown beside the picker. */
  privacy: string
  /** Not yet ready for everyone; labelled in the UI. */
  beta?: boolean
}

export type TtsCatalogEntry = {
  id: TtsProviderId
  label: string
  trait: string
  key: VoiceKeySource
  models: readonly VoiceModelOption[]
  modelList: VoiceModelSource
  caps: {
    /** Text can be streamed in as it is written (websocket input). */
    streamingInput: boolean
    /** Inclusive speaking-speed range the provider accepts. */
    speed: readonly [min: number, max: number]
    /** Vendor expressiveness markup (pauses, emotion); unused in v1 (D-08). */
    supportsMarkup: boolean
    /** The voice list can be fetched with the user's key. */
    voiceList: boolean
  }
  /** Used before the user picks one, and when the voice list can't be fetched. */
  defaultVoice: { id: string; label: string }
  privacy: string
}

export const STT_CATALOG: readonly SttCatalogEntry[] = [
  {
    id: 'deepgram',
    label: 'Deepgram Flux',
    trait: 'Knows when you’ve finished talking',
    key: { kind: 'voice', vendor: 'deepgram' },
    models: [
      { id: 'flux-general-en', label: 'Flux · English', recommended: true },
      { id: 'flux-general-multi', label: 'Flux · Multilingual' }
    ],
    // Deepgram's /v1/models lists 460 listening models and no Flux one; this listener speaks only Flux (v2/listen).
    modelList: { from: 'curated', why: 'Deepgram’s model list has no Flux models, the only ones this listener uses.' },
    caps: { turnDetection: true, keyterms: true, streaming: true, languages: 'multi' },
    privacy: 'Audio goes to Deepgram'
  },
  {
    id: 'assemblyai',
    label: 'AssemblyAI',
    trait: 'Accurate, with turn detection',
    key: { kind: 'voice', vendor: 'assemblyai' },
    models: [
      { id: 'universal-3-6-pro', label: 'Universal-3.6 Pro', recommended: true },
      { id: 'universal-streaming-english', label: 'Universal Streaming · English' },
      { id: 'universal-streaming-multilingual', label: 'Universal Streaming · Multilingual' }
    ],
    modelList: { from: 'curated', why: 'AssemblyAI has no model list to fetch.' },
    caps: { turnDetection: true, keyterms: true, streaming: true, languages: 'multi' },
    privacy: 'Audio goes to AssemblyAI'
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs Scribe',
    trait: 'Same key as ElevenLabs voices',
    key: { kind: 'voice', vendor: 'elevenlabs' },
    models: [{ id: 'scribe_v2_realtime', label: 'Scribe v2 Realtime', recommended: true }],
    // ElevenLabs' /v1/models lists speaking models only.
    modelList: { from: 'curated', why: 'ElevenLabs lists only its speaking models.' },
    caps: { turnDetection: false, keyterms: false, streaming: true, languages: 'multi' },
    privacy: 'Audio goes to ElevenLabs'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    trait: 'Uses your OpenAI key',
    key: { kind: 'chat', provider: 'openai' },
    models: [{ id: 'gpt-live-transcribe', label: 'Live transcribe', recommended: true }],
    modelList: { from: 'api' },
    caps: { turnDetection: false, keyterms: true, streaming: true, languages: 'multi' },
    privacy: 'Audio goes to OpenAI'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    trait: 'Uses your OpenRouter key · slower replies',
    key: { kind: 'chat', provider: 'openrouter' },
    // No streaming endpoint: each turn is sent whole once you pause, with
    // the model dictation uses (dictation/transcribe.ts).
    models: [{ id: 'openai/gpt-transcribe', label: 'OpenAI: GPT Transcribe', recommended: true }],
    modelList: { from: 'api' },
    caps: { turnDetection: false, keyterms: false, streaming: false, languages: 'multi' },
    privacy: 'Audio goes to OpenRouter'
  },
  {
    id: 'local',
    label: 'This PC',
    trait: 'Private and offline · slower replies',
    key: { kind: 'none' },
    // It runs dictation's installed model (Whisper or Moonshine), chosen in
    // dictation's settings; a second picker here would choose nothing.
    models: [{ id: 'dictation', label: 'Same model as dictation', recommended: true }],
    modelList: { from: 'curated', why: 'Choose the model under Dictation below.' },
    caps: { turnDetection: false, keyterms: false, streaming: false, languages: 'en' },
    privacy: 'Audio stays on this PC',
    beta: true
  }
]

export const TTS_CATALOG: readonly TtsCatalogEntry[] = [
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    trait: 'Most natural voices · your cloned voices too',
    key: { kind: 'voice', vendor: 'elevenlabs' },
    models: [
      { id: 'eleven_flash_v2_5', label: 'Flash v2.5', recommended: true },
      { id: 'eleven_multilingual_v2', label: 'Multilingual v2 · slower, richer' }
    ],
    modelList: { from: 'api' },
    // Range to confirm in the Phase 1 spike (docs/voice-mode.md §9.4).
    caps: { streamingInput: true, speed: [0.7, 1.2], supportsMarkup: false, voiceList: true },
    // A long-standing premade voice; confirm it is still listed in the spike.
    defaultVoice: { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel' },
    privacy: 'Reply text goes to ElevenLabs'
  },
  {
    id: 'cartesia',
    label: 'Cartesia Sonic',
    trait: 'Very fast first words',
    key: { kind: 'voice', vendor: 'cartesia' },
    models: [
      { id: 'sonic-3.6', label: 'Sonic 3.6', recommended: true },
      { id: 'sonic-latest', label: 'Sonic · latest' }
    ],
    modelList: { from: 'curated', why: 'Cartesia has no model list to fetch.' },
    caps: { streamingInput: true, speed: [0.6, 1.5], supportsMarkup: false, voiceList: true },
    defaultVoice: { id: '', label: 'Cartesia default' },
    privacy: 'Reply text goes to Cartesia'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    trait: 'Uses your OpenAI key',
    key: { kind: 'chat', provider: 'openai' },
    models: [{ id: 'gpt-4o-mini-tts', label: 'GPT-4o mini TTS', recommended: true }],
    modelList: { from: 'api' },
    caps: { streamingInput: false, speed: [0.25, 4], supportsMarkup: false, voiceList: false },
    defaultVoice: { id: 'alloy', label: 'Alloy' },
    privacy: 'Reply text goes to OpenAI'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    trait: 'Many voice models, one key',
    key: { kind: 'chat', provider: 'openrouter' },
    // OpenRouter has no OpenAI speech model (A-01): its old id here 400'd "does not exist". Every model
    // it serves comes from its list (D-37); this is the default and the fallback when the list can't load.
    models: [{ id: 'elevenlabs/eleven-flash-v2.5', label: 'ElevenLabs: Eleven Flash v2.5', recommended: true }],
    modelList: { from: 'api' },
    // Its voices come with each model in OpenRouter's public list, not from a keyed voice list.
    caps: { streamingInput: false, speed: [0.25, 4], supportsMarkup: false, voiceList: false },
    // One of Eleven Flash v2.5's `supported_voices`; other models get their own first voice (`pickVoice`).
    defaultVoice: { id: 'sarah', label: 'Sarah' },
    privacy: 'Reply text goes to OpenRouter'
  }
]

/** Fallback order when the setting is `auto`, or the chosen provider has no working key (§9.5). */
export const STT_AUTO_ORDER: readonly SttProviderId[] = ['deepgram', 'assemblyai', 'elevenlabs', 'openai', 'openrouter']
export const TTS_AUTO_ORDER: readonly TtsProviderId[] = ['elevenlabs', 'cartesia', 'openai', 'openrouter']

export function sttEntry(id: SttProviderId): SttCatalogEntry {
  const entry = STT_CATALOG.find((e) => e.id === id)
  if (!entry) throw new Error(`Unknown speech-to-text provider: ${id}`)
  return entry
}

export function ttsEntry(id: TtsProviderId): TtsCatalogEntry {
  const entry = TTS_CATALOG.find((e) => e.id === id)
  if (!entry) throw new Error(`Unknown text-to-speech provider: ${id}`)
  return entry
}

export function recommendedModel(models: readonly VoiceModelOption[]): string {
  return (models.find((m) => m.recommended) ?? models[0])?.id ?? ''
}

/** The model to use: the user's pick if the catalog still lists it, else the recommended one. */
export function resolveModel(models: readonly VoiceModelOption[], picked: string | undefined): string {
  if (picked && models.some((m) => m.id === picked)) return picked
  return recommendedModel(models)
}

/**
 * The model to use (D-36). For a provider whose list comes from its API, the
 * person's pick stands even if this catalog doesn't name it: the provider
 * listed it, and if it's since gone the provider's own error says so (D-40).
 */
export function chooseModel(entry: { models: readonly VoiceModelOption[]; modelList: VoiceModelSource }, picked: string | undefined): string {
  if (entry.modelList.from === 'api' && picked?.trim()) return picked.trim()
  return resolveModel(entry.models, picked)
}

/**
 * The voice to speak with, given the voices the model takes (null when that
 * isn't known): the person's pick if the model takes it, else the
 * catalog's default if it does, else the model's first. A voice saved for
 * one model ("alloy") is never sent to a model that refuses it.
 */
export function pickVoice(voices: readonly string[] | null, picked: string | undefined, fallback: string): string {
  if (!voices || voices.length === 0) return picked || fallback
  if (picked && voices.includes(picked)) return picked
  if (voices.includes(fallback)) return fallback
  return voices[0]!
}

export function clampSpeed(speed: number, range: readonly [number, number]): number {
  if (!Number.isFinite(speed)) return 1
  return Math.min(range[1], Math.max(range[0], speed))
}

/**
 * Whether a key source is usable right now. The caller supplies what it
 * knows about keys; this file never reads them.
 */
export type VoiceKeyAvailability = {
  voice: Readonly<Partial<Record<VoiceKeyVendor, boolean>>>
  chat: Readonly<Partial<Record<'openai' | 'openrouter', boolean>>>
}

export function keySourceReady(source: VoiceKeySource, keys: VoiceKeyAvailability): boolean {
  switch (source.kind) {
    case 'none':
      return true
    case 'voice':
      return keys.voice[source.vendor] === true
    case 'chat':
      return keys.chat[source.provider] === true
  }
}

export type ProviderResolution<Id extends string> =
  /** `fellBackFrom` is set when the user's pick couldn't be used. */
  | { ok: true; id: Id; fellBackFrom?: Id }
  | { ok: false; reason: 'no_key' }

function resolveProvider<Id extends string>(
  choice: Id | 'auto',
  order: readonly Id[],
  keyOf: (id: Id) => VoiceKeySource,
  keys: VoiceKeyAvailability
): ProviderResolution<Id> {
  if (choice !== 'auto' && keySourceReady(keyOf(choice), keys)) return { ok: true, id: choice }
  const next = order.find((id) => keySourceReady(keyOf(id), keys))
  if (!next) return { ok: false, reason: 'no_key' }
  return choice === 'auto' ? { ok: true, id: next } : { ok: true, id: next, fellBackFrom: choice }
}

/**
 * Which listener to use. `local` is never picked automatically (it is a
 * slower beta), but is honoured when chosen since it needs no key.
 */
export function resolveSttProvider(
  choice: SttProviderId | 'auto',
  keys: VoiceKeyAvailability
): ProviderResolution<SttProviderId> {
  return resolveProvider(choice, STT_AUTO_ORDER, (id) => sttEntry(id).key, keys)
}

export function resolveTtsProvider(
  choice: TtsProviderId | 'auto',
  keys: VoiceKeyAvailability
): ProviderResolution<TtsProviderId> {
  return resolveProvider(choice, TTS_AUTO_ORDER, (id) => ttsEntry(id).key, keys)
}

/** Every vendor whose key the Voice settings page manages or links to, in display order. */
export function voiceKeyRows(): readonly VoiceKeySource[] {
  return [
    ...VOICE_KEY_VENDORS.map((vendor): VoiceKeySource => ({ kind: 'voice', vendor })),
    { kind: 'chat', provider: 'openai' },
    { kind: 'chat', provider: 'openrouter' }
  ]
}

export const VOICE_KEY_VENDOR_LABEL: Readonly<Record<VoiceKeyVendor, string>> = {
  deepgram: 'Deepgram',
  assemblyai: 'AssemblyAI',
  elevenlabs: 'ElevenLabs',
  cartesia: 'Cartesia'
}

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * Typed failures, mapped from vendor responses inside each adapter. The UI
 * words them; the provider's own reason may follow, muted (`voiceDetail`, D-40).
 */
export const VOICE_ERROR_CODES = [
  'no_key',
  'rejected_key',
  'out_of_credit',
  'rate_limited',
  'offline',
  'provider_down',
  'mic_blocked',
  'mic_missing',
  'unsupported',
  'engine_failed'
] as const
export type VoiceErrorCode = (typeof VOICE_ERROR_CODES)[number]

const VOICE_IPC_CODE_PREFIX = 'voice:'

export function voiceIpcCode(code: VoiceErrorCode): string {
  return `${VOICE_IPC_CODE_PREFIX}${code}`
}

export function parseVoiceIpcCode(raw: string | undefined): VoiceErrorCode | null {
  if (!raw?.startsWith(VOICE_IPC_CODE_PREFIX)) return null
  const code = raw.slice(VOICE_IPC_CODE_PREFIX.length)
  return (VOICE_ERROR_CODES as readonly string[]).includes(code) ? (code as VoiceErrorCode) : null
}

/** Whether retrying the same request could succeed without the user changing anything. */
export function isRetryableVoiceError(code: VoiceErrorCode): boolean {
  return code === 'rate_limited' || code === 'offline' || code === 'provider_down' || code === 'engine_failed'
}

/** Longest provider reason shown or logged (D-40). */
export const VOICE_DETAIL_MAX = 200

/**
 * A provider's reason as one line that is safe to show after our own words
 * (D-40): whitespace collapsed, anything shaped like a secret redacted, cut
 * to a line. Empty when there's nothing worth showing.
 */
export function voiceDetail(message: string | undefined | null): string {
  const line = redactSecretsInText(String(message ?? '')).replace(/\s+/g, ' ').trim()
  return line.length > VOICE_DETAIL_MAX ? `${line.slice(0, VOICE_DETAIL_MAX - 1)}…` : line
}

/**
 * What an unset language means to a listener (A-15): Deepgram and
 * AssemblyAI pick their English model; the others detect the language.
 */
export function blankLanguageMeans(id: SttProviderId): 'en' | 'detect' {
  return id === 'deepgram' || id === 'assemblyai' ? 'en' : 'detect'
}

/** HTTP status → code, shared by every adapter so they agree (§9.1). */
export function voiceErrorFromStatus(status: number): VoiceErrorCode {
  if (status === 401 || status === 403) return 'rejected_key'
  if (status === 402) return 'out_of_credit'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'provider_down'
  return 'engine_failed'
}
