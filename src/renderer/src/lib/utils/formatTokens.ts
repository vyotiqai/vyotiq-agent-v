/** Compact token counts for context meters (composer and tool rows). */
export function formatTokens(n: number, allowNegative = false): string {
  const v = Math.round(Number.isFinite(n) ? n : 0)
  if (v === 0) return '0'
  if (v < 0 && !allowNegative) return '0'
  const sign = v < 0 ? '-' : ''
  const abs = Math.abs(v)
  if (abs >= 1_000_000) {
    const m = abs / 1_000_000
    if (m >= 10) return `${sign}${Math.round(m)}M`
    if (Number.isInteger(m)) return `${sign}${m}M`
    return `${sign}${m.toFixed(1).replace(/\.0$/, '')}M`
  }
  if (abs >= 10_000) return `${sign}${Math.round(abs / 1000)}k`
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${sign}${abs}`
}
