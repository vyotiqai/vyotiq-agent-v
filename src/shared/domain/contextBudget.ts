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

/** Tools-layer budget = full window share (no soft ceiling). */
export function toolsBudgetFromRaw(window: number): number {
  return allocateBudgetShares(window).tools
}

/** Meter / event field: hard content window (no soft auto-summarize trigger). */
export function compactionTriggerFromRaw(window: number): number {
  return contentWindowFromRaw(window)
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

/** Remaining tokens on the raw provider window after measured layer usage. */
export function remainingWindowTokens(rawWindow: number, usedTokens: number): number {
  if (!Number.isFinite(rawWindow) || rawWindow <= 0) return 0
  const used = Number.isFinite(usedTokens) && usedTokens > 0 ? usedTokens : 0
  return Math.max(0, rawWindow - used)
}

/** Remaining tokens in the content budget after measured usage (meter headroom). */
export function remainingContentTokens(contentWindow: number, usedTokens: number): number {
  if (!Number.isFinite(contentWindow) || contentWindow <= 0) return 0
  const used = Number.isFinite(usedTokens) && usedTokens > 0 ? usedTokens : 0
  return Math.max(0, contentWindow - used)
}
