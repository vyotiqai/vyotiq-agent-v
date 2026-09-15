/**
 * Token/cost attribution helpers (provider-agnostic).
 * No request bodies or secrets — counts and layer labels only.
 */

export type TokenCostLayers = {
  system: number
  history: number
  tools: number
  buffer: number
}

export type TokenCostHotspot = 'history' | 'tools' | 'system' | 'balanced'

/** Which estimate layer dominates content (excludes buffer share). */
export function classifyTokenCostHotspot(layers: TokenCostLayers): TokenCostHotspot {
  const ranked: Array<{ key: TokenCostHotspot; n: number }> = [
    { key: 'history', n: layers.history },
    { key: 'tools', n: layers.tools },
    { key: 'system', n: layers.system }
  ]
  ranked.sort((a, b) => b.n - a.n)
  const top = ranked[0]
  const second = ranked[1]
  if (!top || top.n <= 0) return 'balanced'
  if (second && top.n < second.n * 1.25) return 'balanced'
  return top.key
}

/** Latest-step cache hit share, or null when the provider reported no cache fields. */
export function stepCacheHitRate(
  inputTokens: number | undefined,
  cachedInputTokens: number | undefined,
  cacheReported: boolean
): number | null {
  if (!cacheReported) return null
  if (inputTokens == null || inputTokens <= 0) return null
  const cached = Math.max(0, cachedInputTokens ?? 0)
  return Math.min(1, cached / inputTokens)
}

/** Run-level cache hit share from cumulative billed totals. */
export function billedCacheHitRate(billedInput: number, billedCached: number): number | null {
  if (billedInput <= 0 || billedCached <= 0) return null
  return Math.min(1, billedCached / billedInput)
}

/** Steps at/above this input size count toward the low-cache rolling window. */
export const LARGE_STEP_INPUT_THRESHOLD = 20_000

/** Recent large cache-reported steps required before emitting low_cache_hit_rate. */
export const RECENT_LARGE_CACHE_WINDOW = 5

export function rollingMean(samples: readonly number[]): number | null {
  if (samples.length === 0) return null
  let sum = 0
  for (const s of samples) sum += s
  return sum / samples.length
}

/** Append a large-step cache hit sample; keeps only the newest `max` values. */
export function pushRecentLargeCacheHit(
  window: number[],
  hitRate: number,
  max = RECENT_LARGE_CACHE_WINDOW
): number[] {
  window.push(hitRate)
  if (window.length > max) window.splice(0, window.length - max)
  return window
}

export type TokenCostWarnKind =
  | 'context_above_soft_trigger'
  | 'low_cache_hit_rate'
  | 'high_context_watermark'
  | 'high_thinking_on_long_run'
  | 'long_run_task_boundary'

/**
 * Advisory cost hints belong in ContextMeter / Think chips — not composer `runNotice`.
 * Operational notices (compaction, deferred MCP, Stopping…) use other event types.
 */
