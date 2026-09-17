import type { ModelInfo, ProviderId, SecretProvider } from '@shared/ipc'
import { isProviderConfigured, providerLabel } from '@shared/providers'
import { findOllamaCatalogModel } from '@shared/reasoning'
import { isModelListUnsupportedWarning, isSeedFallbackWarning } from './composerModelUtils'

export type ModelReadinessIssue =
  | { kind: 'missing_key'; provider: ProviderId; label: string }
  | { kind: 'unreachable'; provider: ProviderId; label: string; detail: string }
  | { kind: 'manual_catalog'; provider: ProviderId; label: string; detail: string }
  | { kind: 'model_missing'; provider: ProviderId; label: string; model: string }

export type ModelReadinessInput = {
  provider: ProviderId
  model: string
  secrets: Record<SecretProvider, boolean>
  ollamaBaseUrl?: string
  customOpenAiBaseUrl?: string
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
 */
export function deriveModelReadiness(input: ModelReadinessInput): ModelReadinessIssue | null {
  const label = providerLabel(input.provider)
  const configured = isProviderConfigured(input.provider, input.secrets, {
    ollamaBaseUrl: input.ollamaBaseUrl,
    customOpenAiBaseUrl: input.customOpenAiBaseUrl
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

  const live = input.liveCatalog
  if (live && live.length > 0 && input.model.trim()) {
    const found =
      input.provider === 'ollama'
        ? findOllamaCatalogModel(live, input.model) != null
        : live.some((m) => m.id === input.model)
    if (!found) {
      return {
        kind: 'model_missing',
        provider: input.provider,
        label,
        model: input.model
      }
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
      return `Add an API key for ${issue.label} before sending.`
    case 'unreachable':
      return `${issue.label} is not ready. Fix the connection before sending.`
    case 'manual_catalog':
      // Non-blocking tip if ever surfaced — send must remain enabled.
      return `${issue.label} has no model list — type a model ID in the picker to continue.`
    case 'model_missing':
      return `Model “${issue.model}” is not available. Choose another model before sending.`
  }
}
