import { z } from 'zod'

export const FEEDBACK_TITLE_MAX = 200
export const FEEDBACK_MESSAGE_MAX = 8000

export const FeedbackTypeSchema = z.enum(['bug', 'feature', 'praise', 'other'])
export type FeedbackType = z.infer<typeof FeedbackTypeSchema>

export const FeedbackComposeRequestSchema = z.object({
  type: FeedbackTypeSchema,
  title: z.string().trim().min(1).max(FEEDBACK_TITLE_MAX),
  message: z.string().trim().min(1).max(FEEDBACK_MESSAGE_MAX),
  includeDiagnostics: z.boolean()
})
export type FeedbackComposeRequest = z.infer<typeof FeedbackComposeRequestSchema>

export const FeedbackComposeResultSchema = z.object({
  ok: z.literal(true),
  mailto: z.string().min(1)
})
export type FeedbackComposeResult = z.infer<typeof FeedbackComposeResultSchema>