export function isAdvisoryTokenCostHint(kind: TokenCostWarnKind): boolean {
  switch (kind) {
    case 'long_run_task_boundary':
    case 'high_thinking_on_long_run':
    case 'high_context_watermark':
    case 'context_above_soft_trigger':
    case 'low_cache_hit_rate':
      return true
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

/** Steps at/above which ops logs a long-run boundary (no user-facing /clear nag). */
export const LONG_RUN_STEP_HINT_THRESHOLD = 40

/** Cumulative billed input at/above which ops logs a long-run boundary. */
export const LONG_RUN_BILLED_INPUT_HINT_THRESHOLD = 1_000_000

/**
 * Steps at/above which high thinking effort warrants a user-facing “suggest lower” cue (P-THINK).
 * Matches `high_thinking_on_long_run` in `evaluateTokenCostWarnings`.
 */
export const HIGH_THINKING_LONG_RUN_STEP_THRESHOLD = 10

/** Effort ranks for stepping down (never silent — UI must call this only on user action). */
const THINKING_EFFORT_RANK = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
] as const

export type ThinkingEffortForCost = (typeof THINKING_EFFORT_RANK)[number]

export function isHighThinkingEffort(effort: string | null | undefined): boolean {
  return effort === 'high' || effort === 'xhigh' || effort === 'max'
}

/**
 * True when the composer should offer an explicit “Lower” action (never auto-apply).
 * Aligns with the long-run high-thinking warning threshold.
 */
export function shouldSuggestLowerThinkingEffort(input: {
  thinkingEnabled: boolean
  thinkingEffort: string | null | undefined
  steps: number
  /** Boolean On/Off thinking has no effort ladder — hide the chip. */
  thinkingMode?: 'boolean' | 'effort' | string | null
}): boolean {
  if (!input.thinkingEnabled) return false
  if (input.thinkingMode === 'boolean') return false
  if (!isHighThinkingEffort(input.thinkingEffort)) return false
  return input.steps >= HIGH_THINKING_LONG_RUN_STEP_THRESHOLD
}

/**
 * Next lower effort within `allowed` (or the full ladder). Returns null when already
 * at the bottom of the allowed set — caller must not invent a silent Off.
 */
export function nextLowerThinkingEffort(
  current: string,
  allowed?: readonly string[] | null
): ThinkingEffortForCost | null {
  const pool =
    allowed && allowed.length > 0
      ? THINKING_EFFORT_RANK.filter((e) => allowed.includes(e))
      : [...THINKING_EFFORT_RANK]
  if (pool.length === 0) return null
  const idx = pool.indexOf(current as ThinkingEffortForCost)
  if (idx <= 0) {
    // Current not in pool, or already lowest — try rank below current in full ladder
    // then pick the highest allowed that is still strictly below.
    const fullIdx = THINKING_EFFORT_RANK.indexOf(current as ThinkingEffortForCost)
    if (fullIdx <= 0) return null
    for (let i = fullIdx - 1; i >= 0; i--) {
      const candidate = THINKING_EFFORT_RANK[i]!
      if (pool.includes(candidate)) return candidate
    }
    return null
  }
  return pool[idx - 1] ?? null
}

export type TokenCostWarning = {
  kind: TokenCostWarnKind
  message: string
}

/**
 * Structured cost warnings (not spammy — callers gate by step counts / once flags).
 * Messages are log-oriented; use `userFacingTokenCostHint` for composer notices.
 */
export function evaluateTokenCostWarnings(input: {
  estimatedTokens: number
  compactionTrigger: number
  contentWindow: number
  compactedThisRun: boolean
  /** Single-step hit rate — used only when `recentLargeStepCacheHitRates` is omitted. */
  cacheHitRate: number | null
  /** Count of cache-reported steps — used only with legacy single-step path. */
  stepsWithCacheReport: number
  /** Current step ≥ large threshold — used only with legacy single-step path. */
  largeInput: boolean
  thinkingEnabled: boolean
  thinkingEffortHigh: boolean
  step: number
  /** Cumulative Σ step inputs this run (true bill shape). */
  billedInputTokens?: number
  /** Cumulative Σ cached input tokens this run — qualifies the billed figure. */
  cachedInputTokensTotal?: number
  /**
   * Newest large (≥ {@link LARGE_STEP_INPUT_THRESHOLD}) cache-reported hit rates.
   * Warning uses the mean once length ≥ {@link RECENT_LARGE_CACHE_WINDOW}.
   */
  recentLargeStepCacheHitRates?: readonly number[]
}): TokenCostWarning[] {
  const out: TokenCostWarning[] = []
  if (
    input.compactedThisRun &&
    input.compactionTrigger > 0 &&
    input.estimatedTokens > input.compactionTrigger * 1.25
  ) {
    out.push({
      kind: 'context_above_soft_trigger',
      message: `Context estimate ${input.estimatedTokens} still exceeds soft trigger ${input.compactionTrigger} after compaction`
    })
  }
  const recent = input.recentLargeStepCacheHitRates
  const rolling =
    recent != null && recent.length >= RECENT_LARGE_CACHE_WINDOW
      ? rollingMean(recent)
      : null
  const legacyRate =
    recent == null &&
    input.cacheHitRate != null &&
    input.stepsWithCacheReport >= RECENT_LARGE_CACHE_WINDOW &&
    input.largeInput
      ? input.cacheHitRate
      : null
  const cacheWarnRate = rolling ?? legacyRate
  if (cacheWarnRate != null && cacheWarnRate < 0.1) {
    out.push({
      kind: 'low_cache_hit_rate',
      message: `Prompt cache hit rate ${(cacheWarnRate * 100).toFixed(1)}% over recent large steps`
    })
  }
  if (input.contentWindow > 0 && input.estimatedTokens >= input.contentWindow * 0.8) {
    out.push({
      kind: 'high_context_watermark',
      message: `Context estimate ${input.estimatedTokens} is ≥80% of content window ${input.contentWindow}`
    })
  }
  if (
    input.thinkingEnabled &&
    input.thinkingEffortHigh &&
    input.step >= HIGH_THINKING_LONG_RUN_STEP_THRESHOLD
  ) {
    out.push({
      kind: 'high_thinking_on_long_run',
      message: `Thinking is enabled at high effort on step ${input.step} — reasoning tokens accumulate every step`
    })
  }
  const billed = Math.max(0, input.billedInputTokens ?? 0)
  if (
    input.step >= LONG_RUN_STEP_HINT_THRESHOLD ||
    billed >= LONG_RUN_BILLED_INPUT_HINT_THRESHOLD
  ) {
    // Σ step inputs overstates the bill when the provider caches most of the
    // prompt — qualify the figure with the cumulative cache share.
    const cachedTotal = Math.max(0, input.cachedInputTokensTotal ?? 0)
    const cachedPct =
      billed > 0 && cachedTotal > 0 ? Math.min(100, (cachedTotal / billed) * 100) : null
    out.push({
      kind: 'long_run_task_boundary',
      message:
        cachedPct == null
          ? `Long run at step ${input.step} (billed input ${billed})`
          : `Long run at step ${input.step} (billed input ${billed}, ${cachedPct.toFixed(1)}% from cache)`
    })
  }
  return out
}

/**
 * User-facing ContextMeter copy — intentionally null.
 * Context is managed by auto-compact + the Compact menu; do not nag /clear.
 */
export function userFacingTokenCostHint(
  _kind: TokenCostWarnKind,
  _step?: number
): string | null {
  return null
}

/** Deprecated: task-boundary /clear tips are suppressed — auto + menu compact own continuity. */
export function shouldShowTaskBoundaryTip(_input: {
  steps: number
  billedInputTokens: number
}): boolean {
  return false
}

/** Count characters in non-stubbed tool message bodies (cheap hotspot signal). */
export function countKeptToolResultChars(
  messages: readonly { role?: string; content?: unknown }[],
  stubMarker = '[cleared]'
): number {
  let n = 0
  for (const m of messages) {
    if (m.role !== 'tool') continue
    const text = typeof m.content === 'string' ? m.content : ''
    if (!text || text === stubMarker || text.endsWith(stubMarker)) continue
    n += text.length
  }
  return n
}

export type ToolCallCountRow = { name: string; calls: number }

/** Rank tools by total calls (ok + failed) for run-summary cost attribution. */
export function topToolsByCallCount(
  byName: Readonly<Record<string, { ok?: number; failed?: number }>> | undefined,
  limit = 8
): ToolCallCountRow[] {
  if (!byName || limit <= 0) return []
  return Object.entries(byName)
    .map(([name, stat]) => ({
      name,
      calls: Math.max(0, (stat.ok ?? 0) + (stat.failed ?? 0))
    }))
    .filter((row) => row.calls > 0)
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
    .slice(0, limit)
}
