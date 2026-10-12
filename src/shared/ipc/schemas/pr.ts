import { z } from 'zod'
import { RunIdSchema } from './agent'
import { TaskCommitSettledSchema } from './taskOutcome'

export const PrMergeMethodSchema = z.enum(['squash', 'merge', 'rebase'])
export type PrMergeMethod = z.infer<typeof PrMergeMethodSchema>

export const PrChangeTypeSchema = z.enum([
  'ADDED',
  'DELETED',
  'MODIFIED',
  'RENAMED',
  'COPIED',
  'CHANGED',
  'UNKNOWN'
])
export type PrChangeType = z.infer<typeof PrChangeTypeSchema>

export const PrFileSchema = z.object({
  path: z.string(),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  changeType: PrChangeTypeSchema
})
export type PrFile = z.infer<typeof PrFileSchema>

export const PrCommitSchema = z.object({
  oid: z.string(),
  messageHeadline: z.string(),
  authors: z.array(z.string())
})

export const PrCheckSchema = z.object({
  name: z.string(),
  state: z.string(),
  conclusion: z.string().nullable(),
  /** The run's page on GitHub — where its log is. */
  url: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  /** A status context's own one-line summary ("2 failing tests"). */
  description: z.string().nullable().optional()
})
export type PrCheck = z.infer<typeof PrCheckSchema>

export const PrReviewSchema = z.object({
  author: z.string(),
  state: z.string(),
  body: z.string(),
  submittedAt: z.string().nullable()
})
export type PrReview = z.infer<typeof PrReviewSchema>

/** One comment in the pull request's main conversation (not a review thread). */
export const PrCommentSchema = z.object({
  author: z.string(),
  body: z.string(),
  createdAt: z.string().nullable(),
  url: z.string().nullable(),
  /** Hidden on GitHub as spam, off-topic, outdated… — shown folded, as GitHub does. */
  minimized: z.boolean()
})
export type PrComment = z.infer<typeof PrCommentSchema>

/** Auto-merge as GitHub has it set on the pull request. */
export const PrAutoMergeSchema = z.object({
  method: z.string(),
  enabledBy: z.string().nullable()
})
export type PrAutoMerge = z.infer<typeof PrAutoMergeSchema>

export const PrViewSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
  baseRefOid: z.string(),
  headRefOid: z.string(),
  body: z.string(),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  files: z.array(PrFileSchema),
  commits: z.array(PrCommitSchema),
  checks: z.array(PrCheckSchema),
  reviews: z.array(PrReviewSchema),
  latestReviews: z.array(PrReviewSchema),
  reviewDecision: z.string(),
  reviewRequests: z.array(z.string()),
  isDraft: z.boolean().default(false),
  /** GitHub's mergeability: CLEAN, BLOCKED, DIRTY, BEHIND, UNSTABLE, DRAFT… ('' when gh is too old). */
  mergeStateStatus: z.string().default(''),
  /** The conversation's comments, oldest first (the latest 50 when there are more). */
  comments: z.array(PrCommentSchema).optional(),
  /** How many comments the conversation has in all. */
  commentCount: z.number().int().min(0).optional(),
  /** Set while auto-merge is on; null when it is off. Absent when gh could not say. */
  autoMerge: PrAutoMergeSchema.nullable().optional(),
  /** GitHub would take an auto-merge request from you now (the repo allows it and the PR still waits on something). */
  canAutoMerge: z.boolean().optional(),
  /** The base branch merges through a merge queue: Merge adds the PR to it. Absent when GitHub could not say. */
  mergeQueueRequired: z.boolean().optional(),
  /** Set while the PR waits in the merge queue; `position` is GitHub's, 1 first. */
  mergeQueue: z.object({ position: z.number().int().min(1).nullable() }).nullable().optional()
})
export type PrView = z.infer<typeof PrViewSchema>

export const PrViewRequestSchema = z.object({
  workspacePath: z.string().min(1),
  /** A pull request by number; unset, the one for the current branch. */
  number: z.number().int().positive().optional()
})

