import type { ProviderChatRequest } from './types'
import {
  anthropicBudgetTokensForEffort,
  anthropicUsesAdaptiveThinking,
  anthropicUsesManualThinking,
  normalizeEffortForAnthropic,
  type AnthropicThinkingBlock
} from '../../../shared/reasoning'

/** Build Anthropic thinking + effort request fields. */
export function anthropicThinkingFields(req: ProviderChatRequest): Record<string, unknown> {
  const model = req.model
  const mode =
    req.modelInfo?.thinkingMode ??
    (anthropicUsesAdaptiveThinking(model)
      ? 'adaptive'
      : anthropicUsesManualThinking(model)
        ? 'manual'
        : undefined)

  if (!req.thinking?.enabled) {
    // Explicit disable for models that may think by default (adaptive / Opus 5+).
    if (mode === 'adaptive' || anthropicUsesAdaptiveThinking(model)) {
      return { thinking: { type: 'disabled' } }
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

function defaultAnthropicMaxTokens(model: string, hint?: number): number {
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
