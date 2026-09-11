/**
 * Local calendar day (YYYY-MM-DD) of an ISO timestamp. Shared by the main
 * activity aggregator (receipt day buckets) and the Home panel (axis labels)
 * so both always agree on day boundaries.
 */
export function localDayKeyOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * The `count` local day keys ending at `todayKey` (inclusive, ascending).
 * Single source for the Activity window: the main aggregator scopes totals
 * to these keys and the Home panel renders exactly this axis.
 */
export function lastDayKeys(todayKey: string, count: number): string[] {
  const [y, m, d] = todayKey.split('-').map((part) => Number(part))
  if (!y || !m || !d) return []
  const out: string[] = []
  for (let i = count - 1; i >= 0; i--) {
    const dt = new Date(y, m - 1, d - i)
    const mm = String(dt.getMonth() + 1).padStart(2, '0')
    const dd = String(dt.getDate()).padStart(2, '0')
    out.push(`${dt.getFullYear()}-${mm}-${dd}`)
  }
  return out
}