export const PrCreateRequestSchema = z.object({
  workspacePath: z.string().min(1),
  /** When present, commit these changes before creating/updating the PR. */
  message: z.string().trim().min(1).max(2000).optional(),
  mode: z.enum(['all', 'staged']).optional().default('all'),
  /** Draft is the safe default for automated creation. */
  draft: z.boolean().optional().default(true),
  /**
   * Title and description written for the PR (the PR panel drafts them from
   * the task's result and its done-when checks). No title: gh's `--fill`.
   */
  title: z.string().trim().min(1).max(256).optional(),
  /** GitHub caps a PR body at 65,536 characters. */
  body: z.string().max(65_536).optional(),
  /** The task whose Changes this was committed from: the commit settles its edits. */
  runId: RunIdSchema.optional()
})

export const PrCreateResultSchema = z.object({
  url: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  draft: z.boolean(),
  detail: z.string().min(1),
  /** Set when the commit took edits of the task named by `runId`. */
  task: TaskCommitSettledSchema.optional()
})
export type PrCreateResult = z.infer<typeof PrCreateResultSchema>

export const PrMergeRequestSchema = z.object({
  workspacePath: z.string().min(1),
  method: PrMergeMethodSchema,
  number: z.number().int().positive()
})

export const PrMergeResultSchema = z.object({
  detail: z.string()
})
export type PrMergeResult = z.infer<typeof PrMergeResultSchema>

export const PrDiffRequestSchema = z.object({
  workspacePath: z.string().min(1),
  path: z.string().min(1).optional(),
  ignoreWhitespace: z.boolean().optional(),
  number: z.number().int().positive()
})

export const PrDiffResultSchema = z.object({
  content: z.string()
})

export const PrCloseRequestSchema = z.object({
  workspacePath: z.string().min(1),
  number: z.number().int().positive()
})

export const PrReadyRequestSchema = z.object({
  workspacePath: z.string().min(1),
  number: z.number().int().positive()
})

export const PrCloseResultSchema = z.object({
  detail: z.string()
})

export const PrEditTitleRequestSchema = z.object({
  workspacePath: z.string().min(1),
  title: z.string().min(1).max(256),
  number: z.number().int().positive()
})

export const PrEditTitleResultSchema = z.object({
  title: z.string()
})

export const PrReviewRequestSchema = z.object({
  workspacePath: z.string().min(1),
  event: z.enum(['approve', 'request-changes', 'comment']),
  body: z.string().max(8_000).optional(),
  number: z.number().int().positive().optional()
})

export const PrReviewResultSchema = z.object({
  detail: z.string()
})
export type PrReviewResult = z.infer<typeof PrReviewResultSchema>

export const GithubIssuesListRequestSchema = z.object({
  workspacePath: z.string().min(1)
})

export const GithubIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  state: z.string()
})

export const GithubIssuesListResultSchema = z.object({
  issues: z.array(GithubIssueSchema).max(50)
})
export type GithubIssuesListResult = z.infer<typeof GithubIssuesListResultSchema>

export const GithubIssueCreateRequestSchema = z.object({
  workspacePath: z.string().min(1),
  title: z.string().min(1).max(256),
  body: z.string().max(8_000).optional()
})

export const GithubIssueCreateResultSchema = z.object({
  url: z.string(),
  detail: z.string()
})
export type GithubIssueCreateResult = z.infer<typeof GithubIssueCreateResultSchema>

/** A GraphQL node id (`PRRT_kwDO…`): what resolve and reply name a thread by. */
export const PrReviewThreadIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_=-]+$/, 'Invalid review thread id')

