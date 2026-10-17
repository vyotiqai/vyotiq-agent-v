import { z } from 'zod'
import { VoicePlacementSchema, VoiceStyleSchema, VoiceViewLayoutSchema } from './voice'
import { AgentQuestionAnswerSchema } from './agentQuestion'
import { AGENT_QUESTION_MAX_ITEMS } from '../../utils/agentQuestionForm'

/*
  The voice mini window (docs/voice-mode.md §26.5, 2026-10-15 decision): its
  own small always-on-top window that MIRRORS the main window's session. The
  mic, the player and the session controller stay in the main window, so
  there is one owner of the mic; the mini window draws what the main window
  sends and sends its clicks back.

    main window → main → mini:  state (the session as it reads it), level (the orb's, ~20 a second)
    mini → main → main window:  commands (mute, hold, stop, end, an answer, a layout pick)
    mini → main:                resize (pill or card), show the app
*/

/** The mirrored session. The snapshot's shape is the renderer's; main only relays it, sized-checked. */
export const VoiceMiniStateSchema = z.object({
  snapshot: z.record(z.string(), z.unknown()),
  settings: z.record(z.string(), z.unknown()),
  startedAt: z.number().nullable(),
  escArmed: z.boolean(),
  /** The main window's `<html>` data attributes (skin, theme, font scale, a11y), so the mini window looks the same. */
  appearance: z.record(z.string().max(40), z.string().max(200)).refine((a) => Object.keys(a).length <= 24, 'too many attributes')
})
export type VoiceMiniState = z.infer<typeof VoiceMiniStateSchema>

export const VoiceMiniLevelSchema = z.object({ level: z.number().min(0).max(1), mic: z.number().min(0).max(1) })
export type VoiceMiniLevel = z.infer<typeof VoiceMiniLevelSchema>

/** What a click in the mini window asks of the session in the main window. */
export const VoiceMiniCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mute'), muted: z.boolean() }),
  z.object({ kind: z.literal('hold'), down: z.boolean() }),
  z.object({ kind: z.literal('stop_speaking') }),
  z.object({ kind: z.literal('stop_task') }),
  z.object({ kind: z.literal('end') }),
  z.object({ kind: z.literal('retry') }),
  z.object({ kind: z.literal('open_settings') }),
  z.object({
    kind: z.literal('settings'),
    patch: z.object({ placement: VoicePlacementSchema.optional(), style: VoiceStyleSchema.optional(), viewLayout: VoiceViewLayoutSchema.optional() })
  }),
  z.object({
    kind: z.literal('approval'),
    requestId: z.string().min(1).max(200),
    decision: z.enum(['once', 'always', 'deny']),
    runId: z.string().min(1).max(200)
  }),
  z.object({
    kind: z.literal('question'),
    requestId: z.string().min(1).max(200),
    questionId: z.string().min(1).max(200),
    value: z.string().max(200),
    runId: z.string().min(1).max(200)
  }),
  /** A whole form sent from the mini window: typed answers, several picks or questions. */
  z.object({
    kind: z.literal('form'),
    requestId: z.string().min(1).max(200),
    answers: z.array(AgentQuestionAnswerSchema).max(AGENT_QUESTION_MAX_ITEMS),
    runId: z.string().min(1).max(200)
  }),
  /** Main says the mini window went away (closed from the OS): the main window shows the session itself again. */
  z.object({ kind: z.literal('closed') }),
  /**
   * The mini window is listening now: main sends it the last state again. Its
   * first state can arrive before its page has subscribed, and a quiet session
   * pushes nothing new until something changes.
   */
  z.object({ kind: z.literal('ready') })
])
export type VoiceMiniCommand = z.infer<typeof VoiceMiniCommandSchema>

export const VoiceMiniOpenSchema = z.object({ open: z.boolean() })
export type VoiceMiniOpen = z.infer<typeof VoiceMiniOpenSchema>

/** The mini window's size: the pill (at rest) or the card (opened). */
export const VoiceMiniResizeSchema = z.object({ open: z.boolean() })
export type VoiceMiniResize = z.infer<typeof VoiceMiniResizeSchema>

export const VOICE_MINI_SIZE = { pill: { width: 380, height: 48 }, card: { width: 380, height: 600 } } as const
