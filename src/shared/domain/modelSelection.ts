import type { ProviderId, ServiceTier, Settings } from '../ipc'
import {
  DEFAULT_THINKING_EFFORT,
  type ThinkingEffort
} from '../ipc/schemas/providers'

export function modelSelectionKey(provider: ProviderId, model: string): string {
  return `${provider}::${model}`
}

export function resolveServiceTier(
  settings: Pick<Settings, 'serviceTier' | 'serviceTierByModel'>,
  provider: ProviderId,
  model: string
): ServiceTier {
  const key = modelSelectionKey(provider, model)
  return settings.serviceTierByModel[key] ?? settings.serviceTier
}

/**
 * Parse a `provider::model` key back into its parts.
 *
 * The declared provider type stays the builtin `ProviderId` union for wire
 * compat with existing call sites. At runtime dynamic `custom:<slug>` ids
 * round-trip through the same split: slugs cannot contain ':' (see
 * CUSTOM_PROVIDER_SLUG_RE), so the parse stays unambiguous.
 */
export function parseModelSelectionKey(
  key: string
): { provider: ProviderId; model: string } | null {
  if (!key) return null
  const idx = key.indexOf('::')
  if (idx <= 0) return null
  return {
    provider: key.slice(0, idx) as ProviderId,
    model: key.slice(idx + 2)
  }
}

/** MRU recent list: dedupe, newest first, capped. */
export function pushRecentModel(recent: string[], key: string, max = 5): string[] {
  const next = [key, ...recent.filter((k) => k !== key)]
  return next.slice(0, max)
}

export type ThinkingPrefs = {
  thinkingEnabled: boolean
  thinkingEffort: ThinkingEffort
}

export const DEFAULT_THINKING_PREFS: ThinkingPrefs = {
  thinkingEnabled: true,
  thinkingEffort: DEFAULT_THINKING_EFFORT
}
