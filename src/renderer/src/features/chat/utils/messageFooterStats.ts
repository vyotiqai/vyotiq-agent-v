import { formatTokens } from '@renderer/lib/utils/formatTokens'
import { formatDisplayTime, formatElapsed } from '@shared/utils/timeFormat'
import { formatUsdCost } from '@shared/utils/costDisplay'
import type { StepUsageTotals } from '@shared/utils/runTelemetry'

/** Match TurnSummary: sub-second turns are not worth a duration caption. */
export const MIN_FOOTER_DURATION_MS = 1000

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

/** `$` only when every completed step in the turn reported a cost field. */
export function reportedBilledCost(usage: StepUsageTotals): number | null {
  if (usage.steps <= 0 || usage.stepsWithCostReport !== usage.steps) return null
  return usage.billedCost
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

export function reportedSavedCost(usage: StepUsageTotals): number | null {
  if (usage.billedCostSaved > 0) return usage.billedCostSaved
  return null
}

/** Provider output tokens / summed stream wall-clock. Null until both are real. */
export function outputTokensPerSecond(usage: StepUsageTotals): number | null {
  if (usage.outputTokens <= 0 || usage.generationMs < MIN_FOOTER_DURATION_MS) return null
  return usage.outputTokens / (usage.generationMs / 1000)
}

export function formatTokPerSec(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  const label = n >= 10 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, '')
  return `${label} output tok/s`
}

export function formatBilledUsd(n: number): string {
  return formatUsdCost(n)
}

export function formatFooterDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < MIN_FOOTER_DURATION_MS) return ''
  return formatElapsed(ms)
}

export function clockLabel(at: string | undefined): string {
  if (!at) return ''
  const clock = formatDisplayTime(at)
  const day = new Date(at).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
  if (Number.isNaN(new Date(at).getTime())) return ''
  return clock ? `${day} · ${clock}` : day
}

export function turnElapsedMs(opts: {
  startedAt: number | null
  endedAt: number | null
  active: boolean
  nowMs: number
}): number | null {
  if (opts.startedAt == null) return null
  if (opts.active) return opts.nowMs - opts.startedAt
  if (opts.endedAt == null) return null
  return opts.endedAt - opts.startedAt
}

export type FooterStatsModel = {
  caption: string
  tooltip: string
  ariaLabel: string
}

export function buildFooterStats(opts: {
  startedAt: number | null
  endedAt: number | null
  active: boolean
  nowMs: number
  at?: string
  usage?: StepUsageTotals | null
  /** Live TurnSummary already shows elapsed — don't tick a second clock here. */
  omitDuration?: boolean
  /** Live TurnSummary already shows the receipt — footer is copy only. */
  omitReceipt?: boolean
}): FooterStatsModel {
  if (opts.omitReceipt) {
    return { caption: '', tooltip: '', ariaLabel: '' }
  }
  const duration = opts.omitDuration ? '' : formatFooterDuration(turnElapsedMs(opts))
  const usage = opts.usage
  const hasUsage = usage != null && usage.steps > 0
  const cost = hasUsage ? turnCost(usage) : null
  const saved = hasUsage ? reportedSavedCost(usage) : null
  const cachePct = hasUsage ? cacheCaptionPct(usage) : null
  const tokens = hasUsage ? freshCaptionTokens(usage) : 0
  const tokPerSec = hasUsage ? outputTokensPerSecond(usage) : null
  const showTokens =
    hasUsage &&
    (usage.billedInputTokens > 0 ||
      usage.outputTokens > 0 ||
      usage.billedCachedInputTokens > 0 ||
      usage.cacheCreationInputTokens > 0)

  const captionParts: string[] = []
  if (duration) captionParts.push(duration)
  if (cost != null) {
    // Estimates are labeled — never presented as a provider bill.
    captionParts.push(
      cost.estimated ? `${formatBilledUsd(cost.cost)} est.` : formatBilledUsd(cost.cost)
    )
  }
  // Fresh (non-cached) input + output — not the run total; the tooltip breaks it down.
  if (showTokens) captionParts.push(`${formatTokens(tokens)} tok (in+out)`)
  if (tokPerSec != null) {
    const rate = formatTokPerSec(tokPerSec)
    if (rate) captionParts.push(rate)
  }
  if (cachePct != null) captionParts.push(`${cachePct}% cache hit`)
  const caption = captionParts.join(' · ')

  const clock = clockLabel(opts.at)
  const detail: string[] = []
  if (clock) detail.push(clock)
  if (cost?.estimated) {
    detail.push('Estimate from published model rates — not a provider bill')
  }
  if (saved != null) detail.push(`Saved ${formatBilledUsd(saved)}`)
  if (hasUsage) {
    if (usage.billedInputTokens > 0) detail.push(`In ${formatTokens(usage.billedInputTokens)}`)
    if (usage.outputTokens > 0) detail.push(`Out ${formatTokens(usage.outputTokens)}`)
    if (usage.billedCachedInputTokens > 0) {
      detail.push(`Cache read ${formatTokens(usage.billedCachedInputTokens)}`)
    }
    if (usage.cacheCreationInputTokens > 0) {
      detail.push(`Cache write ${formatTokens(usage.cacheCreationInputTokens)}`)
    }
  }

  const tooltip = detail.join('\n')
  const ariaLabel = [caption, tooltip ? tooltip.replace(/\n/g, ', ') : '']
    .filter(Boolean)
    .join(', ')
  return { caption, tooltip, ariaLabel }
}
