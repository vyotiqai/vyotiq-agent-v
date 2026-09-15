export const SECOND_INSTANCE_UNRESPONSIVE_THRESHOLD_MS = 30_000

export type SecondInstancePlan =
  | { action: 'none' }
  | { action: 'focus' }
  | { action: 'recreate-window' }

/**
 * Pure decision for the second-instance handler: with no window there is
 * nothing to do; a window unresponsive for at least the threshold is wedged
 * and should be recreated; anything else just needs focus.
 */
export function planSecondInstanceAction(input: {
  hasWindow: boolean
  unresponsiveForMs: number | null
}): SecondInstancePlan {
  if (!input.hasWindow) return { action: 'none' }
  if (
    input.unresponsiveForMs !== null &&
    input.unresponsiveForMs >= SECOND_INSTANCE_UNRESPONSIVE_THRESHOLD_MS
  ) {
    return { action: 'recreate-window' }
  }
  return { action: 'focus' }
}
