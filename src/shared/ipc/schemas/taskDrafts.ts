import { z } from 'zod'
import { ComposerAttachmentsBucketSchema } from './workspace'

/** Drafts kept per workspace; the oldest go past this. */
export const TASK_DRAFTS_MAX = 50
/** A brief longer than this is not a draft anyone saves by hand. */
export const TASK_DRAFT_BRIEF_MAX = 100_000
/** The same bounds New task puts on its checks (and chatStart enforces). */
export const TASK_DRAFT_CHECKS_MAX = 20
export const TASK_DRAFT_CHECK_CHARS_MAX = 500

/** A New task brief put aside: what to do, its checks, what was attached. */
export const TaskDraftSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9-]{8,64}$/),
  brief: z.string().max(TASK_DRAFT_BRIEF_MAX),
  doneWhen: z.array(z.string().trim().min(1).max(TASK_DRAFT_CHECK_CHARS_MAX)).max(TASK_DRAFT_CHECKS_MAX),
  attachments: ComposerAttachmentsBucketSchema.optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
})
export type TaskDraft = z.infer<typeof TaskDraftSchema>

export const TaskDraftsListRequestSchema = z.object({ workspacePath: z.string().min(1) })
export type TaskDraftsListRequest = z.infer<typeof TaskDraftsListRequestSchema>

export const TaskDraftsListResultSchema = z.object({ drafts: z.array(TaskDraftSchema) })
export type TaskDraftsListResult = z.infer<typeof TaskDraftsListResultSchema>

export const TaskDraftSaveRequestSchema = z
  .object({
    workspacePath: z.string().min(1),
    /** An existing draft's id updates it; none saves a new one. */
    id: TaskDraftSchema.shape.id.optional(),
    brief: TaskDraftSchema.shape.brief,
    doneWhen: TaskDraftSchema.shape.doneWhen,
    attachments: ComposerAttachmentsBucketSchema.optional()
  })
  .refine((req) => req.brief.trim().length > 0 || req.doneWhen.length > 0, {
    message: 'An empty brief is not a draft',
    path: ['brief']
  })
export type TaskDraftSaveRequest = z.infer<typeof TaskDraftSaveRequestSchema>

export const TaskDraftDeleteRequestSchema = z.object({
  workspacePath: z.string().min(1),
  id: TaskDraftSchema.shape.id
})
export type TaskDraftDeleteRequest = z.infer<typeof TaskDraftDeleteRequestSchema>
