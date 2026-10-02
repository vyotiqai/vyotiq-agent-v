import { z } from 'zod'
import { AgentInteractionModeSchema } from './settings'
import { ProviderIdSchemaAny } from './providers'
import { parseCron } from '../../scheduleTime'

/**
 * A task that repeats: the brief it starts with, where, and when. Runs only
 * while the app is open; a run missed while it was closed or asleep is made
 * up once, never once per missed slot.
 */

/** The shortest repeat. Anything tighter is a loop, not a schedule. */
export const SCHEDULE_INTERVAL_MIN_MINUTES = 15
/** A week; longer intervals are what daily/weekly/cron are for. */
export const SCHEDULE_INTERVAL_MAX_MINUTES = 7 * 24 * 60
export const SCHEDULE_BRIEF_MAX = 100_000
export const SCHEDULES_MAX = 100

const TimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)')

export const TaskScheduleSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), time: TimeOfDaySchema }),
  z.object({
    kind: z.literal('weekly'),
    /** 0 = Sunday … 6 = Saturday. */
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1, 'Pick at least one day')
      .max(7)
      .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
    time: TimeOfDaySchema
  }),
  z.object({
    kind: z.literal('interval'),
    minutes: z.number().int().min(SCHEDULE_INTERVAL_MIN_MINUTES).max(SCHEDULE_INTERVAL_MAX_MINUTES)
  }),
  z.object({
    kind: z.literal('cron'),
    expr: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .superRefine((expr, ctx) => {
        const parsed = parseCron(expr)
        if (!parsed.ok) ctx.addIssue({ code: 'custom', message: parsed.error })
      })
  })
])
export type TaskScheduleSpec = z.infer<typeof TaskScheduleSpecSchema>

const ScheduleIdSchema = z.string().regex(/^[a-zA-Z0-9-]{8,64}$/)

/**
 * What the last due time did: started a run, was skipped, or could not start.
 * `starting` is the gap while a new worktree is made and opened for the run;
 * it becomes `started` or `failed` once the window has opened it.
 */
export const TaskScheduleOutcomeSchema = z.object({
  kind: z.enum(['started', 'skipped', 'failed', 'starting']),
  at: z.string().min(1),
  runId: z.string().min(1).max(128).optional(),
  /** Why it skipped or failed, or "catching up a missed run from …". */
  detail: z.string().max(500).optional()
})
export type TaskScheduleOutcome = z.infer<typeof TaskScheduleOutcomeSchema>

export const TaskScheduleSchema = z.object({
  id: ScheduleIdSchema,
  workspacePath: z.string().min(1),
  /** The brief each run starts with. */
  instruction: z.string().trim().min(1).max(SCHEDULE_BRIEF_MAX),
  mode: AgentInteractionModeSchema.default('agent'),
  /** Pinned model; absent runs on the workspace/global default at the time. */
  provider: ProviderIdSchemaAny.optional(),
  model: z.string().min(1).max(500).optional(),
  doneWhen: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  /**
   * Each run starts in a new task worktree branched from `workspacePath`
   * (src/main/git/taskWorktrees.ts), as New task's "in a new worktree" does.
   * Absent is false: the run starts in `workspacePath` itself.
   */
  worktree: z.boolean().optional(),
  schedule: TaskScheduleSpecSchema,
  enabled: z.boolean().default(true),
  lastRunAt: z.string().min(1).optional(),
  lastRunId: z.string().min(1).max(128).optional(),
  lastOutcome: TaskScheduleOutcomeSchema.optional(),
  /** Absent only when the schedule has no further time (a cron that cannot match again). */
  nextRunAt: z.string().min(1).optional(),
  createdAt: z.string().min(1)
})
export type TaskSchedule = z.infer<typeof TaskScheduleSchema>

export const TaskSchedulesListResultSchema = z.object({ schedules: z.array(TaskScheduleSchema) })
export type TaskSchedulesListResult = z.infer<typeof TaskSchedulesListResultSchema>

/**
 * A pinned model on a request: both set pins it, both null runs on the
 * default model, both absent leaves it as it is (on create from a task: that
 * task's model). One without the other is not a choice.
 */
const pinnedModelFields = {
  provider: ProviderIdSchemaAny.nullable().optional(),
  model: z.string().min(1).max(500).nullable().optional()
}
function modelPairOk(req: { provider?: unknown; model?: unknown }): boolean {
  const state = (v: unknown): string => (v === undefined ? 'absent' : v === null ? 'null' : 'set')
  return state(req.provider) === state(req.model)
}
const modelPairIssue = { message: 'Pick a provider and a model, or neither', path: ['model'] }

