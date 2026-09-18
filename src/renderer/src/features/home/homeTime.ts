/**
 * Countdown to an armed loop's next tick. Past or imminent ticks read "due
 * now" — the scheduler retries delivery, so a past `nextAt` is a real state
 * rather than an error. Invalid input returns null and the badge is omitted.
 */
export function nextTickLabel(iso: string, now = Date.now()): string | null {
  const target = Date.parse(iso)
  if (!Number.isFinite(target)) return null
  const remain = target - now
  if (remain < 60_000) return 'due now'
  const minutes = Math.round(remain / 60_000)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.round(remain / 3_600_000)
  if (hours < 48) return `in ${hours}h`
  return `in ${Math.round(remain / 86_400_000)}d`
}
