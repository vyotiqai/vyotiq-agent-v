import { z } from 'zod'

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
  draft: z.boolean().optional().default(true)
})

export const PrCreateResultSchema = z.object({
  url: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  draft: z.boolean(),
  detail: z.string().min(1)
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
