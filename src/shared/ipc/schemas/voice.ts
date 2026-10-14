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

/**
 * How the voice view is laid out (§25): the conversation as the page with the
 * orb docked under it, the orb filling the pane, or the conversation beside
 * the task's live work.
 */
export const VOICE_VIEW_LAYOUTS = ['conversation', 'orb', 'split'] as const
export const VoiceViewLayoutSchema = z.enum(VOICE_VIEW_LAYOUTS)
export type VoiceViewLayout = z.infer<typeof VoiceViewLayoutSchema>

/**
 * The orb's look in the voice view. Nine are WebGL motion graphics from the
 * design canvas, `liquid` is the first live orb, and `simple` is the drawn
 * orb, which uses no GPU (and is what any look falls back to without WebGL).
 */
export const VOICE_ORB_LOOKS = ['glow', 'pearl', 'aura', 'wire', 'cloud', 'bubble', 'halftone', 'plasma', 'contour', 'liquid', 'simple'] as const
export const VoiceOrbLookSchema = z.enum(VOICE_ORB_LOOKS)
export type VoiceOrbLook = z.infer<typeof VoiceOrbLookSchema>

const ModelId = z.string().max(120)
const VoiceId = z.string().max(200)

/**
 * Who answers out loud (D-44): a fast chat model that talks with you and
 * hands real work to the agent. Any chat provider the app knows; its key is
 * the provider's own.
 */
export const VoiceResponderSchema = z.object({
  provider: z.string().min(1).max(80),
  model: z.string().min(1).max(200)
})
export type VoiceResponder = z.infer<typeof VoiceResponderSchema>

/** Measured fastest-to-useful on 2026-10-14 with tools, and Ajay's pick (D-45). */
export const DEFAULT_VOICE_RESPONDER: VoiceResponder = { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' }

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
  /**
   * ISO-639-1. English by default (D-47): with detection, the agent's own
   * voice and short noises came back as Turkish and Russian text. Empty is
   * "detect" for the listeners that can (A-15).
   */
  language: z.string().max(8).default('en'),
  /** Kept for old files only: talking over the agent now never cancels its work (D-46). */
  interruptMode: VoiceInterruptModeSchema.default('steer'),
  responder: VoiceResponderSchema.default(DEFAULT_VOICE_RESPONDER),
  /** Short spoken cues while tools run; off leaves only a sound. */
  speakProgress: z.boolean().default(true),
  /** No automatic turn ends; hold to talk. */
  pushToTalkOnly: z.boolean().default(false),
  endOfTurnPatience: VoiceEndOfTurnPatienceSchema.default('normal'),
  /** Spoken yes/no answers ordinary approvals; risky ones always need a click. */
  approveByVoice: z.boolean().default(true),
  captions: z.boolean().default(true),
  earcons: z.boolean().default(true),
  viewLayout: VoiceViewLayoutSchema.default('conversation'),
  orbLook: VoiceOrbLookSchema.default('glow')
})
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  sttProvider: 'auto',
  ttsProvider: 'auto',
  stt: {},
  tts: {},
  speed: 1,
  language: 'en',
  interruptMode: 'steer',
  responder: DEFAULT_VOICE_RESPONDER,
  speakProgress: true,
  pushToTalkOnly: false,
  endOfTurnPatience: 'normal',
  approveByVoice: true,
  captions: true,
  earcons: true,
  viewLayout: 'conversation',
  orbLook: 'glow'
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

export const VoiceListVoicesRequestSchema = z.object({
  provider: TtsProviderIdSchema,
  refresh: z.boolean().optional(),
  /** The model the voices are for: on OpenRouter each model takes its own (D-36). */
  model: z.string().max(200).optional()
})
export type VoiceListVoicesRequest = z.infer<typeof VoiceListVoicesRequestSchema>

/** A provider's models for one direction (D-36). */
export const VoiceModelsRequestSchema = z.discriminatedUnion('direction', [
  z.object({ direction: z.literal('stt'), provider: SttProviderIdSchema, refresh: z.boolean().optional() }),
  z.object({ direction: z.literal('tts'), provider: TtsProviderIdSchema, refresh: z.boolean().optional() })
])
export type VoiceModelsRequest = z.infer<typeof VoiceModelsRequestSchema>

export const VoiceModelInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** "$0.02 / 1k characters", "$0.0045 / min", "Free"; absent when the unit isn't clear. */
  price: z.string().optional(),
  recommended: z.boolean().optional()
})
export type VoiceModelInfo = z.infer<typeof VoiceModelInfoSchema>

export const VoiceModelListSchema = z.object({
  /** `api`: fetched from the provider; `curated`: this app's list (none to fetch, or the fetch failed). */
  source: z.enum(['api', 'curated']),
  /** When the provider's list was fetched (ms since epoch). */
  fetchedAt: z.number().optional(),
  models: z.array(VoiceModelInfoSchema),
  /** The fetch failed: why, so the picker can say so over the curated fallback. */
  error: z.enum(VOICE_ERROR_CODES).optional(),
  detail: z.string().max(400).optional()
})
export type VoiceModelList = z.infer<typeof VoiceModelListSchema>

