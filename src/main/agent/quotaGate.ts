/**
 * Quota-exhaustion message classifier. Provider usage limits are billing
 * gates, not transient throttling. Evidence: run 6265fa90 (2026-08-31) —
 * opencode glm-5.3-flash returned HTTP 429 "Weekly usage limit reached.
 * Resets in 6 days" and the goal relaunch path fired 472 times in ~4
 * minutes until the 500-step runaway-loop guard stopped the run.
 *
 * The run loop itself no longer stops terminally on quota errors (they flow
 * through the normal resumable provider-failure path). This classifier is
 * used by the automatic relaunch/resume guards (goalRelaunchPlan,
 * resumeActiveGoals, runLoopScheduler) so a quota-exhausted stop is never
 * relaunched automatically — the user Continue's after the plan resets.
 *
 * Detection is message-based because the wire error that reaches the loop is
 * the provider's human-readable message (PROVIDER_HTTP carries the provider
 * body; the circuit chunk that finally goes terminal carries no status).
 */

// Alternatives, most specific first. Every one keeps `usage`, `quota` or
// `plan` in front of `limit`: a bare "limit exceeded" is the throttling
// wording ("Rate limit exceeded, retry after 12s") and must stay transient.
//   window names  weekly|monthly|daily|hourly|annual|yearly usage limit
//   limit+state   usage|quota limit reached|exceeded|exhausted
//   exceeded-you  exceeded your/the … usage|quota limit  (gap bounded, no
//                 sentence crossing — "exceeded your rate limit" stays false)
//   plan limit    plan|billing limit reached|exceeded
//   rate limit    rate limit … billing|plan … exhausted|reached
// `usage limit exceeded` is here because every alternative above it was a
// two-part wording ending in "reached" and the vendor's own string is not.
// vyotiq.log, 2026-09-29 00:12:58→00:44:12: 88 occurrences of
//   [provider] Provider http failure { status: 429, provider: 'opencode',
//   model: 'mimo-v2.6-pro', providerMessage: 'Go usage limit exceeded' }
// across 7 run ids, 12–13 retries each on the same step with attempt climbing
// 1→13 — a plan limit that resets on a schedule, retried as if it were
// throttling (1,177,849 billed input tokens in that window).
const QUOTA_MESSAGE_RE =
  /(?:weekly|monthly|daily|hourly|annual|yearly) usage limit|(?:usage|quota) limit (?:reached|exceeded|exhausted)|quota exceeded|quota exhausted|exceeded (?:your|the) [^.!?\n]{0,40}?(?:usage|quota) limit|(?:plan|billing) limit (?:reached|exceeded)|rate limit.*(?:billing|plan).*(?:exhaust|reached)/i

/**
 * True when a provider failure message is a usage-limit / quota exhaustion
 * (billing gate), as opposed to transient rate-limit throttling.
 * Fixture is verbatim from vyotiq.log run 6265fa90, 2026-08-31T17:43:24Z.
 */
export function isQuotaExhaustedMessage(message: string): boolean {
  const s = message.trim()
  if (!s) return false
  return QUOTA_MESSAGE_RE.test(s)
}
