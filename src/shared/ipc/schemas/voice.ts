import { z } from 'zod'
import { VOICE_SESSION_STATES } from '../../voiceSession'
import { STT_PROVIDER_IDS, TTS_PROVIDER_IDS, VOICE_ERROR_CODES, VOICE_KEY_VENDORS } from '../../voice'

/** Int16 PCM over IPC; any backing buffer (the mic's may not be a plain ArrayBuffer). */
const Int16PcmSchema = z.custom<Int16Array>((v) => v instanceof Int16Array, 'expected Int16Array')

export const SttProviderIdSchema = z.enum(STT_PROVIDER_IDS)
export const TtsProviderIdSchema = z.enum(TTS_PROVIDER_IDS)
export const VoiceKeyVendorSchema = z.enum(VOICE_KEY_VENDORS)

/** What talking over the agent does while it works (docs/voice-mode.md §6.3, D-12). */
export const VoiceInterruptModeSchema = z.enum(['steer', 'cancel', 'off'])
export type VoiceInterruptMode = z.infer<typeof VoiceInterruptModeSchema>

/** How long the listener waits before deciding you've finished; each adapter maps it. */
export const VoiceEndOfTurnPatienceSchema = z.enum(['quick', 'normal', 'patient'])
export type VoiceEndOfTurnPatience = z.infer<typeof VoiceEndOfTurnPatienceSchema>

const ModelId = z.string().max(120)
const VoiceId = z.string().max(200)

/**
 * Per-provider picks live in records keyed by provider id, so switching away
 * and back keeps your model and voice. A key a newer build added and an older
 * one doesn't know is dropped on read, like any unknown settings key.
 */
export const VoiceSettingsSchema = z.object({
  /** `auto` picks the first provider with a working key (§9.5). */
  sttProvider: z.union([z.literal('auto'), SttProviderIdSchema]).default('auto'),
  ttsProvider: z.union([z.literal('auto'), TtsProviderIdSchema]).default('auto'),
  stt: z.partialRecord(SttProviderIdSchema, z.object({ model: ModelId.optional() })).default({}),
  tts: z
    .partialRecord(TtsProviderIdSchema, z.object({ model: ModelId.optional(), voiceId: VoiceId.optional() }))
    .default({}),
  /** Clamped to the provider's range at use; stored as chosen. */
  speed: z.number().min(0.25).max(4).default(1),
  /** ISO-639-1; empty means English. */
  language: z.string().max(8).default(''),
  interruptMode: VoiceInterruptModeSchema.default('steer'),
  /** Short spoken cues while tools run; off leaves only a sound. */
  speakProgress: z.boolean().default(true),
  /** No automatic turn ends; hold to talk. */
  pushToTalkOnly: z.boolean().default(false),
  endOfTurnPatience: VoiceEndOfTurnPatienceSchema.default('normal'),
  /** Spoken yes/no answers ordinary approvals; risky ones always need a click. */
  approveByVoice: z.boolean().default(true),
  captions: z.boolean().default(true),
  earcons: z.boolean().default(true)
})
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  sttProvider: 'auto',
  ttsProvider: 'auto',
  stt: {},
  tts: {},
  speed: 1,
  language: '',
  interruptMode: 'steer',
  speakProgress: true,
  pushToTalkOnly: false,
  endOfTurnPatience: 'normal',
  approveByVoice: true,
  captions: true,
  earcons: true
}

// ── Keys ────────────────────────────────────────────────────────────────────

export const VoiceSetKeyRequestSchema = z.object({
  vendor: VoiceKeyVendorSchema,
  key: z.string().trim().min(1).max(512)
})
export type VoiceSetKeyRequest = z.infer<typeof VoiceSetKeyRequestSchema>

export const VoiceClearKeyRequestSchema = z.object({ vendor: VoiceKeyVendorSchema })
export type VoiceClearKeyRequest = z.infer<typeof VoiceClearKeyRequestSchema>

/** What the renderer may know about a key: never the key itself. */
export const VoiceKeyStateSchema = z.object({
  set: z.boolean(),
  /** Last four characters, for "••••3f9a". */
  last4: z.string().max(4).optional()
})
export type VoiceKeyState = z.infer<typeof VoiceKeyStateSchema>

export const VoiceKeyStatusSchema = z.object({
  voice: z.partialRecord(VoiceKeyVendorSchema, VoiceKeyStateSchema),
  chat: z.object({ openai: z.boolean(), openrouter: z.boolean() })
})
export type VoiceKeyStatus = z.infer<typeof VoiceKeyStatusSchema>

export const VoiceSetKeyResultSchema = z.object({
  /** `unchecked`: saved, but the vendor couldn't be reached to confirm it. */
  check: z.enum(['verified', 'unchecked']),
  status: VoiceKeyStatusSchema
})
export type VoiceSetKeyResult = z.infer<typeof VoiceSetKeyResultSchema>

// ── Speaking (preview, read an answer aloud) ────────────────────────────────

