import type { ModelInfo } from '../ipc/schemas/providers'

/**
 * Context window and output limit set by hand for one model, for the models
 * the app can only guess about: a custom endpoint or a local server that does
 * not report them, where an unknown model was assumed to have 128k and an 8k
 * model was sent prompts sized for 128k.
 */
export type ModelLimitOverride = {
  contextWindow?: number
  maxOutputTokens?: number
}

/** `custom:lmstudio` + `qwen2.5-coder` → the settings key for that model. */
export function modelLimitKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`
}

/**
 * The model with the person's limits applied (source `user`), else with what
 * the running server reported (`server`), else as the catalog had it.
 */
export function applyModelLimitOverride(
  model: ModelInfo,
  override: ModelLimitOverride | undefined
): ModelInfo {
  if (!override) return model
  const contextWindow = override.contextWindow && override.contextWindow > 0 ? override.contextWindow : undefined
  const maxOutputTokens = override.maxOutputTokens && override.maxOutputTokens > 0 ? override.maxOutputTokens : undefined
  if (!contextWindow && !maxOutputTokens) return model
  return {
    ...model,
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    limitsSource: 'user'
  }
}

export function applyModelLimitOverrides(
  providerId: string,
  models: ModelInfo[],
  overrides: Record<string, ModelLimitOverride> | undefined
): ModelInfo[] {
  if (!overrides || Object.keys(overrides).length === 0) return models
  return models.map((m) => applyModelLimitOverride(m, overrides[modelLimitKey(providerId, m.id)]))
}
