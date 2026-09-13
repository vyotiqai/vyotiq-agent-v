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

const QUOTA_MESSAGE_RE =
  /weekly usage limit|usage limit reached|quota exceeded|quota exhausted|monthly usage limit|rate limit.*(?:billing|plan).*(?:exhaust|reached)/i

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
