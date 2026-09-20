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
  /**
   * Cancel requested, run not yet unwound. Durable so a restart mid-cancel
   * resumes as "stopping" rather than reviving the task as running.
   */
  'cancelling',
  'done',
  'failed',
  'cancelled'
])
export type DelegatedTaskStatus = z.infer<typeof DelegatedTaskStatusSchema>

export const DELEGATED_TASK_TERMINAL_STATUSES = ['done', 'failed', 'cancelled'] as const

export function isTerminalDelegatedTaskStatus(status: DelegatedTaskStatus): boolean {
  return (DELEGATED_TASK_TERMINAL_STATUSES as readonly string[]).includes(status)
}

/** ISO-8601 instants only — a NaN timestamp silently breaks every ordering. */
const IsoTimestampSchema = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be a parseable ISO timestamp')

/**
 * Longest task brief accepted, in characters. The brief becomes one user
 * message on the normal chat path (which has no cap of its own), so this
 * matches MAX_ATTACHMENT_CHARS: a pasted spec the size of one attached text
 * file fits. The assign-task dialog reads this same number to show a counter
 * and block submit, so an over-long brief never reaches the IPC validator.
 */
export const MAX_DELEGATED_TASK_PROMPT_CHARS = 120_000

export const DelegatedTaskBaseSchema = z.object({
  id: z.string().min(1).max(80),
  profileId: AgentProfileIdSchema,
  workspacePath: z.string().min(1),
  prompt: z.string().min(1).max(MAX_DELEGATED_TASK_PROMPT_CHARS),
  status: DelegatedTaskStatusSchema,
  /** ISO time for scheduled tasks; absent = start as soon as a slot frees. */
  scheduledAt: IsoTimestampSchema.optional(),
  runId: z.string().min(1).optional(),
  error: z.string().max(2000).optional(),
  createdAt: IsoTimestampSchema,
  startedAt: IsoTimestampSchema.optional(),
  finishedAt: IsoTimestampSchema.optional(),
  /** Set when this task was cloned from a terminal one by an explicit retry. */
  retryOf: z.string().min(1).max(80).optional()
})

/**
 * Cross-field invariants. A record that says `running` with no `runId` cannot
 * be reconciled, finalized, or linked to its transcript — persisting one turns
 * a recoverable restart into an orphan, so it is rejected at the boundary.
 */
export const DelegatedTaskSchema = DelegatedTaskBaseSchema.superRefine((task, ctx) => {
  const require = (field: 'scheduledAt' | 'runId' | 'startedAt' | 'finishedAt'): void => {
    if (task[field] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${task.status} tasks require ${field}`
      })
    }
  }
  if (task.status === 'scheduled') require('scheduledAt')
  if (task.status === 'running' || task.status === 'cancelling') {
    require('runId')
    require('startedAt')
  }
  if (isTerminalDelegatedTaskStatus(task.status)) require('finishedAt')
})
export type DelegatedTask = z.infer<typeof DelegatedTaskSchema>

/** Persisted envelope for `.vyotiq/tasks.json`. */
export const DELEGATED_TASKS_FILE_VERSION = 1
export const DelegatedTasksFileSchema = z.object({
  version: z.literal(DELEGATED_TASKS_FILE_VERSION),
  tasks: z.array(DelegatedTaskSchema)
})
export type DelegatedTasksFile = z.infer<typeof DelegatedTasksFileSchema>

export const TaskEnqueueRequestSchema = z.object({
  profileId: AgentProfileIdSchema,
  workspacePath: z.string().min(1),
  prompt: z.string().min(1).max(MAX_DELEGATED_TASK_PROMPT_CHARS),
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

/** Re-run a terminal task as a NEW record — never mutate the audited original. */
export const TaskRetryRequestSchema = z.object({ id: z.string().min(1).max(80) })
export type TaskRetryRequest = z.infer<typeof TaskRetryRequestSchema>

/** Push payload: full aggregated list (rosters are small; avoids client diffing). */
export const TasksChangedEventSchema = z.object({
  tasks: z.array(DelegatedTaskSchema)
})
export type TasksChangedEvent = z.infer<typeof TasksChangedEventSchema>
