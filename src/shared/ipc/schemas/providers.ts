import { z } from 'zod'

export const ProviderIdSchema = z.enum([
  'openai',
  'anthropic',
  'gemini',
  'ollama',
  'deepseek',
  'groq',
  'openrouter',
  'xai',
  'mistral',
  'custom',
  'opencode'
])
export type ProviderId = z.infer<typeof ProviderIdSchema>

/**
 * Slug part of a dynamic custom-provider id (`custom:<slug>`). Lowercase
 * alphanumeric + hyphens, 1-40 chars, no ':' — slugs cannot contain ':' so
 * `modelSelectionKey`'s `provider::model` separator stays unambiguous.
 */
export const CUSTOM_PROVIDER_SLUG_RE = /^[a-z0-9-]{1,40}$/
export const CUSTOM_PROVIDER_ID_PREFIX = 'custom:'

/** Parse the slug out of a `custom:<slug>` id, or null when it is not one. */
export function customProviderSlug(id: string): string | null {
  if (!id || !id.startsWith(CUSTOM_PROVIDER_ID_PREFIX)) return null
  const slug = id.slice(CUSTOM_PROVIDER_ID_PREFIX.length)
  return CUSTOM_PROVIDER_SLUG_RE.test(slug) ? slug : null
}

/** Dynamic custom-provider id: `custom:<slug>` with a validated slug. */
export type CustomProviderId = `custom:${string}`
export const CustomProviderIdSchema = z
  .string()
  .refine((id) => customProviderSlug(id) !== null, {
    message:
      'must be `custom:<slug>` with a lowercase [a-z0-9-]{1,40} slug and no additional ":"'
  })
  .transform((id) => id as CustomProviderId)

/** Any provider id: a builtin catalog id or a dynamic `custom:<slug>` id. */
export type ProviderIdAny = ProviderId | CustomProviderId

/**
 * Wire schema accepting any provider id (builtin enum + dynamic custom ids).
 * `ProviderIdSchema` is kept unchanged for wire compat with existing payloads.
 */
export const ProviderIdSchemaAny = z.union([ProviderIdSchema, CustomProviderIdSchema])

export function isCustomProviderId(id: string): id is CustomProviderId {
  return customProviderSlug(id) !== null
}

/** Build a dynamic custom-provider id from a slug (parse sites validate it). */
export function customProviderId(slug: string): CustomProviderId {
  return `custom:${slug}`
}

export const InputModalitySchema = z.enum(['text', 'image', 'audio', 'file'])
export const OutputModalitySchema = z.enum(['text', 'image'])

export const ThinkingApiSchema = z.enum([
  'responses',
  'interactions',
  'messages',
  'chat_completions'
])
export type ThinkingApi = z.infer<typeof ThinkingApiSchema>

/** Single source of truth for product thinking effort levels. */
export const ThinkingEffortSchema = z.enum([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])
export type ThinkingEffort = z.infer<typeof ThinkingEffortSchema>

/** Fresh-install default effort: laser-focused runs (used where no per-model ladder applies). */
export const DEFAULT_THINKING_EFFORT: ThinkingEffort = 'low'
/**
 * Top-level effort value written by the previous format version's seed.
 * The settings loader rewrites exactly this value to the new default on
 * version-stamp upgrade; any other stored effort is a deliberate choice
 * and is left untouched.
 */
export const LEGACY_THINKING_EFFORT: ThinkingEffort = 'medium'

export const ThinkingModeSchema = z.enum(['adaptive', 'manual', 'effort', 'boolean'])
export type ThinkingMode = z.infer<typeof ThinkingModeSchema>

export const ServiceTierSchema = z.enum(['default', 'flex', 'priority'])
export type ServiceTier = z.infer<typeof ServiceTierSchema>

export const ModelInfoSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  inputModalities: z.array(InputModalitySchema),
  outputModalities: z.array(OutputModalitySchema),
  supportsTools: z.boolean(),
  supportsVision: z.boolean(),
  supportsStructuredOutput: z.boolean().optional(),
  supportsThinking: z.boolean().optional(),
  thinkingApi: ThinkingApiSchema.optional(),
  /** Catalog-backed allowed effort levels (excludes Off). */
  supportedThinkingEfforts: z.array(ThinkingEffortSchema).optional(),
  /** False when the model rejects disable / effort none (e.g. mandatory reasoning). */
  thinkingCanDisable: z.boolean().optional(),
  thinkingDefaultEffort: ThinkingEffortSchema.optional(),
  thinkingSupportsTokenBudget: z.boolean().optional(),
  thinkingMode: ThinkingModeSchema.optional(),
  supportedServiceTiers: z.array(ServiceTierSchema).optional(),
  /** True for bundled offline seed models whose IDs are illustrative placeholders. */
  isPlaceholder: z.boolean().optional()
})
export type ModelInfo = z.infer<typeof ModelInfoSchema>

export const ListModelsRequestSchema = z.object({
  provider: ProviderIdSchema,
  baseUrl: z.string().optional(),
  forceRefresh: z.boolean().optional(),
  /** Selected model id — Ollama may `/api/show` this one for thinking caps. */
  model: z.string().optional()
})
export type ListModelsRequest = z.infer<typeof ListModelsRequestSchema>

export const ListModelsResultSchema = z.object({
  models: z.array(ModelInfoSchema),
  warning: z.string().optional()
})
export type ListModelsResult = z.infer<typeof ListModelsResultSchema>
