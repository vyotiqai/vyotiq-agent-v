import type { ModelInfo, ProviderIdAny, ThinkingEffort, ThinkingMode } from '@shared/ipc'
import { catalogThinkingAllowed, modelSupportsThinking, ollamaThinkingHeuristicFields } from '@shared/reasoning'

const ALL_EFFORT_OPTIONS: { value: ThinkingEffort; label: string; short: string }[] = [
  { value: 'minimal', label: 'Minimal', short: 'Min' },
  { value: 'low', label: 'Low', short: 'Low' },
  { value: 'medium', label: 'Medium', short: 'Med' },
  { value: 'high', label: 'High', short: 'High' },
  { value: 'xhigh', label: 'Extra high', short: 'XHigh' },
  { value: 'max', label: 'Max', short: 'Max' }
]

export type ThinkingModeOption =
  | { enabled: false; effort: ThinkingEffort | null; label: string; short: string }
  | { enabled: true; effort: ThinkingEffort; label: string; short: string }

export function buildModes(
  allowed: readonly ThinkingEffort[] | undefined,
  canDisable: boolean,
  thinkingMode: ThinkingMode | undefined,
  defaultEffort: ThinkingEffort = 'medium'
): ThinkingModeOption[] {
  if (thinkingMode === 'boolean') {
    const on: ThinkingModeOption = {
      enabled: true,
      effort: defaultEffort,
      label: 'On',
      short: 'On'
    }
    if (!canDisable) return [on]
    return [{ enabled: false, effort: null, label: 'Off', short: 'Off' }, on]
  }

  const options =
    allowed && allowed.length > 0
      ? ALL_EFFORT_OPTIONS.filter((o) => allowed.includes(o.value))
      : ALL_EFFORT_OPTIONS
  const effortModes: ThinkingModeOption[] = options.map((o) => ({
    enabled: true as const,
    effort: o.value,
    label: o.label,
    short: o.short
  }))
  if (!canDisable) return effortModes
  return [{ enabled: false, effort: null, label: 'Off', short: 'Off' }, ...effortModes]
}

export function modeIndex(
  modes: ThinkingModeOption[],
  enabled: boolean,
  effort: ThinkingEffort
): number {
  if (!enabled) {
    const off = modes.findIndex((m) => !m.enabled)
    return off >= 0 ? off : 0
  }
  const i = modes.findIndex((m) => m.enabled && m.effort === effort)
  if (i >= 0) return i
  const firstOn = modes.findIndex((m) => m.enabled)
  return firstOn >= 0 ? firstOn : 0
}

/** Catalog fields when present; Ollama GPT-OSS / seed heuristic when unset. */
export function resolveThinkingUiMeta(
  provider: ProviderIdAny,
  model: string,
  modelMeta?: ModelInfo | null
): {
  thinkingMode?: ThinkingMode
  supportedThinkingEfforts?: ThinkingEffort[]
  thinkingCanDisable: boolean
  thinkingDefaultEffort: ThinkingEffort
} {
  const ollamaHeuristic =
    provider === 'ollama' ? ollamaThinkingHeuristicFields(model) : undefined
  return {
    thinkingMode: modelMeta?.thinkingMode ?? ollamaHeuristic?.thinkingMode,
    supportedThinkingEfforts:
      modelMeta?.supportedThinkingEfforts ?? ollamaHeuristic?.supportedThinkingEfforts,
    thinkingCanDisable:
      modelMeta?.thinkingCanDisable ?? ollamaHeuristic?.thinkingCanDisable ?? true,
    thinkingDefaultEffort:
      modelMeta?.thinkingDefaultEffort ?? ollamaHeuristic?.thinkingDefaultEffort ?? 'medium'
  }
}

/**
 * Catalog true wins. Ollama hides only on confirmed `supportsThinking === false`.
 * Missing meta or unset flag falls back to the name heuristic (same families as the loop).
 * Other providers: catalog false softens for known reasoners via catalogThinkingAllowed.
 */
export function modelShowsThinkingControls(
  provider: ProviderIdAny,
  model: string,
  modelMeta?: ModelInfo | null
): boolean {
  if (modelMeta?.supportsThinking === true) return true
  if (modelMeta?.supportsThinking === false) {
    if (provider === 'ollama') return false
    return catalogThinkingAllowed(model, false)
  }
  return modelSupportsThinking(model, provider)
}
