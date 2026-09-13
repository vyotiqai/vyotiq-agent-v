import { runHarnessReview } from './harnessReview'
import type { HarnessReviewResult } from '../../shared/ipc'

/** Run harness review over recent receipts (rule-based; human-gated apply). */
export async function runHarnessReviewWithSettings(
  workspacePath: string,
  opts?: { limit?: number }
): Promise<HarnessReviewResult> {
  return runHarnessReview(workspacePath, { limit: opts?.limit })
}
