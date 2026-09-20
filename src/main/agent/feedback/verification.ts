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

import {
  SKIPPED_CHECK_RE,
  diagnosticsCheckClean,
  isCheckResult,
  runTestsCheckClean
} from '../runReceipt'

/**
 * Cap on the witnessed-path list. It is a sample for the gate message, not the
 * mutation set: only edit-family tool calls carry a path argument, so a
 * checkpoint-detected mutation (terminal write, MCP writer, merge, watcher)
 * sets `mutated` while contributing nothing here.
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
  noteToolResult(toolName: string | undefined, content: string, ok: boolean): void
  /**
   * End-of-step reconciliation against the invoke write checkpoint — the
   * authoritative mutation signal. The edit-family tool names above miss
   * terminal writes (`sed -i`, redirects, `rm`), MCP writers, merges and
   * watched out-of-band changes, all of which do reach the checkpoint.
   *
   * Pass `undefined` when no checkpoint session is open; the observation is
   * then skipped rather than read as the count shrinking to zero.
   *
   * `checkpointId` matters: `flushWriteCheckpoint({reopen})` finalizes the
   * session and starts a fresh one with an empty file set at every follow-up
   * and goal-continue boundary. Without re-baselining on a new id, the old
   * high-water mark would swallow every later mutation in the run.
   */
  noteCheckpointFileCount(count: number | undefined, checkpointId?: string): void
  state(): VerificationState
}

export function createVerificationTracker(): VerificationTracker {
  let seq = 0
  let lastMutationSeq: number | null = null
  let lastCheckSeq: number | null = null
  let lastCheckClean: boolean | null = null
  let lastCheckpointFileCount = 0
  let lastCheckpointId: string | undefined
  /** Reset each step; guards the end-of-step stamp below. */
  let mutatedThisStep = false
  const paths: string[] = []

  return {
    noteMutation(path, ok) {
      // A refused or failed write changed nothing — counting it would demand
      // verification of work that never landed.
      if (!ok) return
      seq += 1
      lastMutationSeq = seq
      mutatedThisStep = true
      if (path && paths.length < WITNESSED_PATH_CAP && !paths.includes(path)) {
        paths.push(path)
      }
    },

    noteCheckpointFileCount(count, checkpointId) {
      // Reset first and unconditionally: an absent session must still close
      // the step, or the flag leaks forward and suppresses the next step's
      // checkpoint stamp.
      const toolStamped = mutatedThisStep
      mutatedThisStep = false
      if (count == null) return
      if (checkpointId !== undefined && checkpointId !== lastCheckpointId) {
        // Re-anchored session: its file set restarts empty, so the previous
        // high-water mark is meaningless against it.
        lastCheckpointId = checkpointId
        lastCheckpointFileCount = 0
      }
      const grew = count > lastCheckpointFileCount
      lastCheckpointFileCount = Math.max(lastCheckpointFileCount, count)
      // Only stamp when no tool call already did. Otherwise an edit and a
      // clean diagnostics in the SAME step would be re-ordered into
      // "mutated after the check" and wrongly read as unverified.
      if (grew && !toolStamped) {
        seq += 1
        lastMutationSeq = seq
      }
    },

    noteToolResult(toolName, content, ok) {
      if (!isCheckResult(toolName) || ok === false) return
      // The run_tests skip result reports ok=true with no runner — it verified
      // nothing, so it must not stamp the verified state.
      if (SKIPPED_CHECK_RE.test(content.trim())) return
      seq += 1
      lastCheckSeq = seq
      lastCheckClean =
        toolName === 'run_tests' ? runTestsCheckClean(content) : diagnosticsCheckClean(content)
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
