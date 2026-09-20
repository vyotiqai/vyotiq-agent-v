import { z } from 'zod'
import { ProviderIdSchema } from './providers'

/**
 * Persistent teammate profile — the identity primitive that turns chats into
 * agents. Profiles are defined once (global roster or a workspace-local copy)
 * and referenced by runs; each (workspace, profile) pair gets its own memory
 * namespace so teammates never share a brain across projects.
 */
export const AgentProfileIdSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
    'id must be a filesystem-safe slug (letters, digits, dash, underscore)'
  )
export type AgentProfileId = z.infer<typeof AgentProfileIdSchema>

export const AgentProfileScopeSchema = z.enum(['global', 'workspace'])
export type AgentProfileScope = z.infer<typeof AgentProfileScopeSchema>

export const AgentProfileRuntimeSchema = z.enum(['local', 'cloud'])
export type AgentProfileRuntime = z.infer<typeof AgentProfileRuntimeSchema>

/** Per-field limits mirror the persona fields in settings.ts. */
export const AgentProfileModelSchema = z.object({
  provider: ProviderIdSchema,
  model: z.string().min(1).max(200)
})

export const AgentProfileBaseSchema = z.object({
  id: AgentProfileIdSchema,
  name: z.string().min(1).max(64),
  /** Icon key from the renderer icon set (avatar chip). */
  avatar: z.string().max(32).optional(),
  persona: z.string().max(1000).optional(),
  tone: z.string().max(2000).optional(),
  identity: z.string().max(1000).optional(),
  /** Session-pinned provider/model for every run bound to this profile. */
  model: AgentProfileModelSchema.optional(),
  autonomousMode: z.enum(['inherit', 'on', 'off']).optional(),
  scope: AgentProfileScopeSchema,
  /** Required when scope === 'workspace' — the project this profile serves. */
  workspacePath: z.string().min(1).optional(),
  /** Phase 3: relaunch this profile's latest active/goal runs at boot. */
  autoResumeOnLaunch: z.boolean().optional(),
  /** Phase 4: execution substrate for runs bound to this profile. */
  runtime: AgentProfileRuntimeSchema.optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
})

function refineProfileScope(
  profile: { scope: AgentProfileScope; workspacePath?: string | undefined },
  ctx: z.RefinementCtx
): void {
  if (profile.scope === 'workspace' && !profile.workspacePath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['workspacePath'],
      message: 'workspace profiles require workspacePath'
    })
  }
}

export const AgentProfileSchema = AgentProfileBaseSchema.superRefine(refineProfileScope)
export type AgentProfile = z.infer<typeof AgentProfileSchema>

export const AgentProfileSnapshotSchema = AgentProfileBaseSchema.omit({
  createdAt: true,
  updatedAt: true
})
  .extend({ version: z.literal(1), runtime: AgentProfileRuntimeSchema })
  .superRefine(refineProfileScope)
export type AgentProfileSnapshot = z.infer<typeof AgentProfileSnapshotSchema>

export const AgentProfileCreateRequestSchema = AgentProfileBaseSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .superRefine(refineProfileScope)
export type AgentProfileCreateRequest = z.infer<typeof AgentProfileCreateRequestSchema>

export const AgentProfileUpdateRequestSchema = z.object({
  id: AgentProfileIdSchema,
  patch: AgentProfileBaseSchema.omit({ id: true, createdAt: true }).partial()
})
export type AgentProfileUpdateRequest = z.infer<typeof AgentProfileUpdateRequestSchema>

export const AgentProfileDeleteRequestSchema = z.object({ id: AgentProfileIdSchema })
export type AgentProfileDeleteRequest = z.infer<typeof AgentProfileDeleteRequestSchema>

/**
 * Outcome of deleting a teammate. Deletion touches several stores (tasks, live
 * runs, per-workspace overrides), so a bare `true` would report success after
 * swallowing a failed cleanup. `warnings` names what could not be finished; the
 * roster entry is gone in every case where `deleted` is true.
 */
export const AgentProfileDeleteResultSchema = z.object({
  deleted: z.literal(true),
  cancelledTasks: z.number().int().min(0),
  cancelledRuns: z.number().int().min(0),
  warnings: z.array(z.string())
})
export type AgentProfileDeleteResult = z.infer<typeof AgentProfileDeleteResultSchema>

/**
 * Fields a workspace may override on a global profile.
 *
 * A `pick`, deliberately not an `omit`: identity and ownership — `id`, `name`,
 * timestamps, `scope`, `workspacePath` — stay global-owned, and picking means
 * a field added to the base schema later is not silently made
 * workspace-writable by default.
 */
export const AgentProfileOverrideSchema = AgentProfileBaseSchema.pick({
  avatar: true,
  persona: true,
  tone: true,
  identity: true,
  model: true,
  autonomousMode: true,
  autoResumeOnLaunch: true,
  runtime: true
}).partial()
export type AgentProfileOverride = z.infer<typeof AgentProfileOverrideSchema>

export const AgentProfileOverridesListRequestSchema = z.object({
  workspacePath: z.string().min(1)
})
export type AgentProfileOverridesListRequest = z.infer<
  typeof AgentProfileOverridesListRequestSchema
>

/**
 * Write or clear one workspace's override of one profile.
 *
 * `null` deletes the file — there is no separate clear channel, matching
 * `workspacesSetSettingsOverride`. Unlike that one this REPLACES rather than
 * merges: a single form owns the whole override, and merging would make
 * clearing one field impossible.
 *
 * `.strict()` where the reader is lenient. The reader parses a hand-authored,
 * git-shared file and tolerating a stray key there is correct; this parses a
 * payload the app itself just built, so an unexpected key is our own bug and
 * should fail loudly rather than be stripped in silence.
 */
export const AgentProfileOverrideSetRequestSchema = z.object({
  workspacePath: z.string().min(1),
  profileId: AgentProfileIdSchema,
  override: AgentProfileOverrideSchema.strict().nullable()
})
export type AgentProfileOverrideSetRequest = z.infer<typeof AgentProfileOverrideSetRequestSchema>

/** Every override stored in one workspace, keyed by profile id. */
export const AgentProfileOverridesResultSchema = z.object({
  workspacePath: z.string().min(1),
  overrides: z.record(AgentProfileIdSchema, AgentProfileOverrideSchema)
})
export type AgentProfileOverridesResult = z.infer<typeof AgentProfileOverridesResultSchema>

/**
 * Push payload: one workspace's overrides, replaced wholesale.
 *
 * Separate from `agentProfilesChanged` because that event carries the global
 * roster and has no workspace key, so it cannot say which workspace's
 * overrides moved — reusing it would tell the renderer nothing.
 */
export const AgentProfileOverridesChangedEventSchema = AgentProfileOverridesResultSchema
export type AgentProfileOverridesChangedEvent = z.infer<
  typeof AgentProfileOverridesChangedEventSchema
>

/** Push payload: full-list replace (rosters are small; avoids client-side diffing). */
export const AgentProfilesChangedEventSchema = z.object({
  profiles: z.array(AgentProfileSchema)
})
export type AgentProfilesChangedEvent = z.infer<typeof AgentProfilesChangedEventSchema>
