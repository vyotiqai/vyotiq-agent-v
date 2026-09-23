/** Compact relative time: "now" | "2m" | "51m" | "3h" | "2d" */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const ms = now - new Date(iso).getTime()
  if (Number.isNaN(ms) || ms < 0) return ''
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 48) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

/** Conversational relative time for message footers: "just now" | "51m ago" */
export function relativeTimeAgo(iso: string): string {
  const compact = relativeTime(iso)
  if (!compact) return ''
  return compact === 'now' ? 'just now' : `${compact} ago`
}

/** Compact display time for messages, tools, and activity rows. */
export function formatDisplayTime(iso: string, opts?: { seconds?: boolean }): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(
    [],
    opts?.seconds
      ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
      : { hour: '2-digit', minute: '2-digit' }
  )
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.max(1, ms)}ms`
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) {
    const parts = [`${h}h`]
    if (m > 0) parts.push(`${m}m`)
    if (s > 0) parts.push(`${s}s`)
    return parts.join(' ')
  }
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}