export const VoiceSpeakRequestSchema = z.object({
  text: z.string().min(1).max(200_000),
  /** `answer`: speak its <spoken> block or a short summary; `plain`: exactly this text. */
  kind: z.enum(['answer', 'plain']),
  provider: TtsProviderIdSchema.optional(),
  voiceId: z.string().max(200).optional(),
  speed: z.number().min(0.25).max(4).optional()
})
export type VoiceSpeakRequest = z.infer<typeof VoiceSpeakRequestSchema>

export const VoiceSpeakResultSchema = z.object({
  utteranceId: z.string(),
  provider: TtsProviderIdSchema,
  voiceId: z.string()
})
export type VoiceSpeakResult = z.infer<typeof VoiceSpeakResultSchema>

export const VoiceStopSpeakingRequestSchema = z.object({ utteranceId: z.string().optional() })
export type VoiceStopSpeakingRequest = z.infer<typeof VoiceStopSpeakingRequestSchema>

export const VoiceListVoicesRequestSchema = z.object({ provider: TtsProviderIdSchema, refresh: z.boolean().optional() })
export type VoiceListVoicesRequest = z.infer<typeof VoiceListVoicesRequestSchema>

export const VoiceOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  custom: z.boolean().optional(),
  previewUrl: z.string().optional()
})
export type VoiceOptionInfo = z.infer<typeof VoiceOptionSchema>

/** Main → renderer: one chunk of speech. `pcm` crosses IPC as a typed array (structured clone), not base64 (D-09). */
export const VoiceAudioOutSchema = z.object({
  utteranceId: z.string(),
  seq: z.number().int().min(0),
  sampleRate: z.number().int().min(8000).max(48000),
  pcm: Int16PcmSchema
})
export type VoiceAudioOut = z.infer<typeof VoiceAudioOutSchema>

export const VoiceSpeakEndSchema = z.object({
  utteranceId: z.string(),
  error: z.enum(VOICE_ERROR_CODES).optional()
})
export type VoiceSpeakEnd = z.infer<typeof VoiceSpeakEndSchema>

// ── Live session ────────────────────────────────────────────────────────────

export const VoiceStartRequestSchema = z.object({
  /** The task's workspace: its file names become words to listen for. */
  workspacePath: z.string().min(1).max(4096).optional()
})
export type VoiceStartRequest = z.infer<typeof VoiceStartRequestSchema>

export const VoiceStartResultSchema = z.object({ sessionId: z.string() })
export type VoiceStartResult = z.infer<typeof VoiceStartResultSchema>

export const VoiceSessionRequestSchema = z.object({ sessionId: z.string().min(1).max(100) })
export type VoiceSessionRequest = z.infer<typeof VoiceSessionRequestSchema>

/** 16 kHz mono Int16 mic audio, ~128 ms a chunk, as a typed array (D-09). */
export const VoiceAudioInSchema = z.object({
  sessionId: z.string().min(1).max(100),
  pcm: Int16PcmSchema.refine((a) => a.length <= 16000 * 2, 'chunk too long')
})
export type VoiceAudioIn = z.infer<typeof VoiceAudioInSchema>

export const VoicePttRequestSchema = z.object({ sessionId: z.string().min(1).max(100), down: z.boolean() })
export type VoicePttRequest = z.infer<typeof VoicePttRequestSchema>

export const VoiceMuteRequestSchema = z.object({ sessionId: z.string().min(1).max(100), muted: z.boolean() })
export type VoiceMuteRequest = z.infer<typeof VoiceMuteRequestSchema>

export const VoiceSessionStateSchema = z.enum(VOICE_SESSION_STATES)

/** Main → renderer, everything the voice bar shows (docs/voice-mode.md §11). */
export const VoiceEventSchema = z.discriminatedUnion('kind', [
  z.object({ sessionId: z.string(), kind: z.literal('state'), state: VoiceSessionStateSchema }),
  z.object({
    sessionId: z.string(),
    kind: z.literal('engine'),
    stt: SttProviderIdSchema,
    sttFellBackFrom: SttProviderIdSchema.optional()
  }),
  /** Unsettled words of the turn in progress, for captions. */
  z.object({ sessionId: z.string(), kind: z.literal('partial'), text: z.string() }),
  /** A finished turn: the renderer sends it to the agent like a typed message (D-07). */
  z.object({
    sessionId: z.string(),
    kind: z.literal('turn'),
    turnId: z.string(),
    text: z.string(),
    /** The whole turn was a stop phrase ("stop", "never mind"): cancel, don't send. */
    stop: z.boolean()
  }),
  z.object({ sessionId: z.string(), kind: z.literal('reconnecting'), attempt: z.number().int() }),
  z.object({
    sessionId: z.string(),
    kind: z.literal('error'),
    code: z.enum(VOICE_ERROR_CODES),
    retryable: z.boolean()
  })
])
export type VoiceEvent = z.infer<typeof VoiceEventSchema>
