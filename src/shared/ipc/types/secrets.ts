import { z } from 'zod'
import {
  CustomProviderIdSchema,
  ProviderIdSchema,
  type ProviderId
} from '../schemas/providers'

/**
 * Every provider may store an API key (Ollama optional locally; required for
 * ollama.com). Dynamic `custom:<slug>` provider ids are accepted too; the
 * builtin tuple in SECRET_PROVIDERS stays unchanged for wire compat.
 */
export type SecretProvider = ProviderId | `custom:${string}`
export const SecretProviderSchema = z.union([
  ProviderIdSchema,
  CustomProviderIdSchema
])

export const SECRET_PROVIDERS = ProviderIdSchema.options as [
  SecretProvider,
  ...SecretProvider[]
]

export function emptySecretStatus(): Record<SecretProvider, boolean> {
  return Object.fromEntries(SECRET_PROVIDERS.map((p) => [p, false])) as Record<
    SecretProvider,
    boolean
  >
}

export function secretStatusFromKeys(
  keys: Iterable<string>
): Record<SecretProvider, boolean> {
  const set = new Set(keys)
  return Object.fromEntries(SECRET_PROVIDERS.map((p) => [p, set.has(p)])) as Record<
    SecretProvider,
    boolean
  >
}

export type SecretsStatus = {
  encryptionAvailable: boolean
  keys: Record<SecretProvider, boolean>
  /** True when secrets.json exists but could not be parsed. */
  loadError?: boolean
}

export function emptySecretsStatus(encryptionAvailable = true): SecretsStatus {
  return { encryptionAvailable, keys: emptySecretStatus() }
}

export const SetSecretRequestSchema = z.object({
  provider: SecretProviderSchema,
  key: z.string().trim().min(1, 'API key cannot be empty')
})

export const ClearSecretRequestSchema = z.object({
  provider: SecretProviderSchema
})

/** Keys for services tools use that are not model providers (web_search's APIs). */
/** Keys for tools and the app itself: web_search's engines, and the manual proxy's password. */
export const ToolSecretNameSchema = z.enum(['brave', 'tavily', 'proxy', 'notify'])
export type ToolSecretName = z.infer<typeof ToolSecretNameSchema>
export type ToolSecretStatus = Record<ToolSecretName, boolean>

export const SetToolSecretRequestSchema = z.object({
  name: ToolSecretNameSchema,
  key: z.string().trim().min(1, 'The key cannot be empty').max(2000)
})
export const ClearToolSecretRequestSchema = z.object({ name: ToolSecretNameSchema })
