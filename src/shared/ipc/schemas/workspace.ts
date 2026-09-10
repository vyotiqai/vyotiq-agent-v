import { z } from 'zod'
import {
  AttachmentAudioPartSchema,
  AttachmentFilePartSchema,
  AttachmentNativeFilePartSchema,
  MAX_IMAGE_DATA_URL_CHARS
} from './agent'
import { ProviderIdSchema, ThinkingEffortSchema } from './providers'
import { MarketplaceOverridesSchema } from './marketplace'
import {
  AgentInteractionModeSchema,
  ResponseVerbositySchema,
  ToolApprovalSettingsSchema
} from './settings'

/** Per-run expansion state for chat cards (tool / group / thinking / turns). */
export const RunExpansionsSchema = z.object({
  toolIds: z.array(z.string()).max(200).default([]),
  groupIds: z.array(z.string()).max(200).default([]),
  thinkingIds: z.array(z.string()).max(200).default([]),
  collapsedTurns: z.array(z.number().int()).max(200).default([])
})
export type RunExpansions = z.infer<typeof RunExpansionsSchema>

export const WorkspaceUiStateSchema = z.object({
  activeRunId: z.string().nullable(),
  openRunIds: z.array(z.string()),
  scrollTop: z.number(),
  scrollTopByRunId: z.record(z.string(), z.number()).default({}),
  composerDraft: z.string(),
  composerDraftByRunId: z.record(z.string(), z.string()).default({}),
  /** Per-workspace composer Ask / Plan / Agent mode. */
  agentMode: AgentInteractionModeSchema.default('agent'),
  /** Whether this workspace's group is expanded in the sidebar (persisted). */
  expanded: z.boolean().optional(),
  /**
   * Monotonic client write generation. Main ignores updates with a lower
   * generation than the last accepted write for that path (out-of-order IPC).
   */
  writeGeneration: z.number().int().nonnegative().optional(),
  /**
   * Renderer boot epoch. A changed epoch means the renderer reloaded and its
   * generation counter restarted — main must re-seed the stale-write guard
   * instead of silently dropping every write until the counter catches up.
   */
  writeEpoch: z.string().optional(),
  /** Persisted expansion state per run (tool/group/thinking cards, collapsed turns). */
  expansionsByRunId: z.record(z.string(), RunExpansionsSchema).default({})
})
export type WorkspaceUiState = z.infer<typeof WorkspaceUiStateSchema>

/** Max pending attachments of one kind per run bucket (renderer store parity). */
export const COMPOSER_ATTACHMENT_BUCKET_LIMIT = 24
/** Per-workspace cap on persisted run buckets; oldest savedAt is evicted. */
export const COMPOSER_ATTACHMENT_MAX_BUCKETS = 200

/** One run's (or the new-chat draft's) pending attachment bucket. */
export const ComposerAttachmentsBucketSchema = z.object({
  images: z
    .array(z.string().min(1).max(MAX_IMAGE_DATA_URL_CHARS))
    .max(COMPOSER_ATTACHMENT_BUCKET_LIMIT)
    .default([]),
  files: z.array(AttachmentFilePartSchema).max(COMPOSER_ATTACHMENT_BUCKET_LIMIT).default([]),
  nativeFiles: z
    .array(AttachmentNativeFilePartSchema)
    .max(COMPOSER_ATTACHMENT_BUCKET_LIMIT)
    .default([]),
  audio: z.array(AttachmentAudioPartSchema).max(COMPOSER_ATTACHMENT_BUCKET_LIMIT).default([])
})
export type ComposerAttachmentsBucket = z.infer<typeof ComposerAttachmentsBucketSchema>

export const ComposerAttachmentsGetRequestSchema = z.object({
  workspacePath: z.string().min(1)
})
export type ComposerAttachmentsGetRequest = z.infer<typeof ComposerAttachmentsGetRequestSchema>

/** Whole-workspace read used to seed the renderer store when a workspace opens. */
export const ComposerAttachmentsGetResultSchema = z.object({
  buckets: z.record(z.string(), ComposerAttachmentsBucketSchema).default({})
})
export type ComposerAttachmentsGetResult = z.infer<typeof ComposerAttachmentsGetResultSchema>

