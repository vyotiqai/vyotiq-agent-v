import { z } from 'zod'
import { RunIdSchema } from './agent'
import { TaskCommitSettledSchema } from './taskOutcome'

export const GitChangedFileSchema = z.object({
  path: z.string(),
  status: z.enum(['modified', 'added', 'deleted', 'untracked', 'conflicted']),
  /** Combined line deltas (staged + unstaged). */
  added: z.number().int().min(0),
  removed: z.number().int().min(0),
  /** Index-side line deltas vs HEAD. */
  addedStaged: z.number().int().min(0),
  removedStaged: z.number().int().min(0),
  /** Worktree-side line deltas vs index (untracked counts as unstaged). */
  addedUnstaged: z.number().int().min(0),
  removedUnstaged: z.number().int().min(0),
  /** No line counts exist for binary files; only the fact that they changed. */
  binary: z.boolean(),
  /** Index (staged) side has a change — from porcelain XY. */
  staged: z.boolean(),
  /** Worktree side has a change — from porcelain XY. */
  unstaged: z.boolean()
})
export type GitChangedFile = z.infer<typeof GitChangedFileSchema>

export const GitStatusSchema = z.object({
  /** Null when the branch cannot be named, e.g. a detached HEAD. */
  branch: z.string().nullable(),
  files: z.array(GitChangedFileSchema),
  /**
   * The reported view is incomplete: either the file list hit its cap, or the
   * untracked listing could not be read at all (a workspace holding a large
   * untracked tree overruns git's output buffer). Tracked totals below always
   * cover every change — they come from a single numstat read — but untracked
   * lines are only measured for the files that ship, because measuring one
   * means reading it synchronously.
   */
  truncated: z.boolean(),
  fileCount: z.number().int().min(0),
  added: z.number().int().min(0),
  removed: z.number().int().min(0),
  hasRemote: z.boolean(),
  hasCommits: z.boolean(),
  /** Commits on HEAD not on the upstream — only when a tracking ref exists. */
  ahead: z.number().int().min(0).optional(),
  /** Commits on the upstream not on HEAD — only when a tracking ref exists. */
  behind: z.number().int().min(0).optional(),
  /** The branch's tracking ref (`origin/main`); absent when it has none yet (Publish). */
  upstream: z.string().min(1).optional(),
  /**
   * Programs this repository's own git settings name (filters, diff and merge
   * drivers, fsmonitor), which the app's git skips until the person allows
   * this exact set. `canAllow` is false when the repository can't be told
   * apart from its settings files, so an allowance would have nothing to key on.
   */
  repoCommands: z
    .object({
      blocked: z.array(z.object({ key: z.string(), value: z.string() })).min(1),
      canAllow: z.boolean()
    })
    .optional()
})
export type GitStatus = z.infer<typeof GitStatusSchema>

export const GitAllowRepoCommandsRequestSchema = z.object({
  workspacePath: z.string().min(1)
})
export type GitAllowRepoCommandsRequest = z.infer<typeof GitAllowRepoCommandsRequestSchema>

export const GitAllowRepoCommandsResultSchema = z.object({
  allowed: z.number().int().min(0)
})
export type GitAllowRepoCommandsResult = z.infer<typeof GitAllowRepoCommandsResultSchema>

export const GitStatusRequestSchema = z.object({
  workspacePath: z.string().min(1)
})

/**
 * Discriminated git status for the UI:
 * - `ok` — real working-tree snapshot
 * - `not_repo` — no `.git` at the workspace root
 * - `unavailable` — git binary missing / not on PATH
 */
export const GitStatusResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    status: GitStatusSchema
  }),
  z.object({
    kind: z.literal('not_repo')
  }),
  z.object({
    kind: z.literal('unavailable'),
    detail: z.string().min(1)
  })
])
export type GitStatusResult = z.infer<typeof GitStatusResultSchema>

export const GitGenerateCommitMessageRequestSchema = z.object({
  workspacePath: z.string().min(1),
  mode: z.enum(['all', 'staged']).optional().default('all'),
  /** Write a new message even when this exact diff already has one. */
  force: z.boolean().optional()
})

export const GitGenerateCommitMessageResultSchema = z.object({
  message: z.string().min(1).nullable(),
  source: z.enum(['agent', 'fallback']),
  reason: z.string().nullish(),
  /** The message already written for this exact diff — no model call made. */
  reused: z.boolean().optional()
})
export type GitGenerateCommitMessageResult = z.infer<
  typeof GitGenerateCommitMessageResultSchema
>

export const GitCommitRequestSchema = z.object({
  workspacePath: z.string().min(1),
  message: z.string().min(1).max(2000),
  push: z.boolean().optional(),
  /**
   * `all` stages the whole working tree then commits (Uncommitted).
   * `staged` commits the index only — no `git add -A` (Staged scope).
   */
  mode: z.enum(['all', 'staged']).optional().default('all'),
  /** The task whose Changes this was committed from: the commit settles its edits. */
  runId: RunIdSchema.optional()
})

