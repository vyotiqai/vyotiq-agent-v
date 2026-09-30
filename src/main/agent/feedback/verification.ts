/**
 * Live verification tracker — the in-loop half of `verificationFromEvents`.
 *
 * The receipt already derives "was the work checked after the last mutation"
 * from persisted events (runReceipt.ts), but only at teardown, when the turn
 * can no longer act on it. This mirrors that judgment as the run happens,
 * importing the same cleanliness predicates so the two can never drift.
 *
 * Observation is invoke-scoped on purpose. `mutationPaths` in the loop is
 * re-seeded from history on resume, so it spans earlier invokes; the gate
 * must only speak about work the current turn actually did.
 */

import { checkVerdict, isCheckCandidateTool } from '../runReceipt'

/**
 * Cap on the witnessed-path list. It is a sample for the gate message, not the
 * mutation set: only edit-family tool calls carry a path argument, so a
 * checkpoint-detected mutation (terminal write, MCP writer, lsp rename, merge,
 * git_apply, watcher) sets `mutated` while contributing nothing here.
 */
const WITNESSED_PATH_CAP = 12

export type VerificationState = {
  /** A successful file mutation was observed this invoke. */
  mutated: boolean
  /**
   * Edit-family paths witnessed this invoke, first-seen order, capped. May be
   * empty while `mutated` is true — see `WITNESSED_PATH_CAP`.
   */
  paths: string[]
  /** A check ran after the last mutation AND reported clean. */
  verifiedAfterLastMutation: boolean
  /** No check tool ran at all since the last mutation. */
  neverChecked: boolean
  /** Newest post-mutation check ran but reported errors/failures. */
  lastCheckFailed: boolean
}

export type VerificationTracker = {
  noteMutation(path: string | undefined, ok: boolean): void
  /** `command`: the call's command argument — how a `terminal` test run is recognised. */
  noteToolResult(toolName: string | undefined, content: string, ok: boolean, command?: string): void
  /**
   * Reconciliation against the invoke write checkpoint's
   * `otherWriteCount` — every write it recorded for a tool other than the
   * edit family: terminal writes (`sed -i`, redirects, `rm`), MCP writers,
   * lsp renames, merges, git_apply and watched out-of-band changes, re-writes
   * of a path already recorded included. Called after every tool call, so a
   * write lands in the order it happened relative to the checks around it,
   * and once more at step end.
   *
   * Pass `undefined` when no checkpoint session is open; the observation is
   * then skipped rather than read as the count shrinking to zero.
   *
   * `checkpointId` matters: `flushWriteCheckpoint({reopen})` finalizes the
   * session and starts a fresh one with a zero count at every follow-up and
   * goal-continue boundary. Without re-baselining on a new id, the old
   * high-water mark would swallow every later mutation in the run.
   */
  noteOtherWriteCount(count: number | undefined, checkpointId?: string): void
  state(): VerificationState
}

export function createVerificationTracker(): VerificationTracker {
  let seq = 0
  let lastMutationSeq: number | null = null
  let lastCheckSeq: number | null = null
  let lastCheckClean: boolean | null = null
  let lastOtherWriteCount = 0
  let lastCheckpointId: string | undefined
  const paths: string[] = []

  return {
    noteMutation(path, ok) {
      // A refused or failed write changed nothing — counting it would demand
      // verification of work that never landed.
      if (!ok) return
      seq += 1
      lastMutationSeq = seq
      if (path && paths.length < WITNESSED_PATH_CAP && !paths.includes(path)) {
        paths.push(path)
      }
    },

    noteOtherWriteCount(count, checkpointId) {
      if (count == null) return
      if (checkpointId !== undefined && checkpointId !== lastCheckpointId) {
        // Re-anchored session: its count restarts at zero, so the previous
        // high-water mark is meaningless against it.
        lastCheckpointId = checkpointId
        lastOtherWriteCount = 0
      }
      const grew = count > lastOtherWriteCount
      lastOtherWriteCount = Math.max(lastOtherWriteCount, count)
      if (grew) {
        seq += 1
        lastMutationSeq = seq
      }
    },

    noteToolResult(toolName, content, ok, command) {
      if (!isCheckCandidateTool(toolName)) return
      // Same verdict the receipt reads: a check that never ran (no runner, a
      // denied or unparseable call, a typecheck skipped for want of a
      // project, an empty result body) verified nothing; one that ran and
      // failed — a failing test run is `ok: false` — is a failed check, not
      // an absent one.
      const verdict = checkVerdict(toolName, ok, content, command)
      if (verdict === 'skip') return
      seq += 1
      lastCheckSeq = seq
      lastCheckClean = verdict === 'clean'
    },

    state() {
      const checkIsNewer =
        lastCheckSeq != null && (lastMutationSeq == null || lastCheckSeq >= lastMutationSeq)
      return {
        mutated: lastMutationSeq != null,
        paths: [...paths],
        // Same shape as runReceipt's verifiedAfterLastMutation: a check must
        // exist, be newer than the mutation, and not have reported errors.
        verifiedAfterLastMutation: checkIsNewer && lastCheckClean !== false,
        neverChecked: !checkIsNewer,
        lastCheckFailed: checkIsNewer && lastCheckClean === false
      }
    }
  }
}

export type VerificationGateVerdict = {
  wouldFire: boolean
  /** Short, stable slug — safe for logs, receipts and cluster keys. */
  reason?: 'never_checked' | 'check_failed'
  /** Sample of mutated paths for the corrective message; may be empty. */
  paths?: string[]
  /** The gate fired at an earlier turn end this invoke and injected its nudge. */
  nudged?: boolean
}

const NUDGE_PATH_SAMPLE = 5

/**
 * The one corrective turn an armed gate injects. It asks for a check or an
 * honest statement of what is unverified — never blocks, never repeats: the
 * loop sends it at most once per invoke.
 */
export function verificationNudgeText(verdict: VerificationGateVerdict): string {
  const paths = (verdict.paths ?? []).slice(0, NUDGE_PATH_SAMPLE)
  const more = (verdict.paths?.length ?? 0) - paths.length
  const named = paths.length > 0 ? ` (${paths.join(', ')}${more > 0 ? `, +${more} more` : ''})` : ''
  if (verdict.reason === 'check_failed') {
    return (
      `Verification: the last check after your code changes${named} did not pass. ` +
      'Fix the failure and run the check again. If the failure is outside this task, say so in your answer and quote the failing output.'
    )
  }
  return (
    `Verification: you changed code${named} and no test, typecheck or lint run has passed since the last change. ` +
    "Before you finish, run the narrowest check that proves it — run_tests, diagnostics, or the project's test command in the terminal. " +
    'If no check can run here, say in your answer exactly what is unverified and why.'
  )
}

/**
 * The comparator. Deterministic and cheap: no transcript scan, no model call.
 * Speaks only about mutations this invoke witnessed.
 */
export function evaluateVerificationGate(state: VerificationState): VerificationGateVerdict {
  if (!state.mutated) return { wouldFire: false }
  if (state.verifiedAfterLastMutation) return { wouldFire: false }
  return {
    wouldFire: true,
    reason: state.lastCheckFailed ? 'check_failed' : 'never_checked',
    paths: state.paths
  }
}
