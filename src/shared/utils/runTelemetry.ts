import type { AgentEvent, InstanceUsage } from '../ipc'

export type StepUsageTotals = {
  /** Latest step's full context / input window size (not cumulative bill). */
  inputTokens: number
  /** Provider accounting: true when inputTokens includes cached input tokens. */
  inputTokensIncludesCache?: boolean
  /** Sum of per-step inputTokens — true multi-step billed input shape. */
  billedInputTokens: number
  /** Peak per-step inputTokens this run. */
  peakInputTokens: number
  /** Sum of output tokens across steps. */
  outputTokens: number
  /** Latest step's cached input (window-relative). */
  cachedInputTokens: number
  /** Sum of per-step cached input tokens (for run-level hit rate). */
  billedCachedInputTokens: number
  /**
   * Sum of per-step whole-prompt tokens (`promptTokensFromUsage`) — the
   * denominator a cache share needs, whatever each provider counts as input.
   * Absent on totals rebuilt from before it was tracked.
   */
  billedPromptTokens?: number
  /** Tokens written into the prompt cache this run (Anthropic); accumulates across steps. */
  cacheCreationInputTokens: number
  /** Billed thinking tokens, a subset of the output tokens above. */
  reasoningTokens: number
  steps: number
  /** Steps where the provider reported any cache field (hit or write). */
  stepsWithCacheReport: number
  /** Sum of provider-reported `usage.cost` / `total_cost` across steps that included it. */
  billedCost: number
  /** Sum of provider-reported `cache_discount` (may be negative). */
  billedCostSaved: number
  /** Steps whose usage payload included a numeric cost field. */
  stepsWithCostReport: number
  /**
   * Sum of per-step estimated USD cost (tokens × published model prices) for
   * steps where the provider did NOT report a cost field. Kept separate from
   * `billedCost` so estimates are never presented as a provider bill.
   */
  estimatedCost: number
  /** Steps whose cost is an estimate (no provider-reported cost that step). */
  stepsWithEstimate: number
  /** Sum of per-step provider-stream wall-clock (request start → done usage). */
  generationMs: number
}

/**
 * Total prompt tokens actually sent on the wire.
 *
 * Providers disagree on what `inputTokens` covers. OpenAI-compatible and Gemini
 * report the whole prompt, cached reads included; Anthropic reports only the
 * uncached slice and splits the rest into `cachedInputTokens` /
 * `cacheCreationInputTokens` (providers/anthropic.ts sets
 * `inputTokensIncludesCache: false`). Context sizing needs one number — the
 * whole prompt — or a cache-warm step looks nearly empty and the auto-compact
 * trigger never fires. Observed on a real run: `inputTokens: 6` alongside
 * `cacheCreationInputTokens: 15900`, against a 13,070-token local estimate.
 *
 * Only an explicit `false` adds the cache slices. A provider that omits the flag
 * is assumed to report the full prompt: adding there would double-count a cached
 * prefix and compact far too early.
 *
 * Billing is the opposite — `estimateStepCost` prices each slice at its own rate
 * — so `step_usage.inputTokens` must keep the provider's raw figure. This helper
 * is for context sizing only.
 */
export function promptTokensFromUsage(usage: {
  inputTokens?: number
  inputTokensIncludesCache?: boolean
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
}): number {
  const input = positiveTokens(usage.inputTokens)
  if (usage.inputTokensIncludesCache !== false) return input
  return (
    input + positiveTokens(usage.cachedInputTokens) + positiveTokens(usage.cacheCreationInputTokens)
  )
}

