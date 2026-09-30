import { z } from 'zod'
import { RunIdSchema } from './agent'

/**
 * How a task's edits were settled after review: Keep, Undo and Commit, and
 * taking each of them back. The outcome is kept with the run (outcome.json
 * beside its write checkpoints), so the record can say it after a reload.
 */

const CommitShaSchema = z.string().regex(/^[0-9a-f]{40,64}$/)

export const TaskOutcomeRequestSchema = z.object({
  workspacePath: z.string().min(1),
  runId: RunIdSchema
})
export type TaskOutcomeRequest = z.infer<typeof TaskOutcomeRequestSchema>

export const TaskOutcomeCommitSchema = z.object({
  sha: CommitShaSchema,
  /** Null when HEAD was detached. */
  branch: z.string().nullable(),
  at: z.string(),
  pushed: z.boolean()
})
export type TaskOutcomeCommit = z.infer<typeof TaskOutcomeCommitSchema>

export const TaskOutcomeSchema = z.object({
  /** Each file the task wrote, by its newest write: kept, undone or still waiting. */
  files: z.array(z.object({ path: z.string(), mark: z.enum(['kept', 'undone', 'pending']) })),
  /** The commit made from this task's Changes, when there was one. */
  commit: TaskOutcomeCommitSchema.optional()
})
export type TaskOutcome = z.infer<typeof TaskOutcomeSchema>

/** Take back a Keep or an Undo: in one checkpoint, or each path's newest. */
export const ReopenWritesRequestSchema = z
  .object({
    workspacePath: z.string().min(1),
    runId: RunIdSchema,
    checkpointId: z
      .string()
      .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)
      .optional(),
    paths: z.array(z.string().min(1).max(4096)).max(10_000).optional()
  })
  .refine((req) => Boolean(req.checkpointId || req.paths?.length), {
    message: 'Name the files or the checkpoint to reopen'
  })
export type ReopenWritesRequest = z.infer<typeof ReopenWritesRequestSchema>

const ReopenedCheckpointFileSchema = z.object({
  path: z.string(),
  action: z.enum(['created', 'modified', 'deleted']),
  undoable: z.boolean(),
  resolved: z.enum(['kept', 'discarded']).optional(),
  conflicted: z.boolean().optional()
})

export const ReopenWritesResultSchema = z.object({
  reopened: z.array(z.string()),
  /** Undone, then changed since: left as they are. */
  conflicted: z.array(z.string()),
  skipped: z.array(z.string()),
  /** The checkpoints that changed, with their files as they are now. */
  checkpoints: z.array(z.object({ checkpointId: z.string(), files: z.array(ReopenedCheckpointFileSchema) }))
})
export type ReopenWritesResult = z.infer<typeof ReopenWritesResultSchema>

/** Take back the commit made from this task's Changes, keeping its changes staged. */
export const UndoTaskCommitRequestSchema = z.object({
  workspacePath: z.string().min(1),
  runId: RunIdSchema,
  sha: CommitShaSchema
})
export type UndoTaskCommitRequest = z.infer<typeof UndoTaskCommitRequestSchema>

/** What a commit from a task's Changes did to that task. */
export const TaskCommitSettledSchema = z.object({
  sha: CommitShaSchema,
  branch: z.string().nullable(),
  /** Files the commit kept that were still waiting on review. */
  kept: z.array(z.string()),
  /** Can be taken back from its toast: made here, and not pushed. */
  undoable: z.boolean()
})
export type TaskCommitSettled = z.infer<typeof TaskCommitSettledSchema>
