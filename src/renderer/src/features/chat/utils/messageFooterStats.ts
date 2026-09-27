import { formatTokens } from '@renderer/lib/utils/formatTokens'
import { formatUsdCost } from '@shared/utils/costDisplay'
import type { StepUsageTotals } from '@shared/utils/runTelemetry'

/** Sub-second streams are too short for a meaningful tok/s rate. */
const MIN_GENERATION_MS = 1000

/** Anthropic-shaped usage: `input_tokens` excludes cache read/write. */
export function inputExcludesCache(usage: StepUsageTotals): boolean {
  if (usage.inputTokensIncludesCache !== undefined) {
    return !usage.inputTokensIncludesCache
  }
  if (usage.billedCachedInputTokens > usage.billedInputTokens) return true
  return (
    usage.billedCachedInputTokens > 0 &&
    usage.billedCachedInputTokens === usage.billedInputTokens &&
    usage.cacheCreationInputTokens > 0
  )
}

export function freshCaptionTokens(usage: StepUsageTotals): number {
  const freshInput = inputExcludesCache(usage)
    ? usage.billedInputTokens
    : Math.max(0, usage.billedInputTokens - usage.billedCachedInputTokens)
  return freshInput + usage.outputTokens
}

export function cacheCaptionPct(usage: StepUsageTotals): number | null {
  if (usage.stepsWithCacheReport <= 0 || usage.billedCachedInputTokens <= 0) return null
  const denom = inputExcludesCache(usage)
    ? usage.billedInputTokens + usage.billedCachedInputTokens + usage.cacheCreationInputTokens
    : usage.billedInputTokens
  if (denom <= 0) return null
  return Math.round((usage.billedCachedInputTokens / denom) * 100)
}

/**
 * Cost to show for the turn, with its honesty label.
 * - Actual: every step reported a provider cost field (OpenRouter-style).
 * - Estimate: every step either reported a cost or was priced from published
 *   model rates (tokens × price). Runs with unpriceable steps return null —
 *   a partial estimate would silently undercount, so tokens-only is shown.
 */
export function turnCost(
  usage: StepUsageTotals
): { cost: number; estimated: boolean } | null {
  if (usage.steps <= 0) return null
  if (usage.stepsWithCostReport === usage.steps) {
    return { cost: usage.billedCost, estimated: false }
  }
  const covered = usage.stepsWithCostReport + usage.stepsWithEstimate
  if (covered === usage.steps && usage.stepsWithEstimate > 0) {
    return { cost: usage.billedCost + usage.estimatedCost, estimated: true }
  }
  return null
}

/** Provider output tokens / summed stream wall-clock. Null until both are real. */
export function outputTokensPerSecond(usage: StepUsageTotals): number | null {
  if (usage.outputTokens <= 0 || usage.generationMs < MIN_GENERATION_MS) return null
  return usage.outputTokens / (usage.generationMs / 1000)
}

export function formatTokPerSec(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  const label = n >= 10 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, '')
  return `${label} output tok/s`
}

/**
 * The one caption vocabulary for fresh tokens and cache share. The chat
 * footer and the task record's receipt both print these exact strings, so a
 * metric reads the same wherever a run is summarized.
 */
export function tokensCaption(tokens: number): string {
  return `${formatTokens(tokens)} tok (in+out)`
}

export function cacheHitCaption(pct: number): string {
  return `${pct}% cache hit`
}

export function formatBilledUsd(n: number): string {
  return formatUsdCost(n)
}
