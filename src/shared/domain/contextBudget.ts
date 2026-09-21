/**
 * Shared context-budget shares. Main `budget.ts` and UI rescale helpers must
 * stay in lockstep so meters match assembly.
 */
export type BudgetLayerShares = {
  system: number
  tools: number
  memoryWorkspace: number
  history: number
  buffer: number
}

/**
 * Layer shares of the raw model window.
 *
 * `tools` is accounting, not a ceiling: `buildStepToolCatalog` ships every
 * builtin and admitted MCP tool and never evicts, so nothing compares the tools
 * layer against its share. The number still matters — `contentWindowFromRaw` is
 * the sum of the non-buffer shares, so every meter, compaction trigger and
 * overflow test is derived from it. Change it only with that in mind.
 */
export const BUDGET_SHARES: BudgetLayerShares = {
  system: 0.12,
  tools: 0.18,
  memoryWorkspace: 0.15,
  history: 0.4,
  buffer: 0.15
}

export const DEFAULT_CONTEXT_WINDOW = 128_000

export function allocateBudgetShares(window: number): Record<keyof BudgetLayerShares, number> {
  const system = Math.floor(window * BUDGET_SHARES.system)
  const tools = Math.floor(window * BUDGET_SHARES.tools)
  const memoryWorkspace = Math.floor(window * BUDGET_SHARES.memoryWorkspace)
  const history = Math.floor(window * BUDGET_SHARES.history)
  const buffer = Math.floor(window * BUDGET_SHARES.buffer)
  return {
    system,
    tools,
    memoryWorkspace,
    history,
    buffer: buffer + (window - (system + tools + memoryWorkspace + history + buffer))
  }
}

/** Non-buffer budget (85% of raw window). */
export function contentWindowFromRaw(window: number): number {
  const b = allocateBudgetShares(window)
  return b.system + b.tools + b.memoryWorkspace + b.history
}

/** Default fraction of content window that triggers proactive LLM compaction. */
export const DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO = 0.55

/** Previous product default, once written into settings.json. */
export const LEGACY_AUTO_COMPACT_THRESHOLD_RATIO = 0.2

/** Clamp and convert a content-window ratio into a proactive compact token threshold. */
export function proactiveCompactThresholdTokens(
  contentWindow: number,
  ratio: number = DEFAULT_AUTO_COMPACT_THRESHOLD_RATIO
): number {
  if (!Number.isFinite(contentWindow) || contentWindow <= 0) return 0
  const clamped = Math.min(0.95, Math.max(0.05, ratio))
  return Math.floor(contentWindow * clamped)
}

/** Remaining tokens in the content budget after measured usage (meter headroom). */
export function remainingContentTokens(contentWindow: number, usedTokens: number): number {
  if (!Number.isFinite(contentWindow) || contentWindow <= 0) return 0
  const used = Number.isFinite(usedTokens) && usedTokens > 0 ? usedTokens : 0
  return Math.max(0, contentWindow - used)
}

/**
 * True when an estimated request would exceed the given model window. Used to
 * skip compaction/request paths that would otherwise 400 at the provider hard
 * limit (observed: run e7d7d807, request resolved to 1,068,578 tokens on a
 * 1,048,576-token raw window). Callers pass the relevant window — the content
 * window is safe here because it sits below the raw window, so a request that
 * fits the content window can never breach the provider hard limit.
 */
export function exceedsHardLimit(contextWindow: number, estimatedTokens: number): boolean {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return false
  if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) return false
  return estimatedTokens > contextWindow
}
