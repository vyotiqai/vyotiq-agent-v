import { z } from 'zod'

/*
  Kept voice conversations, read back (docs/voice-mode.md §24.8). Main writes
  one JSONL file per session (`src/main/voice/conversationLog.ts`); these are
  the shapes the renderer gets when it lists or opens one. Every line is
  parsed on read: a line a newer build wrote, or a torn last line, is skipped
  and counted, never trusted.
*/

/**
 * A conversation's id is its file name without `.jsonl`: the start time with
 * `:` and `.` made `-`, then `_` and the session id. No dots and no
 * separators, so an id can never name a path outside the voice folder.
 */
export const VOICE_CONVERSATION_ID_RE = /^[0-9TZ-]{10,40}_[A-Za-z0-9_-]{1,100}$/

export const VoiceConversationIdSchema = z.string().regex(VOICE_CONVERSATION_ID_RE)

const At = z.string().max(40)
const Text = z.string().max(20_000)
const Id = z.string().max(200)

export const VoiceConversationEntrySchema = z.discriminatedUnion('kind', [
  z.object({ at: At, kind: z.literal('start'), listener: z.string().max(200), speaker: z.string().max(200).nullable() }),
  z.object({ at: At, kind: z.literal('you'), turnId: Id, text: Text, stop: z.boolean().optional() }),
  z.object({ at: At, kind: z.literal('voice'), contextId: Id, text: Text }),
  z.object({ at: At, kind: z.literal('agent'), contextId: Id, text: Text }),
  z.object({ at: At, kind: z.literal('hand_off'), handOffId: Id, brief: Text }),
  z.object({ at: At, kind: z.literal('followed'), runId: Id, handOffId: Id.optional() }),
  z.object({ at: At, kind: z.literal('task'), runId: Id }),
  z.object({ at: At, kind: z.literal('not_sent'), handOffId: Id, reason: z.string().max(400) }),
  z.object({
    at: At,
    kind: z.literal('answered'),
    what: z.enum(['approval', 'question']),
    text: Text,
    decision: z.string().max(200).optional(),
    tool: z.string().max(200).optional()
  }),
  z.object({ at: At, kind: z.literal('stop_agent'), by: z.enum(['you', 'voice']) }),
  z.object({ at: At, kind: z.literal('unanswered'), turnId: Id, text: Text.optional() }),
  z.object({ at: At, kind: z.literal('app_action'), action: z.string().max(64), ok: z.boolean(), message: Text }),
  z.object({ at: At, kind: z.literal('dropped'), reason: z.enum(['empty', 'echo', 'noise']), chars: z.number().int().min(0) }),
  z.object({ at: At, kind: z.literal('error'), side: z.string().max(200), code: z.string().max(200), detail: z.string().max(400).optional() }),
  z.object({ at: At, kind: z.literal('end') })
])
export type VoiceConversationEntry = z.infer<typeof VoiceConversationEntrySchema>

/** One kept conversation, as the list shows it. */
export type VoiceConversationSummary = {
  id: string
  /** The first line's time, else the time in the file name. */
  startedAt: string
  /** Null when the session never wrote `end` (the app quit or crashed). */
  endedAt: string | null
  /** Your turns. */
  turns: number
  /** Your first words, cut short: what the list names it by. */
  firstWords: string
  /** Runs that took a hand-off, in order: what links a task back here. */
  runIds: string[]
  /**
   * Each hand-off a run took, with the brief it was given: which of a task's
   * instructions came from this conversation. Empty `brief` when the run was
   * followed with no hand-off before it.
   */
  sent: { runId: string; brief: string }[]
  handOffs: number
  notSent: number
}

export type VoiceConversation = {
  summary: VoiceConversationSummary
  entries: VoiceConversationEntry[]
  /** Lines that didn't parse (a torn last line, a newer build's kind). */
  skipped: number
}

export const VoiceConversationsListRequestSchema = z.object({ workspacePath: z.string().min(1) })
export type VoiceConversationsListRequest = z.infer<typeof VoiceConversationsListRequestSchema>

export const VoiceConversationReadRequestSchema = z.object({
  workspacePath: z.string().min(1),
  id: VoiceConversationIdSchema
})
export type VoiceConversationReadRequest = z.infer<typeof VoiceConversationReadRequestSchema>