export const GitCommitResultSchema = z.object({
  committed: z.boolean(),
  pushed: z.boolean(),
  detail: z.string(),
  /** Set when the commit took edits of the task named by `runId`. */
  task: TaskCommitSettledSchema.optional()
})
export type GitCommitResult = z.infer<typeof GitCommitResultSchema>

export const GitStageAllRequestSchema = z.object({
  workspacePath: z.string().min(1)
})

export const GitStageAllResultSchema = z.object({
  staged: z.boolean(),
  detail: z.string()
})
export type GitStageAllResult = z.infer<typeof GitStageAllResultSchema>

export const GitStagePathsRequestSchema = z.object({
  workspacePath: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1).max(500)
})

export const GitUnstagePathsRequestSchema = z.object({
  workspacePath: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1).max(500)
})

export const GitUnstagePathsResultSchema = z.object({
  unstaged: z.boolean(),
  detail: z.string()
})
export type GitUnstagePathsResult = z.infer<typeof GitUnstagePathsResultSchema>

/**
 * Throw away the person's own changes to some files. `worktree` drops what is
 * not staged (back to the staged copy); `all` drops staged and unstaged alike
 * (back to HEAD). A file git does not track is moved to the OS trash.
 */
export const GitDiscardPathsRequestSchema = z.object({
  workspacePath: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1).max(500),
  scope: z.enum(['worktree', 'all'])
})

export const GitDiscardPathsResultSchema = z.object({
  detail: z.string(),
  /** Paths whose changes were dropped. */
  discarded: z.array(z.string()),
  /** How many of them had their discarded copy put in the OS trash first. */
  backedUp: z.number().int().min(0)
})
export type GitDiscardPathsResult = z.infer<typeof GitDiscardPathsResultSchema>

export const GitBranchEntrySchema = z.object({
  name: z.string().min(1),
  current: z.boolean()
})
export type GitBranchEntry = z.infer<typeof GitBranchEntrySchema>

export const GitBranchesRequestSchema = z.object({
  workspacePath: z.string().min(1)
})

export const GitBranchesResultSchema = z.array(GitBranchEntrySchema)
export type GitBranchesResult = z.infer<typeof GitBranchesResultSchema>

/** Short or full git object id — never an option-like string such as `--output=`. */
export const GitObjectIdSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{7,64}$/, 'Invalid git object id')

export const GitCheckoutRequestSchema = z.object({
  workspacePath: z.string().min(1),
  // Existing local branch name: no option-like prefix, whitespace, backslash, or '..'.
  branch: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((name) => !name.startsWith('-') && !name.includes('..') && !/[\s\\]/.test(name), {
      message: 'Invalid branch name'
    }),
  /**
   * Stash uncommitted changes (untracked files too) on the branch being left,
   * instead of carrying them over; they come back from the branch's stash.
   */
  leaveChanges: z.boolean().optional()
})

export const GitCheckoutResultSchema = z.object({
  detail: z.string(),
  /** The changes were stashed on the branch that was left. */
  stashed: z.boolean().optional()
})
export type GitCheckoutResult = z.infer<typeof GitCheckoutResultSchema>

export const GitBranchStashRequestSchema = z.object({
  workspacePath: z.string().min(1)
})

/** Changes left on the current branch by a switch, waiting in `git stash`. Null when there are none. */
export const GitBranchStashSchema = z.object({
  /** The stash commit: stash@{n} numbers move as stashes come and go, this does not. */
  sha: z.string().regex(/^[0-9a-f]{40,64}$/),
  branch: z.string().min(1),
  files: z.number().int().min(0),
  createdAt: z.string().nullable()
})
export type GitBranchStash = z.infer<typeof GitBranchStashSchema>
export const GitBranchStashResultSchema = GitBranchStashSchema.nullable()
export type GitBranchStashResult = z.infer<typeof GitBranchStashResultSchema>

export const GitStashRestoreRequestSchema = z.object({
  workspacePath: z.string().min(1),
  sha: z.string().regex(/^[0-9a-f]{40,64}$/, 'Invalid stash')
})

export const GitStashRestoreResultSchema = z.object({
  detail: z.string(),
  /** Some files came back with conflicts; the stash was kept. */
  conflicted: z.boolean()
})
export type GitStashRestoreResult = z.infer<typeof GitStashRestoreResultSchema>

/** One hunk of a file's diff, as `@shared/utils/hunkPatch`'s `hunkIdentity` names it. */
export const GitHunkIdentitySchema = z.object({
  oldStart: z.number().int().min(0),
  oldLines: z.number().int().min(0),
  newStart: z.number().int().min(0),
  newLines: z.number().int().min(0),
  hash: z.string().min(1).max(32)
})