/**
 * What an ordinary OpenRouter key can tell about credit (A-08). The account
 * balance needs a management key, so this is only what `/api/v1/key` says:
 * `never_paid` (the account has never bought credit) or `key_limit` (this
 * key's own limit has under $0.50 left). `unknown`: no key, or no answer.
 */
export const VoiceOpenRouterCreditSchema = z.object({
  status: z.enum(['ok', 'low', 'unknown']),
  reason: z.enum(['never_paid', 'key_limit']).optional(),
  /** Dollars left on this key's own limit, when it has one. */
  keyRemaining: z.number().optional()
})
export type VoiceOpenRouterCredit = z.infer<typeof VoiceOpenRouterCreditSchema>

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
  pcm: Int16PcmSchema,
  /**
   * Live sessions: the reply's speech is complete (B9). The player reports a
   * reply drained only after this, so a gap between two sentences while the
   * next one is still being made doesn't end it. `pcm` is empty.
   */
  last: z.boolean().optional(),
  /**
   * The first audio of the reply's n-th spoken piece (0-based): the n-th `say`
   * of this context. The window shows that caption as it starts to play.
   * Absent where the speaking provider can't tell where a piece starts.
   */
  piece: z.number().int().min(0).optional()
})
export type VoiceAudioOut = z.infer<typeof VoiceAudioOutSchema>

export const VoiceSpeakEndSchema = z.object({
  utteranceId: z.string(),
  error: z.enum(VOICE_ERROR_CODES).optional(),
  /** The provider's own reason, one redacted line (D-40). */
  detail: z.string().max(400).optional()
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

/** Steps a work event carries; older ones are counted, not listed. */
export const VOICE_WORK_MAX_STEPS = 40
/** The longest result a work event carries; the task's record has the rest. */
export const VOICE_WORK_MAX_RESULT = 4000

/** One step of the followed run: the tool and its one-line summary, never its output. */
export const VoiceWorkStepSchema = z.object({
  id: z.string().max(200),
  tool: z.string().max(80),
  summary: z.string().max(200),
  state: z.enum(['running', 'done', 'failed'])
})
export type VoiceWorkStep = z.infer<typeof VoiceWorkStepSchema>

/**
 * What the followed run is blocked on. `options` are the answers a click can
 * give (one question with a single pick or yes/no); empty means it's answered
 * on the task's card (or by voice).
 */
export const VoiceWorkAskSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('approval'),
    requestId: z.string().max(200),
    /** "run pnpm test", "change src/app.ts": what it wants, in a few words. */
    what: z.string().max(300),
    /** The command guard stopped it: only a click on the card may answer. */
    risky: z.boolean(),
    /** The card offers its plain Always allow here (never risky, never an unscoped command). */
    always: z.boolean().optional()
  }),
  z.object({
    kind: z.literal('question'),
    requestId: z.string().max(200),
    questionId: z.string().max(200),
    prompt: z.string().max(1000),
    options: z.array(z.string().max(200)).max(12)
  })
])
export type VoiceWorkAsk = z.infer<typeof VoiceWorkAskSchema>

/** The followed run's work, as the voice view shows it under the hand-off that started it. */
export const VoiceWorkSchema = z.object({
  runId: z.string().max(200),
  state: z.enum(['running', 'needs', 'done', 'failed', 'stopped']),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  /** Every step since the run (re)started, including those not listed. */
  stepCount: z.number().int().min(0),
  steps: z.array(VoiceWorkStepSchema).max(VOICE_WORK_MAX_STEPS),
  /** The agent's final answer, without its spoken block. */
  result: z.string().max(VOICE_WORK_MAX_RESULT).optional(),
  ask: VoiceWorkAskSchema.optional()
})
export type VoiceWork = z.infer<typeof VoiceWorkSchema>

