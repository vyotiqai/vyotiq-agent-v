import { z } from 'zod'
import {
  AGENT_QUESTION_MAX_ANSWER_CHARS,
  AGENT_QUESTION_MAX_ANSWER_VALUES,
  AGENT_QUESTION_MAX_OPTION_CHARS,
  AGENT_QUESTION_MAX_OPTIONS,
  AGENT_QUESTION_MAX_PROMPT_CHARS
} from '../../utils/agentQuestionForm'

/*
  One question of an ask_question form, and an answer to one. On their own so
  the voice schemas can carry a form without importing agent.ts, which imports
  settings.ts, which imports voice.ts: a cycle that left them undefined at load.
*/

export const AgentQuestionTypeSchema = z.enum(['single', 'multi', 'boolean', 'text'])

export const AgentQuestionItemSchema = z
  .object({
    id: z.string().min(1),
    prompt: z.string().min(1).max(AGENT_QUESTION_MAX_PROMPT_CHARS),
    type: AgentQuestionTypeSchema,
    options: z
      .array(z.string().min(1).max(AGENT_QUESTION_MAX_OPTION_CHARS))
      .max(AGENT_QUESTION_MAX_OPTIONS)
      .optional(),
    allowCustom: z.boolean().optional()
  })
  .superRefine((item, ctx) => {
    if (item.type === 'single' || item.type === 'multi') {
      if (!item.options || item.options.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${item.type} requires at least 2 options`,
          path: ['options']
        })
      }
    }
  })
export type AgentQuestionItem = z.infer<typeof AgentQuestionItemSchema>

export const AgentQuestionAnswerSchema = z.object({
  questionId: z.string().min(1),
  values: z
    .array(z.string().max(AGENT_QUESTION_MAX_ANSWER_CHARS))
    .max(AGENT_QUESTION_MAX_ANSWER_VALUES)
})
export type AgentQuestionAnswer = z.infer<typeof AgentQuestionAnswerSchema>