export const ComposerAttachmentsSetRequestSchema = z.object({
  workspacePath: z.string().min(1),
  /** Whole-workspace replace from the renderer's in-memory view (debounced). */
  buckets: z.record(z.string(), ComposerAttachmentsBucketSchema).default({})
})
export type ComposerAttachmentsSetRequest = z.infer<typeof ComposerAttachmentsSetRequestSchema>

export const ComposerAttachmentsClearRequestSchema = z.object({
  workspacePath: z.string().min(1),
  key: z.string().min(1).max(700)
})
export type ComposerAttachmentsClearRequest = z.infer<typeof ComposerAttachmentsClearRequestSchema>

export const WorkspaceSettingsOverrideSchema = z.object({
  provider: ProviderIdSchema.optional(),
  model: z.string().min(1).optional(),
  customOpenAiBaseUrl: z.string().min(1).optional(),
  keepRecentTurns: z.number().int().min(4).max(50).optional(),
  autoCompactThresholdRatio: z.number().min(0.05).max(0.95).optional(),
  thinkingEnabled: z.boolean().optional(),
  thinkingEffort: ThinkingEffortSchema.optional(),
  showThinking: z.boolean().optional(),
  /** Assistant identity override; empty/undefined = global setting. */
  agentPersona: z.string().max(1000).optional(),
  /** Tone directive override; empty/undefined = global setting. */
  agentTone: z.string().max(2000).optional(),
  /** Preferred response language override; undefined = global setting. */
  responseLanguage: z.string().max(64).optional(),
  /** Default answer length override; undefined = global setting. */
  responseVerbosity: ResponseVerbositySchema.optional(),
  toolApproval: ToolApprovalSettingsSchema.optional(),
  /** Per-id enable overrides for marketplace MCP / skills / plugins. */
  marketplaceOverrides: MarketplaceOverridesSchema.optional(),
  useOverride: z.boolean()
})
export type WorkspaceSettingsOverride = z.infer<typeof WorkspaceSettingsOverrideSchema>

export const WorkspacesStateSchema = z.object({
  version: z.literal(2),
  workspaceIdsByPath: z.record(z.string(), z.string()).optional(),
  legacySessionsMigrated: z.boolean(),
  needsWorkspaceForMigration: z.boolean().optional(),
  pendingMigrationCount: z.number().int().nonnegative().optional(),
  openPaths: z.array(z.string()),
  activePath: z.string().nullable(),
  recentPaths: z.array(z.string()),
  uiStateByPath: z.record(z.string(), WorkspaceUiStateSchema),
  settingsOverridesByPath: z.record(z.string(), WorkspaceSettingsOverrideSchema)
})
export type WorkspacesState = z.infer<typeof WorkspacesStateSchema>

export const WorkspacesAddRequestSchema = z.object({
  path: z.string().min(1).optional()
})
export type WorkspacesAddRequest = z.infer<typeof WorkspacesAddRequestSchema>

export const WorkspacesRemoveRequestSchema = z.object({
  path: z.string().min(1),
  stopActiveRuns: z.boolean().optional().default(false),
  /**
   * Storage retention (audit H5): also delete this workspace's userData
   * storage dir (sessions, checkpoints, indexes). The renderer confirms
   * with the measured size BEFORE calling remove — main never prompts.
   */
  deleteStorage: z.boolean().optional().default(false)
})
export type WorkspacesRemoveRequest = z.infer<typeof WorkspacesRemoveRequestSchema>

export const WorkspacesSetActiveRequestSchema = z.object({
  path: z.string().min(1)
})
export type WorkspacesSetActiveRequest = z.infer<typeof WorkspacesSetActiveRequestSchema>

export const WorkspacesUpdateUiStateRequestSchema = z.object({
  path: z.string().min(1),
  ui: WorkspaceUiStateSchema
})
export type WorkspacesUpdateUiStateRequest = z.infer<typeof WorkspacesUpdateUiStateRequestSchema>

export const WorkspacesSetSettingsOverrideRequestSchema = z.object({
  path: z.string().min(1),
  override: WorkspaceSettingsOverrideSchema.nullable()
})
export type WorkspacesSetSettingsOverrideRequest = z.infer<
  typeof WorkspacesSetSettingsOverrideRequestSchema
>
