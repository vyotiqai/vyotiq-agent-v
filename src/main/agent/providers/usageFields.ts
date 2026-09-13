import type { TokenUsage } from './types'

export function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Provider-reported account charge only. Never reads `cost_details.upstream_inference_cost`. */
export function billedCostFromUsage(
  u: Record<string, unknown>
): Pick<TokenUsage, 'billedCost' | 'billedCostSaved'> {
  const billedCost = readFiniteNumber(u.cost) ?? readFiniteNumber(u.total_cost)
  const billedCostSaved = readFiniteNumber(u.cache_discount)
  return {
    ...(billedCost !== undefined ? { billedCost } : {}),
    ...(billedCostSaved !== undefined ? { billedCostSaved } : {})
  }
}

export function cacheWriteTokensFromDetails(
  details: unknown,
  fallback: unknown
): number | undefined {
  if (details && typeof details === 'object') {
    const write = readFiniteNumber((details as Record<string, unknown>).cache_write_tokens)
    if (write !== undefined) return write
  }
  return readFiniteNumber(fallback)
}