/** Main → renderer, everything the voice bar shows (docs/voice-mode.md §11). */
export const VoiceEventSchema = z.discriminatedUnion('kind', [
  z.object({ sessionId: z.string(), kind: z.literal('state'), state: VoiceSessionStateSchema }),
  z.object({
    sessionId: z.string(),
    kind: z.literal('engine'),
    stt: SttProviderIdSchema,
    sttFellBackFrom: SttProviderIdSchema.optional(),
    /** Who speaks the replies; null when no speaking provider has a key (replies stay on screen). */
    tts: TtsProviderIdSchema.nullable().optional(),
    ttsFellBackFrom: TtsProviderIdSchema.optional()
  }),
  /** Unsettled words of the turn in progress, for captions. */
  z.object({ sessionId: z.string(), kind: z.literal('partial'), text: z.string() }),
  /**
   * What you said, one whole turn. The voice answers it (D-44); only a
   * hand-off reaches the agent. `stop`: the turn was a stop phrase.
   */
  z.object({
    sessionId: z.string(),
    kind: z.literal('turn'),
    turnId: z.string(),
    text: z.string(),
    /** The whole turn was a stop phrase ("stop", "never mind"): cancel, don't send. */
    stop: z.boolean()
  }),
  /**
   * Something you said that the voice heard and chose not to answer: a filler,
   * a bare "okay", talk not meant for it. With `text`, a new line (it was never
   * a turn); without, the turn `turnId` already on screen. Shown muted, so
   * "it ignored me" reads differently from "it broke".
   */
  z.object({
    sessionId: z.string(),
    kind: z.literal('unanswered'),
    turnId: z.string(),
    text: z.string().optional()
  }),
  /**
   * The voice gives the agent work: the renderer sends `brief` to the task
   * like a typed message (it starts the task, or joins the running one
   * without cancelling it) and follows the run.
   */
  z.object({ sessionId: z.string(), kind: z.literal('hand_off'), handOffId: z.string(), brief: z.string().min(1).max(20_000) }),
  /** The voice was asked to stop the agent's work: the renderer presses Stop. */
  z.object({ sessionId: z.string(), kind: z.literal('stop_agent') }),
  z.object({ sessionId: z.string(), kind: z.literal('reconnecting'), attempt: z.number().int() }),
  /**
   * What the agent is saying, a sentence at a time, for captions. `audible`:
   * audio for it is on its way, so the window holds the caption until it plays;
   * false (nothing can speak) shows it at once. Older mains send neither.
   */
  z.object({ sessionId: z.string(), kind: z.literal('say'), contextId: z.string(), text: z.string(), audible: z.boolean().optional() }),
  /** The followed run's steps, result and what it waits on, for the voice view (§25). */
  z.object({ sessionId: z.string(), kind: z.literal('work'), work: VoiceWorkSchema }),
  /** You may be talking over the agent: lower its voice (`on`), or bring it back — it was a cough or an echo (§6.2). */
  z.object({ sessionId: z.string(), kind: z.literal('duck'), on: z.boolean() }),
  /** A slow step started and spoken progress is off: a soft sound instead of words (§8.4). */
  z.object({ sessionId: z.string(), kind: z.literal('cue') }),
  /** Barge-in: drop this reply's queued audio from the speakers now. */
  z.object({ sessionId: z.string(), kind: z.literal('flush'), contextId: z.string() }),
  z.object({
    sessionId: z.string(),
    kind: z.literal('error'),
    code: z.enum(VOICE_ERROR_CODES),
    retryable: z.boolean(),
    /**
     * Which part failed: `session` ends it (state `error`); `turn` lost one
     * spoken turn and keeps listening; `speak` lost the agent's voice, and
     * replies stay on screen.
     */
    side: z.enum(['session', 'turn', 'speak']).optional(),
    /** The provider's own reason, one redacted line (D-40). */
    detail: z.string().max(400).optional()
  })
])
export type VoiceEvent = z.infer<typeof VoiceEventSchema>

export const VoiceFollowRequestSchema = z.object({
  sessionId: z.string().min(1).max(100),
  runId: z.string().min(1).max(200),
  /** The hand-off this run took, for the kept conversation. */
  handOffId: z.string().min(1).max(100).optional()
})
export type VoiceFollowRequest = z.infer<typeof VoiceFollowRequestSchema>

/** The task the session is on, running or not (null: none yet): the voice reads its conversation. */
export const VoiceTaskRequestSchema = z.object({
  sessionId: z.string().min(1).max(100),
  runId: z.string().min(1).max(200).nullable(),
  /** The task's workspace, used only when it is one of the open workspaces. */
  workspacePath: z.string().min(1).max(4096).optional()
})
export type VoiceTaskRequest = z.infer<typeof VoiceTaskRequestSchema>

export const VoicePlaybackRequestSchema = z.object({
  sessionId: z.string().min(1).max(100),
  contextId: z.string().min(1).max(100),
  phase: z.enum(['started', 'drained'])
})
export type VoicePlaybackRequest = z.infer<typeof VoicePlaybackRequestSchema>

/** Why the window could not give the voice's brief to the task. */
export const VoiceHandOffFailureSchema = z.enum(['no_task', 'refused', 'error'])
export type VoiceHandOffFailure = z.infer<typeof VoiceHandOffFailureSchema>

export const VoiceHandOffFailedRequestSchema = z.object({
  sessionId: z.string().min(1).max(100),
  handOffId: z.string().min(1).max(100),
  reason: VoiceHandOffFailureSchema
})
export type VoiceHandOffFailedRequest = z.infer<typeof VoiceHandOffFailedRequestSchema>