function positiveTokens(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

export function emptyStepUsageTotals(): StepUsageTotals {
  return {
    inputTokens: 0,
    billedInputTokens: 0,
    peakInputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    billedCachedInputTokens: 0,
    billedPromptTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    steps: 0,
    stepsWithCacheReport: 0,
    billedCost: 0,
    billedCostSaved: 0,
    stepsWithCostReport: 0,
    estimatedCost: 0,
    stepsWithEstimate: 0,
    generationMs: 0
  }
}

export function mergeStepUsageTotals(a: StepUsageTotals, b: StepUsageTotals): StepUsageTotals {
  const nextInput = b.inputTokens > 0 ? b.inputTokens : a.inputTokens
  const stepInput = b.inputTokens > 0 ? b.inputTokens : 0
  const stepCached = b.inputTokens > 0 ? b.cachedInputTokens : 0
  const inputTokensIncludesCache =
    b.inputTokensIncludesCache !== undefined
      ? a.inputTokensIncludesCache !== undefined &&
          a.inputTokensIncludesCache !== b.inputTokensIncludesCache
        ? undefined
        : b.inputTokensIncludesCache
      : a.inputTokensIncludesCache
  return {
    inputTokens: nextInput,
    ...(inputTokensIncludesCache !== undefined ? { inputTokensIncludesCache } : {}),
    billedInputTokens: a.billedInputTokens + stepInput,
    peakInputTokens: Math.max(a.peakInputTokens, stepInput, a.inputTokens),
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: b.inputTokens > 0 ? b.cachedInputTokens : a.cachedInputTokens,
    billedCachedInputTokens: a.billedCachedInputTokens + stepCached,
    billedPromptTokens: (a.billedPromptTokens ?? 0) + (b.inputTokens > 0 ? (b.billedPromptTokens ?? 0) : 0),
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    steps: a.steps + b.steps,
    stepsWithCacheReport: a.stepsWithCacheReport + b.stepsWithCacheReport,
    billedCost: a.billedCost + (b.stepsWithCostReport > 0 ? b.billedCost : 0),
    billedCostSaved: a.billedCostSaved + b.billedCostSaved,
    stepsWithCostReport: a.stepsWithCostReport + b.stepsWithCostReport,
    estimatedCost: a.estimatedCost + (b.stepsWithEstimate > 0 ? b.estimatedCost : 0),
    stepsWithEstimate: a.stepsWithEstimate + b.stepsWithEstimate,
    generationMs: a.generationMs + b.generationMs
  }
}

/** The additive part of a run's totals — what a child instance adds to its parent's bill. */
export function instanceUsageOf(totals: StepUsageTotals): InstanceUsage {
  return {
    billedInputTokens: totals.billedInputTokens,
    billedCachedInputTokens: totals.billedCachedInputTokens,
    billedPromptTokens: totals.billedPromptTokens ?? 0,
    cacheCreationInputTokens: totals.cacheCreationInputTokens,
    outputTokens: totals.outputTokens,
    reasoningTokens: totals.reasoningTokens,
    ...(totals.inputTokensIncludesCache !== undefined
      ? { inputTokensIncludesCache: totals.inputTokensIncludesCache }
      : {}),
    steps: totals.steps,
    stepsWithCacheReport: totals.stepsWithCacheReport,
    billedCost: totals.billedCost,
    billedCostSaved: totals.billedCostSaved,
    stepsWithCostReport: totals.stepsWithCostReport,
    estimatedCost: totals.estimatedCost,
    stepsWithEstimate: totals.stepsWithEstimate,
    generationMs: totals.generationMs
  }
}

/** `b` minus `a`, field by field: what a child used since its last update. */
export function instanceUsageDelta(a: InstanceUsage | undefined, b: InstanceUsage): InstanceUsage {
  if (!a) return b
  const d = (x: number, y: number): number => Math.max(0, y - x)
  return {
    billedInputTokens: d(a.billedInputTokens, b.billedInputTokens),
    billedCachedInputTokens: d(a.billedCachedInputTokens, b.billedCachedInputTokens),
    billedPromptTokens: d(a.billedPromptTokens ?? 0, b.billedPromptTokens ?? 0),
    cacheCreationInputTokens: d(a.cacheCreationInputTokens, b.cacheCreationInputTokens),
    outputTokens: d(a.outputTokens, b.outputTokens),
    reasoningTokens: d(a.reasoningTokens, b.reasoningTokens),
    ...(b.inputTokensIncludesCache !== undefined ? { inputTokensIncludesCache: b.inputTokensIncludesCache } : {}),
    steps: d(a.steps, b.steps),
    stepsWithCacheReport: d(a.stepsWithCacheReport, b.stepsWithCacheReport),
    billedCost: d(a.billedCost, b.billedCost),
    billedCostSaved: b.billedCostSaved - a.billedCostSaved,
    stepsWithCostReport: d(a.stepsWithCostReport, b.stepsWithCostReport),
    estimatedCost: d(a.estimatedCost, b.estimatedCost),
    stepsWithEstimate: d(a.stepsWithEstimate, b.stepsWithEstimate),
    generationMs: d(a.generationMs, b.generationMs)
  }
}

/**
 * A child instance's usage added to the parent's: the bill, the steps and the
 * generation time sum; the window fields (inputTokens, cachedInputTokens,
 * peak) stay the parent's, since they size its context meter.
 */
export function addInstanceUsage(a: StepUsageTotals, child: InstanceUsage): StepUsageTotals {
  const flag = a.inputTokensIncludesCache ?? child.inputTokensIncludesCache
  return {
    ...a,
    ...(flag !== undefined ? { inputTokensIncludesCache: flag } : {}),
    billedInputTokens: a.billedInputTokens + child.billedInputTokens,
    billedCachedInputTokens: a.billedCachedInputTokens + child.billedCachedInputTokens,
    billedPromptTokens: (a.billedPromptTokens ?? 0) + (child.billedPromptTokens ?? 0),
    cacheCreationInputTokens: a.cacheCreationInputTokens + child.cacheCreationInputTokens,
    outputTokens: a.outputTokens + child.outputTokens,
    reasoningTokens: a.reasoningTokens + child.reasoningTokens,
    steps: a.steps + child.steps,
    stepsWithCacheReport: a.stepsWithCacheReport + child.stepsWithCacheReport,
    billedCost: a.billedCost + child.billedCost,
    billedCostSaved: a.billedCostSaved + child.billedCostSaved,
    stepsWithCostReport: a.stepsWithCostReport + child.stepsWithCostReport,
    estimatedCost: a.estimatedCost + child.estimatedCost,
    stepsWithEstimate: a.stepsWithEstimate + child.stepsWithEstimate,
    generationMs: a.generationMs + child.generationMs
  }
}

export function stepUsageFromEvent(event: AgentEvent): StepUsageTotals | null {
  if (event.type !== 'step_usage') return null
  const inputTokens = event.inputTokens ?? 0
  const cachedInputTokens = event.cachedInputTokens ?? 0
  const cacheCreationInputTokens = event.cacheCreationInputTokens ?? 0
  const cacheReported = cachedInputTokens > 0 || cacheCreationInputTokens > 0
  const billedCost =
    typeof event.billedCost === 'number' && Number.isFinite(event.billedCost)
      ? event.billedCost
      : undefined
  const billedCostSaved =
    typeof event.billedCostSaved === 'number' && Number.isFinite(event.billedCostSaved)
      ? event.billedCostSaved
      : 0
  const estimatedCost =
    typeof event.estimatedCost === 'number' && Number.isFinite(event.estimatedCost)
      ? event.estimatedCost
      : undefined
  return {
    inputTokens,
    ...(event.inputTokensIncludesCache !== undefined
      ? { inputTokensIncludesCache: event.inputTokensIncludesCache }
      : {}),
    billedInputTokens: inputTokens,
    peakInputTokens: inputTokens,
    outputTokens: event.outputTokens ?? 0,
    cachedInputTokens,
    billedCachedInputTokens: cachedInputTokens,
    billedPromptTokens: promptTokensFromUsage(event),
    cacheCreationInputTokens,
    reasoningTokens: event.reasoningTokens ?? 0,
    steps: 1,
    stepsWithCacheReport: cacheReported ? 1 : 0,
    billedCost: billedCost ?? 0,
    billedCostSaved,
    stepsWithCostReport: billedCost !== undefined ? 1 : 0,
    estimatedCost: estimatedCost ?? 0,
    stepsWithEstimate: estimatedCost !== undefined ? 1 : 0,
    generationMs:
      typeof event.generationMs === 'number' && Number.isFinite(event.generationMs)
        ? Math.max(0, Math.round(event.generationMs))
        : 0
  }
}

/**
 * Rebuild cumulative step usage from durable events.
 * Always sums per-step `inputTokens` / cache / output — ignores event-carried
 * `billedInputTokens` (those are process-local and reset on resume).
 */
export function stepUsageTotalsFromPersistedEvents(
  events: ReadonlyArray<{ event?: unknown }>
): StepUsageTotals {
  let totals = emptyStepUsageTotals()
  for (const row of events) {
    const ev = row.event as AgentEvent | undefined
    if (!ev || ev.type !== 'step_usage') continue
    const partial = stepUsageFromEvent(ev)
    if (partial) totals = mergeStepUsageTotals(totals, partial)
  }
  return totals
}
