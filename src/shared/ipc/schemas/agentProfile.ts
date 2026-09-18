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

/** Push payload: full-list replace (rosters are small; avoids client-side diffing). */
export const AgentProfilesChangedEventSchema = z.object({
  profiles: z.array(AgentProfileSchema)
})
export type AgentProfilesChangedEvent = z.infer<typeof AgentProfilesChangedEventSchema>
