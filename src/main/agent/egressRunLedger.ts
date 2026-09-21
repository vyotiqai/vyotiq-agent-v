import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { atomicWriteJsonAsync } from '../storage/atomicWrite'
import { resolveRunDir } from '../storage/paths'
import { workspacePathsEqual } from '../../shared/workspacePath'
import { logger } from '../../shared/logger'
import {
  onEgressRecorded,
  type EgressDenyReason,
  type EgressLedgerEntry,
  type EgressPurpose
} from '../net/egress'
import { listActiveRuns } from './runRegistry'

/**
 * Durable per-run record of where a run went on the network.
 *
 * The in-memory ledger in `net/egress.ts` is bounded and evaporates on restart,
 * which is the wrong lifetime for an audit trail — the question "what did this
 * run talk to?" is usually asked after something went wrong, often after a
 * crash. This module subscribes to the in-memory ledger and writes a per-run
 * summary next to the run's other records.
 *
 * Entries are aggregated per origin rather than appended per request: one page
 * load can issue hundreds of requests to the same CDN, and five hundred
 * identical rows answer no question that one row with a count does not.
 */

export const EGRESS_LEDGER_FILENAME = 'egress.json'

const EGRESS_RUN_LEDGER_VERSION = 1 as const

/**
 * Distinct origins retained per run. A run that touches more than this has a
 * pathology the first few hundred origins already document.
 */
export const MAX_ORIGINS_PER_RUN = 200

/** Quiet period before a run's pending changes are written. */
const FLUSH_DEBOUNCE_MS = 1000

export type EgressOriginRecord = {
  origin: string
  allowed: number
  denied: number
  purposes: EgressPurpose[]
  denyReasons: EgressDenyReason[]
  firstAt: number
  lastAt: number
}

export type EgressRunLedger = {
  version: typeof EGRESS_RUN_LEDGER_VERSION
  /** Sorted by origin so the file is stable across writes and diffable. */
  origins: EgressOriginRecord[]
  /** Origins dropped after the cap, so a truncated record says so. */
  truncated?: number
}

type PendingRun = {
  workspacePath: string
  origins: Map<string, EgressOriginRecord>
  dropped: number
  timer: ReturnType<typeof setTimeout> | null
  /** Serializes writes for one run so two flushes cannot interleave. */
  chain: Promise<void>
}

const pending = new Map<string, PendingRun>()
let unsubscribe: (() => void) | null = null

/** Resolve the run that owns an entry: explicit id, else the workspace's active run. */
function runForEntry(entry: EgressLedgerEntry): { runId: string; workspacePath: string } | null {
  if (entry.runId && entry.workspacePath) {
    return { runId: entry.runId, workspacePath: entry.workspacePath }
  }
  if (!entry.workspacePath) return null
  for (const run of listActiveRuns()) {
    if (workspacePathsEqual(run.workspacePath, entry.workspacePath)) {
      return { runId: run.runId, workspacePath: run.workspacePath }
    }
  }
  return null
}

function pushDistinct<T>(list: T[], value: T): void {
  if (!list.includes(value)) list.push(value)
}

export function recordEgressForRun(entry: EgressLedgerEntry): void {
  const owner = runForEntry(entry)
  // Egress outside any run (user browsing, app-level fetches) has no run file
  // to belong to; the in-memory ledger still holds it.
  if (!owner) return

  let run = pending.get(owner.runId)
  if (!run) {
    run = {
      workspacePath: owner.workspacePath,
      origins: new Map(),
      dropped: 0,
      timer: null,
      chain: Promise.resolve()
    }
    pending.set(owner.runId, run)
  }

  let record = run.origins.get(entry.origin)
  if (!record) {
    if (run.origins.size >= MAX_ORIGINS_PER_RUN) {
      run.dropped += 1
      return
    }
    record = {
      origin: entry.origin,
      allowed: 0,
      denied: 0,
      purposes: [],
      denyReasons: [],
      firstAt: entry.at,
      lastAt: entry.at
    }
    run.origins.set(entry.origin, record)
  }

  if (entry.allowed) record.allowed += 1
  else {
    record.denied += 1
    pushDistinct(record.denyReasons, entry.reason as EgressDenyReason)
  }
  pushDistinct(record.purposes, entry.purpose)
  record.lastAt = entry.at

  scheduleFlush(owner.runId)
}

function scheduleFlush(runId: string): void {
  const run = pending.get(runId)
  if (!run || run.timer) return
  run.timer = setTimeout(() => {
    run.timer = null
    void flushRun(runId)
  }, FLUSH_DEBOUNCE_MS)
  // A pending write must never hold the process open on quit.
  run.timer.unref?.()
}

function snapshotOf(run: PendingRun): EgressRunLedger {
  const origins = [...run.origins.values()].sort((a, b) => a.origin.localeCompare(b.origin))
  return {
    version: EGRESS_RUN_LEDGER_VERSION,
    origins,
    ...(run.dropped > 0 ? { truncated: run.dropped } : {})
  }
}

function flushRun(runId: string): Promise<void> {
  const run = pending.get(runId)
  if (!run) return Promise.resolve()
  const snapshot = snapshotOf(run)
  run.chain = run.chain
    .then(async () => {
      const dir = resolveRunDir(run.workspacePath, runId)
      await atomicWriteJsonAsync(join(dir, EGRESS_LEDGER_FILENAME), snapshot)
    })
    .catch((err: unknown) => {
      // A lost audit write is worth a log line, never a broken run.
      logger.warn('Failed to write egress ledger', { scope: 'agent', runId, err })
    })
  return run.chain
}

/** Write every pending run now — shutdown and tests. */
export async function flushEgressRunLedgers(): Promise<void> {
  const ids = [...pending.keys()]
  for (const runId of ids) {
    const run = pending.get(runId)
    if (run?.timer) {
      clearTimeout(run.timer)
      run.timer = null
    }
    await flushRun(runId)
  }
}

/** Read a run's egress record. Absent or unreadable → null. */
export function readEgressRunLedger(runDir: string): EgressRunLedger | null {
  const path = join(runDir, EGRESS_LEDGER_FILENAME)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as EgressRunLedger
    if (raw?.version !== EGRESS_RUN_LEDGER_VERSION || !Array.isArray(raw.origins)) return null
    return raw
  } catch {
    return null
  }
}

/** Subscribe to the in-memory ledger. Idempotent. */
export function startEgressRunLedger(): void {
  if (unsubscribe) return
  unsubscribe = onEgressRecorded(recordEgressForRun)
}

export function stopEgressRunLedgerForTests(): void {
  unsubscribe?.()
  unsubscribe = null
  for (const run of pending.values()) {
    if (run.timer) clearTimeout(run.timer)
  }
  pending.clear()
}
