import type { ProviderChatRequest } from './types'
import {
  anthropicBudgetTokensForEffort,
  anthropicThinkingCanDisable,
  anthropicThinkingOff,
  anthropicUsesAdaptiveThinking,
  anthropicUsesManualThinking,
  normalizeEffortForAnthropic,
  type AnthropicThinkingBlock
} from '../../../shared/reasoning'

/** Build Anthropic thinking + effort request fields. */
export function anthropicThinkingFields(req: ProviderChatRequest): Record<string, unknown> {
  const model = req.model
  // A model known to be adaptive is adaptive whatever a cached catalog row says:
  // rows saved before Haiku 5.5 was known still read 'manual' (model-catalog-cache.json).
  const mode = anthropicUsesAdaptiveThinking(model)
    ? 'adaptive'
    : (req.modelInfo?.thinkingMode ?? (anthropicUsesManualThinking(model) ? 'manual' : undefined))

  if (!req.thinking?.enabled) {
    // Explicit disable for models that may think by default (adaptive / Opus 5+).
    if (mode === 'adaptive') {
      // Always-thinking models 400 on `disabled`; the documented stand-in for
      // "thinking off" there is the lowest effort with `thinking` omitted.
      if (req.modelInfo?.thinkingCanDisable === false || !anthropicThinkingCanDisable(model)) {
        return { output_config: { effort: 'low' } }
      }
      return { thinking: anthropicThinkingOff(model) }
    }
    return {}
  }

  const effort = normalizeEffortForAnthropic(req.thinking.effort)
  const display = req.thinking.display ?? 'summarized'

  if (mode === 'adaptive' || (!mode && anthropicUsesAdaptiveThinking(model))) {
    return {
      thinking: { type: 'adaptive', display },
      output_config: { effort }
    }
  }

  if (mode === 'manual' || anthropicUsesManualThinking(model)) {
    const budget =
      req.thinking.maxTokens ?? anthropicBudgetTokensForEffort(req.thinking.effort)
    const maxTokens = Math.max(
      defaultAnthropicMaxTokens(model, req.maxOutputTokens),
      budget + 1024
    )
    return {
      thinking: { type: 'enabled', budget_tokens: budget },
      max_tokens: maxTokens
    }
  }

  return {}
}

/** Anthropic `max_tokens` when the request carries no usable hint. */
export function defaultAnthropicMaxTokens(model: string, hint?: number): number {
  if (hint && hint > 0) return Math.min(hint, 64_000)
  if (/haiku/i.test(model)) return 8192
  if (/opus|fable/i.test(model)) return 16_384
  return 8192
}

/** Replay stored Anthropic thinking blocks before text/tool_use in assistant messages. */
export function anthropicThinkingBlocksFromMessage(
  reasoningState: unknown
): AnthropicThinkingBlock[] {
  if (!reasoningState || typeof reasoningState !== 'object') return []
  const state = reasoningState as { kind?: string; blocks?: unknown }
  if (state.kind !== 'anthropic' || !Array.isArray(state.blocks)) return []
  return state.blocks as AnthropicThinkingBlock[]
}
