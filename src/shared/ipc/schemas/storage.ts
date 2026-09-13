import { z } from 'zod'

/**
 * Storage retention IPC (audit H4/H5). Report + confirm-gated cleanup actions.
 * Policy numbers live in SettingsSchema.storage; this file only carries the
 * report shape and the retention action requests/results.
 */

/** Category rollup of one managed storage surface under userData. */
export const StorageReportCategorySchema = z.object({
  /** Stable machine id: checkpoints, transcripts, worktrees, traces, … */
  id: z.string().min(1),
  /** Human label shown in Settings → Storage. */
  label: z.string().min(1),
  /** Measured bytes on disk (live scan — never cached/faked). */
  bytes: z.number().int().nonnegative(),
  /** File count measured for the category. */
  files: z.number().int().nonnegative(),
  /** True when this category is report-only (§6.3: models, caches, memory). */
  managed: z.boolean()
})
export type StorageReportCategory = z.infer<typeof StorageReportCategorySchema>

/** One workspace's storage dir under `userData\workspaces\{id}`. */
export const StorageReportWorkspaceSchema = z.object({
  workspaceId: z.string().min(1),
  /** Tracked path from workspaces.json; null for untracked (orphan) dirs. */
  path: z.string().nullable(),
  displayName: z.string().nullable(),
  bytes: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
  /** True when the id is referenced by workspaces.json (never auto-reapable). */
  tracked: z.boolean(),
  /** Idle days since the dir's last write (floor; 0 = touched today). */
  idleDays: z.number().int().nonnegative(),
  /**
   * True when the dir holds only derived index caches (no sessions/meta) —
   * a storage id minted for an instance worktree path. Such dirs skip the
   * orphan grace window: nothing user-authored can be lost.
   */
  derivedOnly: z.boolean().optional(),
  /** True when orphan settings would consider it after the grace window. */
  reapable: z.boolean()
})
export type StorageReportWorkspace = z.infer<typeof StorageReportWorkspaceSchema>

export const StorageReportRequestSchema = z.object({})
export type StorageReportRequest = z.infer<typeof StorageReportRequestSchema>

export const StorageReportResultSchema = z.object({
  /** All categories: checkpoints, transcripts, per-workspace indexes, worktrees, traces, logs, models, partitions, cache. */
  categories: z.array(StorageReportCategorySchema),
  /** Per-storage-dir rollup — untracked dirs are the orphan-reaper surface. */
  workspaces: z.array(StorageReportWorkspaceSchema),
  /** Sum of all category bytes (managed + report-only). */
  totalBytes: z.number().int().nonnegative(),
  /** Managed subset the size cap applies to (categories + tracked workspaces minus report-only models). */
  managedBytes: z.number().int().nonnegative(),
  /** Current size cap from settings (bytes). */
  sizeCapBytes: z.number().int().nonnegative(),
  /** True when the managed set exceeds the cap. */
  overCap: z.boolean()
})
export type StorageReportResult = z.infer<typeof StorageReportResultSchema>

/** Reclaim preview for the "Free up space" flow — computed, never deleted yet. */
export const StorageCleanupPreviewRequestSchema = z.object({})
export type StorageCleanupPreviewRequest = z.infer<typeof StorageCleanupPreviewRequestSchema>

export const StorageCleanupPreviewCategorySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Bytes the sweep would reclaim for this category (24 h protected window applied). */
  reclaimBytes: z.number().int().nonnegative(),
  /** Item count the sweep would remove. */
  items: z.number().int().nonnegative()
})
export type StorageCleanupPreviewCategory = z.infer<typeof StorageCleanupPreviewCategorySchema>

/**
 * Confirmation token minted by the preview: the run request must echo it
 * back. Tokens are single-use and expire after 10 minutes.
 */
export const StorageCleanupTokenSchema = z.object({
  token: z.string().min(1),
  /** ISO timestamp when the token was minted. */
  mintedAt: z.string().min(1)
})
export type StorageCleanupToken = z.infer<typeof StorageCleanupTokenSchema>

export const StorageCleanupPreviewResultSchema = z.object({
  categories: z.array(StorageCleanupPreviewCategorySchema),
  totalReclaimBytes: z.number().int().nonnegative(),
  /** Orphan dirs the sweep would delete (respecting grace + tracked exclusion). */
  orphanDirs: z.array(StorageReportWorkspaceSchema),
  /** Echo for the confirm step. */
  confirm: StorageCleanupTokenSchema
})
export type StorageCleanupPreviewResult = z.infer<typeof StorageCleanupPreviewResultSchema>

/** Run the confirmed sweep. `confirmToken` must match the preview's minted token. */
export const StorageCleanupRunRequestSchema = z.object({
  confirmToken: z.string().min(1)
})
export type StorageCleanupRunRequest = z.infer<typeof StorageCleanupRunRequestSchema>

export const StorageCleanupRunResultSchema = z.object({
  /** Per-category reclaimed bytes actually freed (result summary). */
  categories: z.array(StorageCleanupPreviewCategorySchema),
  totalReclaimedBytes: z.number().int().nonnegative(),
  /** Dirs removed from disk (checkpoint dirs, session dirs, orphan dirs). */
  removedDirs: z.number().int().nonnegative(),
  /** Failures skipped and logged (never run-fatal). */
  skipped: z.number().int().nonnegative()
})
export type StorageCleanupRunResult = z.infer<typeof StorageCleanupRunResultSchema>

/** One-time ack that the user has seen Settings → Storage (§8.1). */
export const StorageSurfaceAckRequestSchema = z.object({
  acked: z.boolean()
})
export type StorageSurfaceAckRequest = z.infer<typeof StorageSurfaceAckRequestSchema>