export const PrReviewThreadCommentSchema = z.object({
  id: z.string(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string().nullable(),
  /** The comment on GitHub (https only). */
  url: z.string().nullable()
})
export type PrReviewThreadComment = z.infer<typeof PrReviewThreadCommentSchema>

/**
 * One inline review conversation on a pull request, as GitHub's GraphQL API
 * reports it — the REST API has no resolved state.
 */
export const PrReviewThreadSchema = z.object({
  id: PrReviewThreadIdSchema,
  path: z.string(),
  /** The line in the current diff; null once the thread is outdated. */
  line: z.number().int().nullable(),
  /** The line the comment was first made on. */
  originalLine: z.number().int().nullable(),
  /** First line of a multi-line comment, when it spans several. */
  startLine: z.number().int().nullable(),
  /** LEFT (the base side) or RIGHT (the head side); '' when GitHub gave none. */
  diffSide: z.string(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  resolvedBy: z.string().nullable(),
  viewerCanResolve: z.boolean(),
  viewerCanUnresolve: z.boolean(),
  viewerCanReply: z.boolean(),
  /** The comments fetched (the first 50), oldest first. */
  comments: z.array(PrReviewThreadCommentSchema),
  /** Every comment in the thread, including any past the first 50. */
  commentCount: z.number().int().min(0)
})
export type PrReviewThread = z.infer<typeof PrReviewThreadSchema>

export const PrReviewThreadsRequestSchema = z.object({
  workspacePath: z.string().min(1),
  number: z.number().int().positive()
})

export const PrReviewThreadsResultSchema = z.object({
  number: z.number().int().positive(),
  threads: z.array(PrReviewThreadSchema),
  /** GitHub's count; more than `threads.length` when the pages ran out. */
  totalCount: z.number().int().min(0),
  truncated: z.boolean()
})
export type PrReviewThreadsResult = z.infer<typeof PrReviewThreadsResultSchema>

export const PrReviewThreadResolveRequestSchema = z.object({
  workspacePath: z.string().min(1),
  threadId: PrReviewThreadIdSchema,
  resolved: z.boolean()
})

export const PrReviewThreadResolveResultSchema = z.object({
  threadId: PrReviewThreadIdSchema,
  isResolved: z.boolean()
})
export type PrReviewThreadResolveResult = z.infer<typeof PrReviewThreadResolveResultSchema>

export const PrReviewThreadReplyRequestSchema = z.object({
  workspacePath: z.string().min(1),
  threadId: PrReviewThreadIdSchema,
  body: z.string().trim().min(1).max(8_000)
})

export const PrReviewThreadReplyResultSchema = z.object({
  comment: PrReviewThreadCommentSchema
})
export type PrReviewThreadReplyResult = z.infer<typeof PrReviewThreadReplyResultSchema>

export const PrListRequestSchema = z.object({
  workspacePath: z.string().min(1)
})

export const PrListItemSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  headRefName: z.string(),
  author: z.string(),
  updatedAt: z.string().nullable(),
  url: z.string().nullable(),
  isDraft: z.boolean()
})
export type PrListItem = z.infer<typeof PrListItemSchema>

export const PrListResultSchema = z.object({
  prs: z.array(PrListItemSchema).max(50)
})
export type PrListResult = z.infer<typeof PrListResultSchema>

export const PrCheckoutRequestSchema = z.object({
  workspacePath: z.string().min(1),
  number: z.number().int().positive()
})

export const PrCheckoutResultSchema = z.object({
  detail: z.string()
})
export type PrCheckoutResult = z.infer<typeof PrCheckoutResultSchema>

/**
 * A check's link (`detailsUrl`), as `gh pr view` reported it. Only a GitHub
 * Actions job link (`…/actions/runs/<run>/job/<job>`) has a log the app can
 * read or a job it can re-run; main parses the ids out of it.
 */
const PrCheckUrlSchema = z.string().trim().min(1).max(2_048)

export const PrCheckLogRequestSchema = z.object({
  workspacePath: z.string().min(1),
  url: PrCheckUrlSchema
})

export const PrCheckLogResultSchema = z.object({
  /** The step that failed (`pnpm typecheck`), when its `Run …` header was in the log. */
  step: z.string().nullable(),
  /** The failing step's lines, timestamps and colour codes removed; '' when the job logged no failure. */
  excerpt: z.string(),
  /** Lines were dropped from the front of the excerpt to keep it readable. */
  truncated: z.boolean(),
  /** Whether a `##[error]` line was found; false means the excerpt is the log's tail. */
  foundError: z.boolean()
})
export type PrCheckLogResult = z.infer<typeof PrCheckLogResultSchema>

export const PrCheckRerunRequestSchema = z.object({
  workspacePath: z.string().min(1),
  url: PrCheckUrlSchema
})

export const PrCheckRerunResultSchema = z.object({
  detail: z.string()
})
export type PrCheckRerunResult = z.infer<typeof PrCheckRerunResultSchema>

