import { z } from 'zod'

/**
 * Per-workspace run feedback store — `workspaces/{id}/runFeedback.json`.
 *
 * Distinct from `schemas/feedback.ts`, which is the app-level bug-report
 * mailto. This one remembers how runs in a workspace actually went, so later
 * runs (and the user) can see recurring trouble that a single run's
 * `receipt.json` cannot show: receipts are per-run, overwritten in place, and
 * pruned with their session directory.
 */

export const RUN_FEEDBACK_VERSION = 1 as const

/** Newest-first retention cap. Bounds both file size and read cost. */
export const RUN_FEEDBACK_MAX_ENTRIES = 40
/**
 * Slots reserved for the newest entries, which pruning may never give away.
 * Without this floor a workspace whose entries are all rated would refuse
 * every new run and freeze its own failure picture. Must stay below
 * `RUN_FEEDBACK_MAX_ENTRIES`; the remainder is the rated-entry reserve.
 */
export const RUN_FEEDBACK_RECENT_SLOTS = 24
export const RUN_FEEDBACK_NOTE_MAX = 500
/** Failure clusters kept per entry — enough to spot a repeat, not a log dump. */
export const RUN_FEEDBACK_CLUSTERS_PER_ENTRY = 3

export const RunFeedbackRatingSchema = z.enum(['up', 'down'])
export type RunFeedbackRating = z.infer<typeof RunFeedbackRatingSchema>

export const RunFeedbackEntrySchema = z.object({
  runId: z.string().min(1),
  /** Run end time — the ordering and pruning key. */
  at: z.string().min(1),
  /** Only terminal outcomes are recorded; a cancel is the user's choice, not a signal. */
  status: z.enum(['done', 'error']),
  /** Run title, for identifying the entry in the UI. */
  title: z.string().max(160).optional(),
  /** Files changed with no passing check after them (the verification gate verdict). */
  unchecked: z.boolean().optional(),
  failureClusters: z
    .array(z.object({ key: z.string().max(200), count: z.number().int().min(1) }))
    .max(RUN_FEEDBACK_CLUSTERS_PER_ENTRY),
  /** User verdict. Scarce signal — pruning favours it past the recency floor. */
  rating: RunFeedbackRatingSchema.optional(),
  note: z.string().max(RUN_FEEDBACK_NOTE_MAX).optional(),
  ratedAt: z.string().optional()
})
export type RunFeedbackEntry = z.infer<typeof RunFeedbackEntrySchema>

export const RunFeedbackStoreSchema = z.object({
  version: z.literal(RUN_FEEDBACK_VERSION),
  updatedAt: z.string().min(1),
  entries: z.array(RunFeedbackEntrySchema).max(RUN_FEEDBACK_MAX_ENTRIES)
})
export type RunFeedbackStore = z.infer<typeof RunFeedbackStoreSchema>

export const RunFeedbackGetRequestSchema = z.object({
  workspacePath: z.string().min(1),
  runId: z.string().min(1)
})
export type RunFeedbackGetRequest = z.infer<typeof RunFeedbackGetRequestSchema>

export const RunFeedbackGetResultSchema = z.object({
  entry: RunFeedbackEntrySchema.nullable()
})
export type RunFeedbackGetResult = z.infer<typeof RunFeedbackGetResultSchema>

export const RunFeedbackSetRequestSchema = z.object({
  workspacePath: z.string().min(1),
  runId: z.string().min(1),
  /** null clears an existing rating. */
  rating: RunFeedbackRatingSchema.nullable(),
  note: z.string().max(RUN_FEEDBACK_NOTE_MAX).optional()
})
export type RunFeedbackSetRequest = z.infer<typeof RunFeedbackSetRequestSchema>

export const RunFeedbackSetResultSchema = z.object({
  entry: RunFeedbackEntrySchema
})
export type RunFeedbackSetResult = z.infer<typeof RunFeedbackSetResultSchema>
