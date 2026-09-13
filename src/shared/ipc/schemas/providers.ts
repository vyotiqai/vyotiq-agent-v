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
