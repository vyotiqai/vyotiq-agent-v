import { z } from 'zod'

/**
 * A whole task in its own git worktree: a new branch checked out in a folder
 * of its own, opened as a workspace. The task edits only there; Merge brings
 * the branch back into the branch it came from, Discard deletes both.
 */
export const TaskWorktreeCreateRequestSchema = z.object({
  /** The workspace the worktree branches from (its current branch). */
  workspacePath: z.string().min(1),
  /** The brief — the branch and folder are named from its first words. */
  brief: z.string().max(100_000)
})
export type TaskWorktreeCreateRequest = z.infer<typeof TaskWorktreeCreateRequestSchema>

export const TaskWorktreePathRequestSchema = z.object({
  /** The worktree's workspace path, as created. */
  workspacePath: z.string().min(1)
})
export type TaskWorktreePathRequest = z.infer<typeof TaskWorktreePathRequestSchema>

export const TaskWorktreeMergeRequestSchema = TaskWorktreePathRequestSchema.extend({
  /** Commits the worktree's uncommitted files first, under this message. */
  message: z.string().trim().min(1).max(2_000)
})
export type TaskWorktreeMergeRequest = z.infer<typeof TaskWorktreeMergeRequestSchema>

export const TaskWorktreeSchema = z.object({
  /** The workspace to open: the worktree folder, or the same subfolder in it. */
  workspacePath: z.string().min(1),
  /** The worktree's own root (what git knows it as). */
  worktreeRoot: z.string().min(1),
  parentPath: z.string().min(1),
  branch: z.string().min(1),
  /** The parent's branch when the worktree was made — what Merge goes into. */
  baseBranch: z.string().min(1),
  createdAt: z.string(),
  mergedAt: z.string().optional()
})
export type TaskWorktree = z.infer<typeof TaskWorktreeSchema>

/** A task worktree as it stands now. */
export const TaskWorktreeInfoSchema = TaskWorktreeSchema.extend({
  /** Commits on the branch that its base does not have — or, with the base gone, that no other branch has. */
  ahead: z.number().int().min(0),
  /** The branch it came from no longer exists (deleted or renamed): nothing to merge into. */
  baseMissing: z.boolean(),
  /** Uncommitted files in the worktree. */
  uncommitted: z.number().int().min(0),
  /** Whether the folder it came from is still there. */
  parentExists: z.boolean()
})
export type TaskWorktreeInfo = z.infer<typeof TaskWorktreeInfoSchema>

export type TaskWorktreeMergeResult =
  | { merged: true; commits: number; committedFirst: boolean }
  | { merged: false; conflicts: string[]; committedFirst: boolean }
