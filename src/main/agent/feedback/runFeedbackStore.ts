/**
 * Per-workspace run feedback store.
 *
 * Receipts are per-run, rewritten in place every few steps, and deleted with
 * their session directory — so nothing in the app can see that the same
 * failure has now happened four times, or that the user marked three runs
 * unhelpful. This store is the durable, workspace-scoped memory of that.
 *
 * Deliberately rebuildable and disposable: any unreadable or unknown-version
 * file is replaced with an empty store rather than migrated. It holds no
 * billing totals and nothing that cannot be re-observed, so a carry-forward
 * migration chain (as `loopCheckpoint.json` needs) would be cost without
 * benefit.
 */

import { existsSync, readFileSync } from 'fs'
import type { RunReceipt } from '../../../shared/ipc'
import {
  RUN_FEEDBACK_CLUSTERS_PER_ENTRY,
  RUN_FEEDBACK_MAX_ENTRIES,
  RUN_FEEDBACK_RECENT_SLOTS,
  RUN_FEEDBACK_VERSION,
  RunFeedbackStoreSchema,
  type RunFeedbackEntry,
  type RunFeedbackRating,
  type RunFeedbackStore
} from '../../../shared/ipc'
import { atomicWriteJson } from '../../storage/atomicWrite'
import { workspaceRunFeedbackPath } from '../../storage/paths'
import { logger } from '../../../shared/logger'

function emptyStore(): RunFeedbackStore {
  return { version: RUN_FEEDBACK_VERSION, updatedAt: new Date().toISOString(), entries: [] }
}

/** Never throws. An unreadable, corrupt or unknown-version file reads as empty. */
export function loadRunFeedbackStore(workspacePath: string): RunFeedbackStore {
  const path = workspaceRunFeedbackPath(workspacePath)
  if (!existsSync(path)) return emptyStore()
  try {
    const parsed = RunFeedbackStoreSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data : emptyStore()
  } catch {
    return emptyStore()
  }
}

/**
 * Newest first, capped, with the tail split between recency and human verdicts.
 *
 * The newest `RUN_FEEDBACK_RECENT_SLOTS` are kept unconditionally, so a new run
 * can always be recorded. Only the slots past that floor prefer rated entries,
 * on the grounds that an unrated entry is reconstructible from its receipt and
 * a human verdict is not. Preferring ratings all the way up would let a
 * workspace with a full set of rated entries reject every subsequent run —
 * exactly the runs the store exists to remember.
 */
function prune(entries: RunFeedbackEntry[]): RunFeedbackEntry[] {
  const byRecency = [...entries].sort((a, b) => b.at.localeCompare(a.at))
  if (byRecency.length <= RUN_FEEDBACK_MAX_ENTRIES) return byRecency

  const recent = byRecency.slice(0, RUN_FEEDBACK_RECENT_SLOTS)
  const rest = byRecency.slice(RUN_FEEDBACK_RECENT_SLOTS)
  const reserve = [...rest.filter((e) => e.rating), ...rest.filter((e) => !e.rating)].slice(
    0,
    RUN_FEEDBACK_MAX_ENTRIES - RUN_FEEDBACK_RECENT_SLOTS
  )
  return [...recent, ...reserve].sort((a, b) => b.at.localeCompare(a.at))
}

/**
 * Read-modify-write in one synchronous critical section. Electron main is
 * single-threaded and there is no `await` between the read and the write, so
 * two runs finishing together cannot interleave. Do not make this async
 * without adding a per-workspace lock.
 */
function commit(workspacePath: string, mutate: (entries: RunFeedbackEntry[]) => RunFeedbackEntry[]): RunFeedbackStore {
  const current = loadRunFeedbackStore(workspacePath)
  const next: RunFeedbackStore = {
    version: RUN_FEEDBACK_VERSION,
    updatedAt: new Date().toISOString(),
    entries: prune(mutate(current.entries))
  }
  atomicWriteJson(workspaceRunFeedbackPath(workspacePath), next)
  return next
}