/**
 * Stage one hunk of the unstaged diff, or (`unstage`) take one hunk of the
 * staged diff back out of the index. The working tree never changes.
 */
export const GitStageHunkRequestSchema = z.object({
  workspacePath: z.string().min(1),
  path: z.string().min(1).max(4096),
  hunk: GitHunkIdentitySchema,
  /** `diffFingerprint` of the whole diff that was on screen. */
  diffHash: z.string().min(1).max(32),
  unstage: z.boolean().optional()
})

export const GitStageHunkResultSchema = z.object({
  detail: z.string()
})
export type GitStageHunkResult = z.infer<typeof GitStageHunkResultSchema>

export const GitLastCommitRequestSchema = z.object({
  workspacePath: z.string().min(1)
})

/** HEAD's commit as Amend needs it. Null with no commit or a detached HEAD. */
export const GitLastCommitSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40,64}$/),
  /** The whole message, subject and body. */
  message: z.string(),
  /** A remote-tracking branch holds it: amending would need a force push, so it is not offered. */
  pushed: z.boolean(),
  /** A merge commit or the first commit: not offered for amend here either. */
  amendable: z.boolean()
})
export type GitLastCommit = z.infer<typeof GitLastCommitSchema>
export const GitLastCommitResultSchema = GitLastCommitSchema.nullable()
export type GitLastCommitResult = z.infer<typeof GitLastCommitResultSchema>

export const GitAmendRequestSchema = z.object({
  workspacePath: z.string().min(1),
  message: z.string().min(1).max(2000),
  mode: z.enum(['all', 'staged']).optional().default('all'),
  /** The commit being amended: it must still be HEAD. */
  sha: z.string().regex(/^[0-9a-f]{40,64}$/, 'Invalid commit'),
  runId: RunIdSchema.optional()
})

// ── Sync: fetch / pull / push / new branch (user-initiated only) ────────────

export const GitFetchRequestSchema = z.object({
  workspacePath: z.string().min(1),
  /**
   * The app's own periodic fetch, not a click: skipped when this checkout
   * fetched a moment ago, quiet when it fails, and held off for a while after.
   */
  background: z.boolean().optional()
})
export type GitFetchRequest = z.infer<typeof GitFetchRequestSchema>

export const GitFetchResultSchema = z.object({
  detail: z.string(),
  ahead: z.number().int().min(0).optional(),
  behind: z.number().int().min(0).optional(),
  /** Background only: nothing was fetched (too soon, no upstream, or held off after a failure). */
  skipped: z.boolean().optional()
})
export type GitFetchResult = z.infer<typeof GitFetchResultSchema>

/** `ff-only` (default) never makes a merge commit; the other two are the answer to `diverged`. */
export const GitPullStrategySchema = z.enum(['ff-only', 'rebase', 'merge'])
export type GitPullStrategy = z.infer<typeof GitPullStrategySchema>

export const GitPullRequestSchema = z.object({
  workspacePath: z.string().min(1),
  strategy: GitPullStrategySchema.optional()
})
export type GitPullRequest = z.infer<typeof GitPullRequestSchema>

export const GitPullResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pulled'), detail: z.string() }),
  z.object({ kind: z.literal('up-to-date'), detail: z.string() }),
  z.object({
    kind: z.literal('diverged'),
    detail: z.string(),
    ahead: z.number().int().min(0),
    behind: z.number().int().min(0),
    upstream: z.string()
  }),
  z.object({ kind: z.literal('conflicted'), detail: z.string(), files: z.number().int().min(0) })
])
export type GitPullResult = z.infer<typeof GitPullResultSchema>

/** No force flag exists: a rejected push is answered by pulling. */
export const GitPushRequestSchema = z.object({
  workspacePath: z.string().min(1),
  /** Default true: a branch with no upstream is published to origin and tracks it. */
  setUpstream: z.boolean().optional()
})
export type GitPushRequest = z.infer<typeof GitPushRequestSchema>

export const GitPushResultSchema = z.object({
  detail: z.string(),
  upstream: z.string(),
  /** The branch had no upstream and now does. */
  published: z.boolean()
})
export type GitPushResult = z.infer<typeof GitPushResultSchema>

export const GitCreateBranchRequestSchema = z.object({
  workspacePath: z.string().min(1),
  name: z.string().trim().min(1).max(255),
  /** A commit-ish to start from; HEAD when omitted. Never option-like. */
  from: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((ref) => !ref.startsWith('-') && !/\s/.test(ref), { message: 'Invalid starting point' })
    .optional(),
  /** Switch to the new branch (default true). */
  checkout: z.boolean().optional()
})
export type GitCreateBranchRequest = z.infer<typeof GitCreateBranchRequestSchema>

