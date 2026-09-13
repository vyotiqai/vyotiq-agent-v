import type { ProviderId } from '../ipc'
import { ServiceTierSchema, type ServiceTier } from '../ipc/schemas/providers'

export { ServiceTierSchema, type ServiceTier }

/** Strip OpenRouter-style prefix before heuristics (e.g. openai/gpt-5.6 → gpt-5.6). */
export function normalizeModelIdForHeuristics(id: string): string {
  const slash = id.lastIndexOf('/')
  return slash >= 0 ? id.slice(slash + 1) : id
}

/** Infer supported API service tiers for a model. */
export function inferSupportedServiceTiers(
  id: string,
  providerId?: ProviderId,
  supportedParameters?: string[]
): ServiceTier[] {
  if (Array.isArray(supportedParameters) && supportedParameters.includes('service_tier')) {
    return ['default', 'flex', 'priority']
  }

  const normalized = normalizeModelIdForHeuristics(id).toLowerCase()

  if (providerId === 'openai' || providerId === 'openrouter') {
    if (/^o[34](-|$)|^gpt-5(\.|$|-)/i.test(normalized)) {
      return ['default', 'flex', 'priority']
    }
  }

  return []
}

/** Value to send in API body; omit when default. */
export function serviceTierForApiBody(tier?: ServiceTier | null): ServiceTier | undefined {
  if (!tier || tier === 'default') return undefined
  return tier
}

/**
 * API still sends `service_tier: "priority"`; OpenAI maps that to Fast mode.
 * UI label says Fast so Settings/composer match current product naming.
 */
export const SERVICE_TIER_LABELS: Record<ServiceTier, string> = {
  default: 'Default',
  flex: 'Flex',
  priority: 'Fast'
}

export const SERVICE_TIER_DESCRIPTIONS: Record<ServiceTier, string> = {
  default: 'Standard latency and pricing',
  flex: 'Lower cost, higher latency',
  priority: 'Faster responses (API: priority → Fast mode), about 2× price'
}

export function parseServiceTier(value: unknown): ServiceTier {
  const parsed = ServiceTierSchema.safeParse(value)
  return parsed.success ? parsed.data : 'default'
}
