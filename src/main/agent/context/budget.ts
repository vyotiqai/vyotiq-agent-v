import type { ModelInfo, ProviderId } from '../../../shared/ipc'
import { resolveModelContextWindow } from '../../../shared/domain/modelContextWindows'
import {
  allocateBudgetShares,
  contentWindowFromRaw,
  DEFAULT_CONTEXT_WINDOW,
  type BudgetLayerShares
} from '../../../shared/domain/contextBudget'
import type { BudgetLayers } from './types'

export function contextWindowFor(model: ModelInfo, providerId?: ProviderId): number {
  return resolveModelContextWindow(model, providerId) ?? DEFAULT_CONTEXT_WINDOW
}

export function allocateBudget(
  model: ModelInfo,
  providerId?: ProviderId
): Record<keyof BudgetLayers, number> {
  return allocateBudgetShares(contextWindowFor(model, providerId)) as Record<
    keyof BudgetLayerShares,
    number
  >
}

export function effectiveWindow(model: ModelInfo, providerId?: ProviderId): number {
  return contentWindowFromRaw(contextWindowFor(model, providerId))
}

/**
 * Window available for content after reserving the buffer layer.
 * Equals the non-buffer budget shares (85% of the raw model window).
 */
export function contentWindow(model: ModelInfo, providerId?: ProviderId): number {
  return effectiveWindow(model, providerId)
}

