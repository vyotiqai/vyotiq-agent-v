import type { RunStatus } from '../../shared/ipc'
import { parseCircuitRetryAfterMs } from './circuitBreaker'
import { isQuotaExhaustedMessage } from './quotaGate'

/**
 * Automatic relaunches are unlimited (run-stopping caps removed — user
 * decision). The 2026-08-31 circuit-open storm was fixed by honoring the
 * circuit's retryAfterMs (one delayed relaunch per stop, with backoff); the
 * relaunch budget cap that used to sit on top was removed — relaunches
 * continue until the goal completes or the user stops the run.
 */

/**
 * Pure relaunch decision for a stopped goal run, extracted so the gate logic
 * is unit-testable. The caller owns disk/registry state (readGoal, isActive)
 * and executes the plan.
 */
export type GoalRelaunchPlan =
  | { kind: 'none' }
  | { kind: 'blocked_quota'; reason: string }
  | { kind: 'immediate' }
  | { kind: 'delayed'; delayMs: number }

export function planGoalRelaunch(opts: {
  terminalStatus: 'done' | 'error' | 'cancelled' | undefined
  persisted: RunStatus | null
  goalActive: boolean
}): GoalRelaunchPlan {
  const persisted = opts.persisted
  if (opts.terminalStatus !== 'error') return { kind: 'none' }
  if (persisted?.status !== 'error' || persisted.resumable !== true) return { kind: 'none' }
  if (persisted.inlineInstance === true) return { kind: 'none' }
  const persistedError = persisted.error ?? ''
  // Quota exhaustion is a billing gate, not an outage — relaunching cannot
  // succeed until the plan resets. The goal stays active but waits for a user
  // continue / app restart.
  if (isQuotaExhaustedMessage(persistedError)) {
    return { kind: 'blocked_quota', reason: 'quota_exhausted' }
  }
  if (!opts.goalActive) return { kind: 'none' }
  const retryAfterMs = parseCircuitRetryAfterMs(persistedError)
  if (retryAfterMs != null && retryAfterMs > 0) {
    // Circuit-open stop: honor the provider host's retry window. The
    // 2026-08-31 storm fired here every ~0.25s because the persisted backoff
    // was ignored. ONE delayed relaunch per stop, uncapped (cap removed).
    return { kind: 'delayed', delayMs: Math.max(1_000, Math.min(retryAfterMs, 120_000)) }
  }
  return { kind: 'immediate' }
}