function entryFromReceipt(receipt: RunReceipt): RunFeedbackEntry | null {
  // Only terminal outcomes carry signal. A cancel is the user stopping work,
  // not the agent failing at it, and `running` is an interim receipt.
  if (receipt.status !== 'done' && receipt.status !== 'error') return null
  return {
    runId: receipt.runId,
    at: receipt.writtenAt,
    status: receipt.status,
    ...(receipt.goal ? { title: receipt.goal.slice(0, 160) } : {}),
    ...(receipt.verificationGate?.wouldFire ? { unchecked: true } : {}),
    failureClusters: receipt.failureClusters
      .slice(0, RUN_FEEDBACK_CLUSTERS_PER_ENTRY)
      .map((cluster) => ({ key: cluster.key.slice(0, 200), count: cluster.count }))
  }
}

/**
 * Fold a finished run into the store. Best-effort: it runs inside the agent
 * loop's teardown, where a throw would be misattributed to the status write.
 *
 * Keyed on `runId`, so the interim receipts written every few steps and the
 * final one cannot double-count, and a user rating set before teardown is
 * preserved rather than clobbered by the deterministic fields.
 */
export function recordRunFeedbackBestEffort(input: {
  workspacePath: string
  receipt: RunReceipt | null
  inlineInstance: boolean
}): void {
  // A child instance's receipt is the parent's business, not the workspace's.
  if (!input.receipt || input.inlineInstance) return
  const fresh = entryFromReceipt(input.receipt)
  if (!fresh) return
  try {
    commit(input.workspacePath, (entries) => {
      const prior = entries.find((e) => e.runId === fresh.runId)
      const merged: RunFeedbackEntry = prior
        ? {
            ...fresh,
            ...(prior.rating ? { rating: prior.rating } : {}),
            ...(prior.note ? { note: prior.note } : {}),
            ...(prior.ratedAt ? { ratedAt: prior.ratedAt } : {})
          }
        : fresh
      return [merged, ...entries.filter((e) => e.runId !== fresh.runId)]
    })
  } catch (err) {
    logger.warn('Failed to record run feedback', {
      scope: 'agent',
      correlationId: input.receipt.runId,
      err
    })
  }
}

export function getRunFeedbackEntry(
  workspacePath: string,
  runId: string
): RunFeedbackEntry | null {
  return loadRunFeedbackStore(workspacePath).entries.find((e) => e.runId === runId) ?? null
}

/**
 * Apply a user verdict. Creates a stub entry when the run has not finished
 * yet — teardown then merges its deterministic fields in without clobbering
 * the rating.
 */
export function setRunFeedbackRating(input: {
  workspacePath: string
  runId: string
  rating: RunFeedbackRating | null
  note?: string
}): RunFeedbackEntry {
  const at = new Date().toISOString()
  let result!: RunFeedbackEntry
  commit(input.workspacePath, (entries) => {
    const prior = entries.find((e) => e.runId === input.runId)
    // Stub for the narrow race where a rating lands before teardown wrote the
    // entry. `status` is a placeholder: the UI only offers rating on finished
    // done/error runs, and teardown's merge spreads the real receipt fields
    // over this, correcting it.
    const base: RunFeedbackEntry = prior ?? {
      runId: input.runId,
      at,
      status: 'done',
      failureClusters: []
    }
    const note = input.note?.trim()
    result = {
      ...base,
      ...(input.rating ? { rating: input.rating, ratedAt: at } : {}),
      ...(note ? { note } : {})
    }
    // Clearing the rating clears its timestamp and note with it — a note
    // without a verdict is an orphan nobody surfaces.
    if (!input.rating) {
      delete result.rating
      delete result.ratedAt
      if (!note) delete result.note
    }
    return [result, ...entries.filter((e) => e.runId !== input.runId)]
  })
  return result
}
