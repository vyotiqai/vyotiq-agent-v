import type { ModelInfo, ProviderId, SecretProvider } from '@shared/ipc'
import { isProviderConfigured, providerLabel } from '@shared/providers'
import { findOllamaCatalogModel } from '@shared/reasoning'
import { isSeedFallbackWarning } from './composerModelUtils'

export type ModelReadinessIssue =
  | { kind: 'missing_key'; provider: ProviderId; label: string }
  | { kind: 'unreachable'; provider: ProviderId; label: string; detail: string }
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

export function modelReadinessSendReason(issue: ModelReadinessIssue): string {
  switch (issue.kind) {
    case 'missing_key':
      return `Add an API key for ${issue.label} before sending.`
    case 'unreachable':
      return `${issue.label} is not ready. Fix the connection before sending.`
    case 'model_missing':
      return `Model “${issue.model}” is not available. Choose another model before sending.`
  }
}