export const PrCleanupMergedRequestSchema = z.object({
  workspacePath: z.string().min(1),
  number: z.number().int().positive()
})

export const PrCleanupMergedResultSchema = z.object({
  detail: z.string(),
  /** The base branch now checked out, when the workspace was on the merged branch. */
  switchedTo: z.string().nullable(),
  deletedLocal: z.boolean(),
  deletedRemote: z.boolean()
})
export type PrCleanupMergedResult = z.infer<typeof PrCleanupMergedResultSchema>

export const GithubIssueViewRequestSchema = z.object({
  workspacePath: z.string().min(1),
  number: z.number().int().positive()
})

export const GithubIssueCommentSchema = z.object({
  author: z.string(),
  body: z.string(),
  createdAt: z.string().nullable()
})
export type GithubIssueComment = z.infer<typeof GithubIssueCommentSchema>

export const GithubIssueDetailSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  author: z.string(),
  body: z.string(),
  labels: z.array(z.string()),
  createdAt: z.string().nullable(),
  /** The latest comments, oldest first; `commentCount` counts every one. */
  comments: z.array(GithubIssueCommentSchema),
  commentCount: z.number().int().min(0)
})
export type GithubIssueDetail = z.infer<typeof GithubIssueDetailSchema>

/** GitHub caps an issue or PR comment, and a PR body, at 65,536 characters. */
const GithubTextSchema = z.string().max(65_536)

/** A pull request named by number in an open workspace: Show all comments, leave the merge queue. */
export const PrNumberRequestSchema = z.object({
  workspacePath: z.string().min(1),
  number: z.number().int().positive()
})

export const PrCommentRequestSchema = z.object({
  workspacePath: z.string().min(1),
  number: z.number().int().positive(),
  body: GithubTextSchema.refine((s) => s.trim().length > 0, 'Comment cannot be empty')
})

export const PrCommentResultSchema = z.object({
  detail: z.string(),
  url: z.string().nullable()
})
export type PrCommentResult = z.infer<typeof PrCommentResultSchema>

export const PrEditBodyRequestSchema = z.object({
  workspacePath: z.string().min(1),
  number: z.number().int().positive(),
  body: GithubTextSchema,
  /** The description as it was when editing began: GitHub's copy must still match it. */
  expected: GithubTextSchema
})

export const PrEditBodyResultSchema = z.object({
  body: z.string()
})
export type PrEditBodyResult = z.infer<typeof PrEditBodyResultSchema>

/** A GitHub login, an `org/team` slug, or gh's `@copilot`. */
export const GithubReviewerSchema = z
  .string()
  .trim()
  .regex(/^(?:@copilot|[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9._-]{1,100})?)$/, 'Not a GitHub login or team')

export const PrReviewersRequestSchema = z
  .object({
    workspacePath: z.string().min(1),
    number: z.number().int().positive(),
    add: z.array(GithubReviewerSchema).max(15).default([]),
    remove: z.array(GithubReviewerSchema).max(15).default([])
  })
  .refine((r) => r.add.length + r.remove.length > 0, 'Name a reviewer to add or remove')

export const PrReviewersResultSchema = z.object({
  detail: z.string(),
  /** Who GitHub has review requested from after the change. */
  reviewRequests: z.array(z.string())
})
export type PrReviewersResult = z.infer<typeof PrReviewersResultSchema>

export const PrReviewerSuggestionsRequestSchema = z.object({
  workspacePath: z.string().min(1)
})

export const PrReviewerSuggestionsResultSchema = z.object({
  /** People who can be asked for a review in this repository (at most 100). */
  logins: z.array(z.string())
})
export type PrReviewerSuggestionsResult = z.infer<typeof PrReviewerSuggestionsResultSchema>

export const PrAutoMergeRequestSchema = z.object({
  workspacePath: z.string().min(1),
  number: z.number().int().positive(),
  enable: z.boolean(),
  /** How it merges once it can; only read when enabling. */
  method: PrMergeMethodSchema.optional()
})

export const PrAutoMergeResultSchema = z.object({
  detail: z.string(),
  autoMerge: PrAutoMergeSchema.nullable()
})
export type PrAutoMergeResult = z.infer<typeof PrAutoMergeResultSchema>
