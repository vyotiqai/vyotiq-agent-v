import type { ModelInfo, ProviderIdAny, ThinkingEffort } from '@shared/ipc'
import { resolveModelPrice } from '@shared/pricing/modelPrices'
import {
  anthropicBudgetTokensForEffort,
  anthropicUsesAdaptiveThinking,
  anthropicUsesManualThinking,
  normalizeEffortForAnthropic
} from '@shared/reasoning'
import type { ThinkingModeOption } from './ThinkingControls'

/**
 * What an effort level costs, said before it is picked — only as far as the
 * app knows it. The level is what the loop asks for, at most: a stretch of
 * steps that only read or search steps down (`adaptiveThinkingEffort`), and
 * each provider maps the level onto its own ladder, some folding two levels
 * into one. So the words never rank one level against another. Where the
 * request itself says how much — a Claude model is sent a thinking budget or
 * a level (`anthropicThinkingFields`) — that is said, and two levels that send
 * the same thing say so.
 */

/** A Claude request's effort: a thinking budget on older models, the level on adaptive ones. */
export type ClaudeEffortRequest = { budget: number } | { level: string }

/** The Claude model id a provider sends thinking fields for, or null when it is not a Claude model. */
function claudeModelId(provider: ProviderIdAny, model: string): string | null {
  if (provider === 'anthropic') return model
  // Bedrock sends its own id; the thinking fields read it as is.
  if (provider === 'bedrock') return /(?:^|[.:/])anthropic\.claude/i.test(model) ? model : null
  // Vertex strips the publisher before the Messages request.
  if (provider === 'vertex') {
    const id = model.trim()
    return /^(?:anthropic\/)?claude-/i.test(id) ? id.replace(/^anthropic\//i, '') : null
  }
  return null
}

/**
 * What a Claude request carries at this effort, read the way
 * `anthropicThinkingFields` builds it. Null for every other model: its
 * provider decides what the level becomes.
 */
export function claudeEffortRequest(
  provider: ProviderIdAny,
  model: string,
  meta: Pick<ModelInfo, 'thinkingMode'> | null | undefined,
  effort: ThinkingEffort
): ClaudeEffortRequest | null {
  const id = claudeModelId(provider, model)
  if (!id) return null
  const mode =
    meta?.thinkingMode ??
    (anthropicUsesAdaptiveThinking(id) ? 'adaptive' : anthropicUsesManualThinking(id) ? 'manual' : undefined)
  if (mode === 'adaptive' || (!mode && anthropicUsesAdaptiveThinking(id))) {
    return { level: normalizeEffortForAnthropic(effort) }
  }
  if (mode === 'manual' || anthropicUsesManualThinking(id)) return { budget: anthropicBudgetTokensForEffort(effort) }
  return null
}

function sameRequest(a: ClaudeEffortRequest, b: ClaudeEffortRequest): boolean {
  return 'budget' in a ? 'budget' in b && a.budget === b.budget : 'level' in b && a.level === b.level
}

/**
 * What each level (and Off) says it costs, in the order of `modes`: null where
 * there is nothing to say beyond its name — a level another provider maps its
 * own way, or a Claude level sent as itself.
 */
export function effortNotes(
  modes: readonly ThinkingModeOption[],
  ctx: {
    provider: ProviderIdAny
    model: string
    meta: Pick<ModelInfo, 'thinkingMode'> | null | undefined
    /** A model that only switches thinking on or off. */
    onOffOnly?: boolean
  }
): (string | null)[] {
  const requests = modes.map((m) =>
    m.enabled && !ctx.onOffOnly ? claudeEffortRequest(ctx.provider, ctx.model, ctx.meta, m.effort) : null
  )
  return modes.map((m, i) => {
    if (!m.enabled) return 'No thinking before a step'
    if (ctx.onOffOnly) return 'Thinks before each step'
    const request = requests[i]
    if (!request) return null
    const twin = modes.find((_, j) => j !== i && requests[j] != null && sameRequest(requests[j]!, request))
    if ('budget' in request) {
      const tokens = `Up to ${request.budget.toLocaleString('en-US')} thinking tokens a step`
      return twin ? `${tokens}, the same as ${twin.label}` : tokens
    }
    if (request.level === m.effort) return null
    return twin ? `Sent as ${twin.label}: the same request` : `Sent as ${request.level}`
  })
}

/**
 * Said once under the levels: that the level is a ceiling, and — where the
 * price table knows the model — that its thinking is billed.
 */
export function effortFootNote(provider: ProviderIdAny, model: string): string {
  const ceiling = 'The most it thinks on a step: a run of steps that only read or search thinks less.'
  const price = resolveModelPrice(provider, model)?.price
  const billed = price ? (price.reasoning ?? price.output) > 0 : false
  return billed ? `${ceiling} Thinking tokens are billed.` : ceiling
}
