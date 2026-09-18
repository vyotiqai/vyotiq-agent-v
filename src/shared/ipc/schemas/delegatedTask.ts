import { z } from 'zod'
import { AgentProfileIdSchema } from './agentProfile'

/**
 * Delegated task — a prompt assigned to a teammate profile, executed through
 * the normal chatStart path (identical guarantees: steering, approvals,
 * notifications, badges). Persisted per workspace at `.vyotiq/tasks.json`.
 */
export const DelegatedTaskStatusSchema = z.enum([
  'queued',
  'scheduled',
  'running',
  'done',
  'failed',
  'cancelled'
])
export type DelegatedTaskStatus = z.infer<typeof DelegatedTaskStatusSchema>

export const DelegatedTaskSchema = z.object({
  id: z.string().min(1).max(80),
  profileId: AgentProfileIdSchema,
  workspacePath: z.string().min(1),
  prompt: z.string().min(1).max(20_000),
  status: DelegatedTaskStatusSchema,
  /** ISO time for scheduled tasks; absent = start as soon as a slot frees. */
  scheduledAt: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  error: z.string().max(2000).optional(),
  createdAt: z.string().min(1),
  startedAt: z.string().min(1).optional(),
  finishedAt: z.string().min(1).optional()
})
export type DelegatedTask = z.infer<typeof DelegatedTaskSchema>

export const TaskEnqueueRequestSchema = z.object({
  profileId: AgentProfileIdSchema,
  workspacePath: z.string().min(1),
  prompt: z.string().min(1).max(20_000),
  /** ISO datetime — omit to run as soon as the teammate is free. */
  scheduledAt: z
    .string()
    .min(1)
    .refine((value) => !Number.isNaN(Date.parse(value)), 'scheduledAt must be a parseable datetime')
    .optional()
})
export type TaskEnqueueRequest = z.infer<typeof TaskEnqueueRequestSchema>

export const TaskCancelRequestSchema = z.object({ id: z.string().min(1).max(80) })
export type TaskCancelRequest = z.infer<typeof TaskCancelRequestSchema>

/** Push payload: full aggregated list (rosters are small; avoids client diffing). */
export const TasksChangedEventSchema = z.object({
  tasks: z.array(DelegatedTaskSchema)
})
export type TasksChangedEvent = z.infer<typeof TasksChangedEventSchema>