export const GitCreateBranchResultSchema = z.object({
  branch: z.string(),
  detail: z.string()
})
export type GitCreateBranchResult = z.infer<typeof GitCreateBranchResultSchema>

export const GitDiffRequestSchema = z.object({
  workspacePath: z.string().min(1),
  path: z.string().optional(),
  staged: z.boolean().optional(),
  /** Ignore whitespace when computing the diff (`git diff -w`). */
  ignoreWhitespace: z.boolean().optional(),
  /** When set, show the patch introduced by this commit (`git show`). */
  sha: GitObjectIdSchema.optional(),
  /** Combined working-tree + index vs HEAD (`git diff HEAD`). Uncommitted scope. */
  vsHead: z.boolean().optional()
})
export type GitDiffRequest = z.infer<typeof GitDiffRequestSchema>

export const GitBranchDiffRequestSchema = z.object({ workspacePath: z.string().min(1) })

export const GitBranchDiffResultSchema = z.object({
  content: z.string(),
  branch: z.string().nullable(),
  /** The branch it is compared with; null means uncommitted changes only. */
  base: z.string().nullable(),
  commits: z.number().int().min(0)
})
export type GitBranchDiffResult = z.infer<typeof GitBranchDiffResultSchema>

export const GitDiffResultSchema = z.object({
  content: z.string()
})
export type GitDiffResult = z.infer<typeof GitDiffResultSchema>

export const GitBlameRequestSchema = z.object({
  workspacePath: z.string().min(1),
  path: z.string().min(1)
})
export type GitBlameRequest = z.infer<typeof GitBlameRequestSchema>

export const GitBlameLineSchema = z.object({
  line: z.number().int().positive(),
  sha: z.string().regex(/^[0-9a-f]{7,64}$/i).nullable(),
  shortSha: z.string().regex(/^[0-9a-f]{7,64}$/i).nullable(),
  author: z.string().max(512),
  date: z.string().max(128),
  text: z.string().max(32_768)
})
export type GitBlameLine = z.infer<typeof GitBlameLineSchema>

export const GitBlameResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    path: z.string().min(1),
    lines: z.array(GitBlameLineSchema).max(20_000),
    truncated: z.boolean()
  }),
  z.object({
    kind: z.literal('unavailable'),
    detail: z.string().min(1).max(512)
  }),
  z.object({
    kind: z.literal('not_repo'),
    detail: z.string().min(1).max(512)
  })
])
export type GitBlameResult = z.infer<typeof GitBlameResultSchema>

export const GitLogEntrySchema = z.object({
  sha: z.string().min(1),
  shortSha: z.string().min(1),
  subject: z.string(),
  author: z.string(),
  relativeDate: z.string()
})
export type GitLogEntry = z.infer<typeof GitLogEntrySchema>

export const GitLogRequestSchema = z.object({
  workspacePath: z.string().min(1),
  limit: z.number().int().positive().max(100).optional()
})

export const GitLogResultSchema = z.array(GitLogEntrySchema)
export type GitLogResult = z.infer<typeof GitLogResultSchema>

export const GitCommitFilesRequestSchema = z.object({
  workspacePath: z.string().min(1),
  sha: GitObjectIdSchema
})

export const GitCommitFilesResultSchema = z.object({
  files: z.array(GitChangedFileSchema)
})
export type GitCommitFilesResult = z.infer<typeof GitCommitFilesResultSchema>

/**
 * Payload pushed from main after a workspace's git status may have changed.
 * Subscribers re-pull a fresh snapshot via IPC.gitStatus, so the payload only
 * identifies the workspace.
 */
export const GitInitRequestSchema = z.object({
  workspacePath: z.string().min(1)
})
export type GitInitRequest = z.infer<typeof GitInitRequestSchema>

/** The branch `git init` landed on — whatever the user's init.defaultBranch is. */
export const GitInitResultSchema = z.object({
  branch: z.string().nullable()
})
export type GitInitResult = z.infer<typeof GitInitResultSchema>

export const GitStatusChangedPayloadSchema = z.object({
  workspacePath: z.string().min(1)
})
export type GitStatusChangedPayload = z.infer<typeof GitStatusChangedPayloadSchema>

export const GitConflictFileRequestSchema = z.object({
  workspacePath: z.string().min(1),
  path: z.string().min(1).max(4_096)
})

export const GitConflictFileResultSchema = z.object({
  ours: z.string(),
  theirs: z.string(),
  base: z.string(),
  working: z.string()
})
export type GitConflictFileResult = z.infer<typeof GitConflictFileResultSchema>

export const GitResolveConflictRequestSchema = z.object({
  workspacePath: z.string().min(1),
  path: z.string().min(1).max(4_096),
  content: z.string()
})
