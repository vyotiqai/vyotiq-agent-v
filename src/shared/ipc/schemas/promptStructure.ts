import { z } from 'zod'
import { AgentInteractionModeSchema } from './settings'

/**
 * Structure: the composer's rough instruction rewritten as a brief an agent
 * can act on — goal, scope, constraints, how to verify — before anything runs.
 * The person reads and edits the brief; nothing is sent from here.
 */

/** Longest instruction the structurer takes; past this it is already a document. */
export const PROMPT_STRUCTURE_MAX_INPUT_CHARS = 20_000
/** Longest original kept on a sent message for the record's "what you wrote". */
export const STRUCTURED_FROM_MAX_CHARS = PROMPT_STRUCTURE_MAX_INPUT_CHARS

/** `[[@1]]`, `[[@2]]` … — an attached chip, held in place while the text is rewritten. */
export const PROMPT_STRUCTURE_TOKEN_RE = /\[\[@(\d{1,2})\]\]/g

export const PromptStructureMentionSchema = z.object({
  /** The placeholder standing in for the chip in `text`, e.g. `[[@1]]`. */
  token: z.string().regex(/^\[\[@\d{1,2}\]\]$/),
  /** The chip's kind as the composer knows it: file, folder, url, terminal… */
  kind: z.string().min(1).max(32),
  /** What the chip shows. */
  label: z.string().max(300),
  /** Workspace-relative path, for file, folder, docs and rule chips. */
  path: z.string().max(1000).optional()
})
export type PromptStructureMention = z.infer<typeof PromptStructureMentionSchema>

export const PromptStructureAnswerSchema = z.object({
  question: z.string().min(1).max(500),
  answer: z.string().min(1).max(1000)
})
export type PromptStructureAnswer = z.infer<typeof PromptStructureAnswerSchema>

export const PromptStructureRequestSchema = z.object({
  /** The renderer's handle for this call, so Esc can cancel it. */
  requestId: z.string().min(1).max(100),
  workspacePath: z.string().min(1),
  /** The instruction as plain text, chips replaced by their tokens. */
  text: z.string().min(1).max(PROMPT_STRUCTURE_MAX_INPUT_CHARS),
  mentions: z.array(PromptStructureMentionSchema).max(40).default([]),
  mode: AgentInteractionModeSchema.optional(),
  /** The task this instruction continues: its thread is context, and its cost carries the call. */
  runId: z.string().min(1).max(200).optional(),
  /** The composer's model, used when no utility model is set. */
  provider: z.string().min(1).max(100).optional(),
  model: z.string().min(1).max(300).optional(),
  /** Answers to the questions a first call asked: the brief is written now. */
  answers: z.array(PromptStructureAnswerSchema).max(3).optional(),
  /** Write the brief without asking anything (Skip). */
  noQuestions: z.boolean().optional(),
  /** Write a new one even when this exact request already has one (Try again). */
  force: z.boolean().optional()
})
export type PromptStructureRequest = z.input<typeof PromptStructureRequestSchema>

export const PromptStructureCancelRequestSchema = z.object({
  requestId: z.string().min(1).max(100)
})
export type PromptStructureCancelRequest = z.infer<typeof PromptStructureCancelRequestSchema>

export const PROMPT_TASK_TYPES = [
  'bug',
  'feature',
  'change',
  'refactor',
  'audit',
  'review',
  'question',
  'research',
  'docs',
  'test',
  'ops',
  'other'
] as const
export const PromptTaskTypeSchema = z.enum(PROMPT_TASK_TYPES)
export type PromptTaskType = z.infer<typeof PromptTaskTypeSchema>

export const PromptStructureQuestionSchema = z.object({
  id: z.string().min(1).max(20),
  question: z.string().min(1).max(500),
  options: z.array(z.string().min(1).max(200)).min(2).max(4),
  multi: z.boolean()
})
export type PromptStructureQuestion = z.infer<typeof PromptStructureQuestionSchema>

export const PromptStructureResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('brief'),
    taskType: PromptTaskTypeSchema,
    /** The brief, with the request's chip tokens in it exactly once each. */
    brief: z.string().min(1),
    /** Paths or commands named in the brief that the workspace does not have. */
    notFound: z.array(z.string()).optional(),
    /** The brief already written for this exact request — no model call made. */
    reused: z.boolean().optional()
  }),
  z.object({
    kind: z.literal('questions'),
    taskType: PromptTaskTypeSchema,
    questions: z.array(PromptStructureQuestionSchema).min(1).max(3)
  }),
  z.object({
    /** No brief: the draft stays as it is, and `reason` says why. */
    kind: z.literal('unavailable'),
    reason: z.string().min(1)
  }),
  z.object({ kind: z.literal('cancelled') })
])
export type PromptStructureResult = z.infer<typeof PromptStructureResultSchema>