export const TaskScheduleCreateRequestSchema = z
  .object({
    workspacePath: z.string().min(1),
    /** The brief to repeat; or `fromRunId`, whose first instruction and checks are read from disk. */
    instruction: z.string().trim().min(1).max(SCHEDULE_BRIEF_MAX).optional(),
    fromRunId: z.string().min(1).max(128).optional(),
    mode: AgentInteractionModeSchema.optional(),
    ...pinnedModelFields,
    doneWhen: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    /** Each run in a new worktree. From a task that ran in one, the worktree's parent is what branches. */
    worktree: z.boolean().optional(),
    schedule: TaskScheduleSpecSchema,
    enabled: z.boolean().optional()
  })
  .refine((req) => Boolean(req.instruction) !== Boolean(req.fromRunId), {
    message: 'Give the brief or the task to repeat, not both',
    path: ['instruction']
  })
  .refine(modelPairOk, modelPairIssue)
export type TaskScheduleCreateRequest = z.infer<typeof TaskScheduleCreateRequestSchema>

export const TaskScheduleUpdateRequestSchema = z
  .object({
    id: ScheduleIdSchema,
    instruction: z.string().trim().min(1).max(SCHEDULE_BRIEF_MAX).optional(),
    mode: AgentInteractionModeSchema.optional(),
    ...pinnedModelFields,
    worktree: z.boolean().optional(),
    schedule: TaskScheduleSpecSchema.optional(),
    enabled: z.boolean().optional()
  })
  .refine(modelPairOk, modelPairIssue)
export type TaskScheduleUpdateRequest = z.infer<typeof TaskScheduleUpdateRequestSchema>

/** Repeat…'s question before it asks when: what would repeat, read from the task's own record. */
export const TaskScheduleSourceRequestSchema = z.object({
  workspacePath: z.string().min(1),
  runId: z.string().min(1).max(128)
})
export type TaskScheduleSourceRequest = z.infer<typeof TaskScheduleSourceRequestSchema>

export const TaskScheduleSourceSchema = z.object({
  instruction: z.string().min(1),
  mode: AgentInteractionModeSchema.optional(),
  /** The model the task ran on (its receipt); absent when it never reached one. */
  provider: ProviderIdSchemaAny.optional(),
  model: z.string().min(1).optional(),
  /** The task ran in a task worktree of its own; its branch. */
  worktreeBranch: z.string().min(1).optional(),
  /** A new worktree can be made each run: the folder (or the worktree's parent) is a git repository. */
  canWorktree: z.boolean()
})
export type TaskScheduleSource = z.infer<typeof TaskScheduleSourceSchema>

/**
 * Main → renderer: a scheduled run's worktree is made; open it as a workspace
 * the way New task in a new worktree does, then answer with `token`.
 */
export const TaskScheduleWorktreeOpenRequestSchema = z.object({
  token: z.string().uuid(),
  scheduleId: ScheduleIdSchema,
  workspacePath: z.string().min(1),
  branch: z.string().min(1).max(300)
})
export type TaskScheduleWorktreeOpenRequest = z.infer<typeof TaskScheduleWorktreeOpenRequestSchema>

/** Renderer → main: the worktree is open (start the run), or why it couldn't be. */
export const TaskScheduleWorktreeOpenedSchema = z.object({
  token: z.string().uuid(),
  error: z.string().min(1).max(400).optional()
})
export type TaskScheduleWorktreeOpened = z.infer<typeof TaskScheduleWorktreeOpenedSchema>

export const TaskScheduleIdRequestSchema = z.object({ id: ScheduleIdSchema })
export type TaskScheduleIdRequest = z.infer<typeof TaskScheduleIdRequestSchema>

export const TaskScheduleToggleRequestSchema = z.object({ id: ScheduleIdSchema, enabled: z.boolean() })
export type TaskScheduleToggleRequest = z.infer<typeof TaskScheduleToggleRequestSchema>

/** On a run's status and its navigator summary: the schedule that started it. */
export const RunScheduledSchema = z.object({
  scheduleId: z.string().min(1).max(64),
  /** The schedule in words when the run started ("Daily at 09:00"). */
  label: z.string().min(1).max(200),
  /** Set when this run made up a time missed while the app was closed or asleep. */
  catchUpFrom: z.string().min(1).optional()
})
export type RunScheduled = z.infer<typeof RunScheduledSchema>
