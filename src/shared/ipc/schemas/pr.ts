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
  mergeStateStatus: z.string().default('')
})
export type PrView = z.infer<typeof PrViewSchema>

export const PrViewRequestSchema = z.object({
  workspacePath: z.string().min(1)
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
