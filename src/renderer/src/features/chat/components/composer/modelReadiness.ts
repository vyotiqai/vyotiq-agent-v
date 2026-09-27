import {
  isCustomProviderId,
  type CustomProvider,
  type ModelInfo,
  type ProviderIdAny,
  type SecretProvider
} from '@shared/ipc'
import { isProviderConfigured, providerLabel } from '@shared/providers'
import { isModelListUnsupportedWarning, isSeedFallbackWarning } from './composerModelUtils'

export type ModelReadinessIssue =
  | { kind: 'missing_key'; provider: ProviderIdAny; label: string }
  | { kind: 'removed_endpoint'; provider: ProviderIdAny; label: string }
  | { kind: 'unreachable'; provider: ProviderIdAny; label: string; detail: string }
  | { kind: 'manual_catalog'; provider: ProviderIdAny; label: string; detail: string }

export type ModelReadinessInput = {
  provider: ProviderIdAny
  model: string
  secrets: Record<SecretProvider, boolean>
  ollamaBaseUrl?: string
  customOpenAiBaseUrl?: string
  /** Saved custom endpoints: labels, and whether a `custom:<slug>` id still exists. */
  customProviders?: readonly CustomProvider[]
  /** Active-provider catalog warning from listModels / cache. */
  catalogWarning: string | null | undefined
  /**
   * Live installed/listed models for the active provider.
   * Null/empty means no usable live catalog (still loading, seed fallback, or failed).
   */
  liveCatalog: ModelInfo[] | null | undefined
  catalogLoading: boolean
}

/**
 * Derive whether the active provider/model can accept a chat send.
 * Returns null when ready (or still doing the first catalog load with no error yet).
 * `manual_catalog` is advisory only — Composer must not block send for it.
 *
 * Catalog membership is intentionally NOT validated here: hosted catalogs omit
 * servable models (e.g. OpenRouter stealth ids like `stealth/union-alpha` are
 * routed but unlisted), so the catalog is a picker aid, not a send validator.
 * A wrong model id fails at send time and surfaces via the chat error banner.
 */
export function deriveModelReadiness(input: ModelReadinessInput): ModelReadinessIssue | null {
  const label = providerLabel(input.provider, input.customProviders)
  if (
    isCustomProviderId(input.provider) &&
    !input.customProviders?.some((entry) => entry.id === input.provider)
  ) {
    return { kind: 'removed_endpoint', provider: input.provider, label }
  }
  const configured = isProviderConfigured(input.provider, input.secrets, {
    ollamaBaseUrl: input.ollamaBaseUrl,
    customOpenAiBaseUrl: input.customOpenAiBaseUrl,
    customProviders: input.customProviders
  })

  if (!configured) {
    return { kind: 'missing_key', provider: input.provider, label }
  }

  // Avoid a first-paint flash before the initial catalog fetch settles.
  if (input.catalogLoading && !input.catalogWarning && !input.liveCatalog?.length) {
    return null
  }

  // Reachable host without a model-list route (HTTP 405/501): chat still works.
  // Classify before the generic seed-fallback → unreachable branch — the 405
  // warning intentionally includes "not live models" for picker placeholders.
  if (isModelListUnsupportedWarning(input.catalogWarning)) {
    return {
      kind: 'manual_catalog',
      provider: input.provider,
      label,
      detail: input.catalogWarning!.trim()
    }
  }

  if (isSeedFallbackWarning(input.catalogWarning)) {
    return {
      kind: 'unreachable',
      provider: input.provider,
      label,
      detail: input.catalogWarning!.trim() || `${label} is not reachable.`
    }
  }

  if (input.catalogWarning && !input.liveCatalog?.length) {
    return {
      kind: 'unreachable',
      provider: input.provider,
      label,
      detail: input.catalogWarning.trim()
    }
  }

  return null
}

/** True when the readiness issue should disable the send button. */
export function modelReadinessBlocksSend(issue: ModelReadinessIssue | null | undefined): boolean {
  if (!issue) return false
  return issue.kind !== 'manual_catalog'
}

export function modelReadinessSendReason(issue: ModelReadinessIssue): string {
  switch (issue.kind) {
    case 'missing_key':
      return `Add an API key for ${issue.label} before starting.`
    case 'removed_endpoint':
      return 'This task’s custom endpoint was removed. Pick another model before starting.'
    case 'unreachable':
      return `${issue.label} is not ready. Fix the connection before starting.`
    case 'manual_catalog':
      // Non-blocking tip if ever surfaced — send must remain enabled.
      return `${issue.label} has no model list — type a model ID in the picker to continue.`
  }
}
