import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import {
  HomeActivityResultSchema,
  RunReceiptSchema,
  RunStatusSchema,
  type HomeActivityResult,
  type HomeActivityDay
} from '@shared/ipc'
import type { RunReceipt } from '@shared/ipc'
import { lastDayKeys, localDayKeyOf } from '../../shared/utils/localDay'
import { readUsageLedgerAsync } from './usageLedger'
import { workspaceSessionsRoot } from '../storage/paths'
import { migrateLegacyReceipt } from './harnessReview'
import { RUN_RECEIPT_FILENAME } from './runReceipt'
import { readJsonDocCached } from './jsonDocCache'

/** Activity window (local days) — the Home panel renders exactly this axis. */
export const ACTIVITY_WINDOW_DAYS = 7

/** Read one receipt best-effort — corrupt or foreign files are skipped. */
async function readReceipt(runDir: string): Promise<RunReceipt | null> {
  const path = join(runDir, RUN_RECEIPT_FILENAME)
  const doc = await readJsonDocCached(path)
  if (!doc.ok) return null
  try {
    const parsed = RunReceiptSchema.safeParse(migrateLegacyReceipt(doc.doc))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Inline agent instances write their own receipt under the same sessions root;
 * `status.json` marks them. Without this filter one parent session counts as
 * many "sessions" on Home (instances stay folded under the parent in the
 * sidebar — Home must match that view).
 */
async function readRunStatus(runDir: string) {
  const statusPath = join(runDir, 'status.json')
  const doc = await readJsonDocCached(statusPath)
  if (!doc.ok) return null
  try {
    const parsed = RunStatusSchema.safeParse(doc.doc)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Cost fallback for interrupted legacy runs: a run whose loop never unwound
 * normally keeps its durable checkpoint (completed runs clear it) and may
 * predate the receipt cost field. Only a positive reported cost counts.
 */
async function readInterruptedCost(runDir: string): Promise<number | undefined> {
  const path = join(runDir, 'loopCheckpoint.json')
  const doc = await readJsonDocCached(path)
  if (!doc.ok) return undefined
  try {
    const raw = doc.doc as { usageTotals?: unknown }
    const t = raw?.usageTotals
    if (!t || typeof t !== 'object') return undefined
    const cost = (t as { billedCost?: unknown }).billedCost
    return typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? cost : undefined
  } catch {
    return undefined
  }
}

/**
 * Estimated-cost fallback for interrupted runs, mirroring `readInterruptedCost`
 * for runs whose provider never reported a bill. Checkpoints written before
 * estimate tracking simply lack the field → undefined, never a fake 0.
 */
async function readInterruptedEstimatedCost(runDir: string): Promise<number | undefined> {
  const path = join(runDir, 'loopCheckpoint.json')
  const doc = await readJsonDocCached(path)
  if (!doc.ok) return undefined
  try {
    const raw = doc.doc as { usageTotals?: unknown }
    const t = raw?.usageTotals
    if (!t || typeof t !== 'object') return undefined
    const cost = (t as { estimatedCost?: unknown }).estimatedCost
    return typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? cost : undefined
  } catch {
    return undefined
  }
}

function blankDay(date: string): HomeActivityDay {
  return { date, runs: 0, billedInputTokens: 0, outputTokens: 0 }
}

/**
 * Aggregate real persisted usage into a bounded local-day window.
 *
 * Attribution is ledger-first: every agent step records its usage delta into
 * the run's `usage.json` day buckets (`recordUsageDeltas`), so a multi-day run
 * bills each day for what it actually spent that day. Receipts carry
 * outcomes, model tags, and a cost/usage fallback for runs that predate the
 * ledger (their whole cumulative total lands on the day their receipt was
 * written — labeled accordingly upstream).
 *
 * Inline agent instances are excluded (Home shows parent sessions, like the
 * sidebar). Receiptless run dirs count as running; their live per-step ledger
 * keeps the panel current while they run. Days without activity never appear;
 * cost/cache appear only when reported — never fake zeros.
 */
export async function collectHomeActivity(
  workspacePaths: readonly string[],
  now = new Date(),
  windowDays: number = ACTIVITY_WINDOW_DAYS
): Promise<HomeActivityResult> {
  const todayKey = localDayKeyOf(now.toISOString())
  const windowKeys = new Set(lastDayKeys(todayKey, windowDays))
  const days = new Map<string, HomeActivityDay>()
  /** Distinct parent runs with in-window activity — the honest session count. */
  const activeRunIds = new Set<string>()
  /** Runs any of whose usage carried a bill or an estimate. */
  const pricedRunIds = new Set<string>()
  const outcomes = { done: 0, error: 0, cancelled: 0, running: 0 }
  let billedInputTokens = 0
  let outputTokens = 0
  let billedCostTotal = 0
  let withCost = false
  let estimatedCostTotal = 0
  let withEstimate = false
  let cachedInputTokens = 0
  let withCache = false
  /** Whole-prompt tokens in the window, and whether any tokens lacked one. */
  let promptInputTokens = 0
  let promptUntracked = false
  let reasoningTokensTotal = 0
  let withReasoning = false
  let peakInputTokensTotal = 0
  let peakContextWindow = 0
  let withPeak = false
  let withContextWindow = false
  /** Per-workspace usage slices (rendered only for multi-workspace requests). */
  const workspaceSlices = new Map<
    string,
    {
      path: string
      runs: Set<string>
      billedInputTokens: number
      outputTokens: number
      billedCost: number
      withCost: boolean
      estimatedCost: number
      withEstimate: boolean
    }
  >()
  /** Previous equal-length window totals — the trend signal (tokens). */
  const previousKeys = new Set(lastDayKeys(localDayKeyOf(new Date(now.getTime() - windowDays * 86_400_000).toISOString()), windowDays))
  let previousTokens = 0
  /** Distinct runs with activity in the previous window — the trend signal (tasks). */
  const previousRunIds = new Set<string>()
  /**
   * Prune cutoff: the earliest local-day start the aggregation can still see
   * (the previous window feeds the token trend). Run-dir files last written
   * before it cannot contribute ledger days, receipt outcomes, or legacy
   * usage — their only possible contribution is the receiptless-running
   * rule, which the scan evaluates explicitly. Unparseable earliest key
   * disables pruning rather than guessing.
   */
  let cutoffMs = Number.NaN
  {
    let earliest: string | null = null
    for (const key of previousKeys) {
      if (earliest === null || key < earliest) earliest = key
    }
    if (earliest) {
      const parsed = new Date(`${earliest}T00:00:00`)
      if (!Number.isNaN(parsed.getTime())) cutoffMs = parsed.getTime()
    }
  }
  /** Attention signals: unverified runs (receipt-scoped) + window tool usage. */
  let unverifiedRuns = 0
  const toolTotals = new Map<string, { ok: number; failed: number }>()
  /** Tool calls in window receipts (stubs and gate refusals are not calls). */
  let toolCalls = 0
  /** Per tool, how often each failure message came back — the commonest is its reason. */
  const failureReasons = new Map<string, Map<string, number>>()
  /** Runs whose edits had no passing check after them. */
  const uncheckedRuns: Array<{ runId: string; workspacePath: string; goal?: string; files: number; writtenAt: string }> = []
  /** Sessions that ended in error — the newest few become the digest (real goals only). */
  const errorRuns: Array<{ runId: string; workspacePath: string; goal?: string; writtenAt: string }> = []

  const sliceFor = (workspacePath: string) => {
    let slice = workspaceSlices.get(workspacePath)
    if (!slice) {
      slice = {
        path: workspacePath,
        runs: new Set(),
        billedInputTokens: 0,
        outputTokens: 0,
        billedCost: 0,
        withCost: false,
        estimatedCost: 0,
        withEstimate: false
      }
      workspaceSlices.set(workspacePath, slice)
    }
    return slice
  }

  const bucketFor = (date: string): HomeActivityDay | null => {
    if (!windowKeys.has(date)) return null
    let day = days.get(date)
    if (!day) {
      day = blankDay(date)
      days.set(date, day)
    }
    return day
  }

  const addUsage = (
    day: HomeActivityDay,
    runId: string,
    usage: {
      inputTokens: number
      outputTokens: number
      billedCost?: number
      estimatedCost?: number
      cachedInputTokens?: number
      promptInputTokens?: number
      model?: string
      reasoningTokens?: number
      peakInputTokens?: number
      contextWindow?: number
    },
    slice?: {
      runs: Set<string>
      billedInputTokens: number
      outputTokens: number
      billedCost: number
      withCost: boolean
      estimatedCost: number
      withEstimate: boolean
    }
  ): void => {
    activeRunIds.add(runId)
    // Per-day distinct-run count: one usage attribution per run per day.
    day.runs += 1
    day.billedInputTokens += usage.inputTokens
    day.outputTokens += usage.outputTokens
    billedInputTokens += usage.inputTokens
    outputTokens += usage.outputTokens
    if ((usage.billedCost ?? 0) > 0 || (usage.estimatedCost ?? 0) > 0) pricedRunIds.add(runId)
    if (usage.billedCost != null && usage.billedCost > 0) {
      day.billedCost = (day.billedCost ?? 0) + usage.billedCost
      billedCostTotal += usage.billedCost
      withCost = true
      if (slice) {
        slice.billedCost += usage.billedCost
        slice.withCost = true
      }
    }
    if (usage.estimatedCost != null && usage.estimatedCost > 0) {
      day.estimatedCost = (day.estimatedCost ?? 0) + usage.estimatedCost
      estimatedCostTotal += usage.estimatedCost
      withEstimate = true
      if (slice) {
        slice.estimatedCost += usage.estimatedCost
        slice.withEstimate = true
      }
    }
    if (usage.cachedInputTokens != null && usage.cachedInputTokens > 0) {
      cachedInputTokens += usage.cachedInputTokens
      withCache = true
    }
    if (usage.promptInputTokens != null) promptInputTokens += usage.promptInputTokens
    else if (usage.inputTokens > 0) promptUntracked = true
    if (usage.reasoningTokens != null && usage.reasoningTokens > 0) {
      day.reasoningTokens = (day.reasoningTokens ?? 0) + usage.reasoningTokens
      reasoningTokensTotal += usage.reasoningTokens
      withReasoning = true
    }
    if (usage.peakInputTokens != null && usage.peakInputTokens > 0) {
      day.peakInputTokens = Math.max(day.peakInputTokens ?? 0, usage.peakInputTokens)
      if (usage.peakInputTokens >= peakInputTokensTotal) {
        peakInputTokensTotal = usage.peakInputTokens
        if (usage.contextWindow != null && usage.contextWindow > 0) {
          peakContextWindow = usage.contextWindow
          withContextWindow = true
        }
      }
      withPeak = true
    }
    if (usage.contextWindow != null && usage.contextWindow > 0) {
      day.contextWindow = usage.contextWindow
    }
    if (usage.model && usage.outputTokens > 0) {
      day.byModel = {
        ...day.byModel,
        [usage.model]: (day.byModel?.[usage.model] ?? 0) + usage.outputTokens
      }
    }
    if (slice) {
      slice.runs.add(runId)
      slice.billedInputTokens += usage.inputTokens
      slice.outputTokens += usage.outputTokens
    }
  }

  /**
   * True when any aggregate-relevant file in the run dir was written on or
   * after the cutoff. Everything older can only matter through the
   * receiptless-running rule, which the caller evaluates explicitly.
   */
  const hasRecentDoc = async (runDir: string): Promise<boolean> => {
    if (!Number.isFinite(cutoffMs)) return true
    for (const name of ['status.json', RUN_RECEIPT_FILENAME, 'usage.json']) {
      try {
        if ((await stat(join(runDir, name))).mtimeMs >= cutoffMs) return true
      } catch {
        // Missing file — it cannot make the dir recent by itself.
      }
    }
    return false
  }

  for (const workspacePath of workspacePaths) {
    const root = workspaceSessionsRoot(workspacePath)
    let dirs: string[]
    try {
      dirs = (await readdir(root, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      continue
    }
    for (const runId of dirs) {
      const runDir = join(root, runId)
      const status = await readRunStatus(runDir)
      if (status?.inlineInstance === true) continue

      // Window pruning: a dir whose aggregate files all predate the previous
      // window's start contributes nothing except a receiptless `running`
      // status (which counts regardless of window) — evaluate just that.
      if (!(await hasRecentDoc(runDir))) {
        if (status?.status === 'running' && !(await readReceipt(runDir))) {
          outcomes.running += 1
        }
        continue
      }

      const receipt = await readReceipt(runDir)
      const slice = workspacePaths.length > 1 ? sliceFor(workspacePath) : undefined

      // Ledger-first attribution: per-day deltas recorded while the run
      // executed (live runs update this every step — the panel stays live).
      const ledger = await readUsageLedgerAsync(runDir)
      if (ledger) {
        for (const [date, entry] of Object.entries(ledger.days)) {
          if (previousKeys.has(date)) {
            previousTokens += entry.inputTokens + entry.outputTokens
            previousRunIds.add(runId)
            continue
          }
          const day = bucketFor(date)
          if (!day) continue
          addUsage(
            day,
            runId,
            {
              inputTokens: entry.inputTokens,
              outputTokens: entry.outputTokens,
              billedCost: entry.billedCost,
              estimatedCost: entry.estimatedCost,
              cachedInputTokens: entry.cachedInputTokens,
              promptInputTokens: entry.promptInputTokens,
              model: receipt?.model,
              reasoningTokens: entry.reasoningTokens,
              peakInputTokens: entry.peakInputTokens,
              contextWindow: entry.contextWindow
            },
            slice
          )
        }
      }

      if (!receipt) {
        if (status?.status === 'running') outcomes.running += 1
        continue
      }
      const receiptDate = localDayKeyOf(receipt.writtenAt)
      const receiptInWindow = windowKeys.has(receiptDate)
      if (receiptInWindow) {
        outcomes[receipt.status] += 1
        // Prefer the gate's verdict: it is the guarded one, so it excludes
        // plan-mode and cancelled runs, and — unlike the raw receipt field —
        // a read-only turn whose check merely failed, which mutated nothing
        // and so has nothing to verify. Older receipts predate the field and
        // keep the legacy reading rather than being back-inferred.
        const unverified = receipt.verificationGate
          ? receipt.verificationGate.wouldFire
          : receipt.verification?.verifiedAfterLastMutation === false
        if (unverified) {
          unverifiedRuns += 1
          uncheckedRuns.push({
            runId: receipt.runId,
            workspacePath,
            ...(receipt.goal ? { goal: receipt.goal } : {}),
            files: new Set(receipt.wroteFiles).size,
            writtenAt: receipt.writtenAt
          })
        }
        if (receipt.status === 'error') {
          errorRuns.push({
            runId: receipt.runId,
            workspacePath,
            ...(receipt.goal ? { goal: receipt.goal } : {}),
            writtenAt: receipt.writtenAt
          })
        }
        if (receipt.toolStats.totalCalls > 0) {
          toolCalls += receipt.toolStats.totalCalls
          for (const [name, toolStat] of Object.entries(receipt.toolStats.byName)) {
            const entry = toolTotals.get(name) ?? { ok: 0, failed: 0 }
            entry.ok += toolStat.ok
            entry.failed += toolStat.failed
            toolTotals.set(name, entry)
          }
        }
        // Clusters are keyed "tool: message" (runReceipt's failure scan).
        for (const cluster of receipt.failureClusters) {
          const split = cluster.key.indexOf(': ')
          if (split <= 0) continue
          const tool = cluster.key.slice(0, split)
          const message = cluster.key.slice(split + 2).trim()
          if (!message || message === '(no message)') continue
          const byMessage = failureReasons.get(tool) ?? new Map<string, number>()
          byMessage.set(message, (byMessage.get(message) ?? 0) + cluster.count)
          failureReasons.set(tool, byMessage)
        }
      }

      if (ledger) continue // fully attributed by the ledger
      if (previousKeys.has(receiptDate)) previousRunIds.add(runId)
      // Legacy run without a ledger: fall back to the receipt's cumulative
      // totals, attributed to the day the receipt was written. Cost falls back
      // to the receipt field, then the interrupted-run checkpoint.
      const day = receiptDate ? bucketFor(receiptDate) : null
      const usage = receipt.tokenUsage
      const billedCost = receipt.billedCost ?? (await readInterruptedCost(runDir))
      const estimatedCost =
        receipt.estimatedCost ?? (await readInterruptedEstimatedCost(runDir))
      if (day) {
        addUsage(
          day,
          runId,
          {
            inputTokens: usage?.billedInputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            billedCost,
            estimatedCost,
            cachedInputTokens: usage?.cachedInputTokens,
            model: receipt.model,
            reasoningTokens: usage?.reasoningTokens,
            peakInputTokens: usage?.peakInputTokens,
            contextWindow: receipt.contextWindow
          },
          slice
        )
      }
    }
  }

  const sortedDays = [...days.values()].sort((a, b) => a.date.localeCompare(b.date))
  const slices = [...workspaceSlices.values()].map((slice) => ({
    path: slice.path,
    runs: slice.runs.size,
    billedInputTokens: slice.billedInputTokens,
    outputTokens: slice.outputTokens,
    ...(slice.withCost ? { billedCost: slice.billedCost } : {}),
    ...(slice.withEstimate ? { estimatedCost: slice.estimatedCost } : {})
  }))
  // Top tools across window receipts — only when receipts recorded tool calls.
  const topTools = [...toolTotals.entries()]
    .map(([name, totals]) => ({ name, ...totals }))
    .sort((a, b) => b.ok + b.failed - (a.ok + a.failed))
    .slice(0, 5)
  // Failing tools — most failures first, each with the error it gave most.
  const failingTools = [...toolTotals.entries()]
    .filter(([, totals]) => totals.failed > 0)
    .sort(([nameA, a], [nameB, b]) => b.failed - a.failed || b.failed / (b.ok + b.failed) - a.failed / (a.ok + a.failed) || nameA.localeCompare(nameB))
    .slice(0, 5)
    .map(([name, totals]) => {
      const reasons = [...(failureReasons.get(name)?.entries() ?? [])].sort(
        ([messageA, countA], [messageB, countB]) => countB - countA || messageA.localeCompare(messageB)
      )
      const reason = reasons[0]?.[0]
      return { name, ok: totals.ok, failed: totals.failed, ...(reason ? { reason } : {}) }
    })
  const uncheckedDigest = uncheckedRuns
    .sort((a, b) => (a.writtenAt < b.writtenAt ? 1 : a.writtenAt > b.writtenAt ? -1 : 0))
    .slice(0, 5)
    .map(({ writtenAt: _writtenAt, ...run }) => run)
  // Error digest — newest first, capped at 3; rendered only when present.
  const errorDigest = errorRuns
    .sort((a, b) => (a.writtenAt < b.writtenAt ? 1 : a.writtenAt > b.writtenAt ? -1 : 0))
    .slice(0, 3)
    .map(({ runId, workspacePath, goal }) => ({ runId, workspacePath, ...(goal ? { goal } : {}) }))
  return HomeActivityResultSchema.parse({
    days: sortedDays,
    // Days in the window that show any activity — cadence/streak signal.
    activeDays: sortedDays.filter((day) => day.runs > 0 || day.billedInputTokens > 0 || day.outputTokens > 0).length,
    windowDays,
    ...(workspacePaths.length > 1 && slices.length > 0 ? { workspaces: slices } : {}),
    ...(unverifiedRuns > 0 || topTools.length > 0 || errorDigest.length > 0
      ? {
          attention: {
            unverifiedRuns,
            ...(errorDigest.length > 0 ? { errorRuns: errorDigest } : {}),
            ...(topTools.length > 0 ? { topTools } : {}),
            ...(toolCalls > 0 ? { toolCalls } : {}),
            ...(failingTools.length > 0 ? { failingTools } : {}),
            ...(uncheckedDigest.length > 0 ? { uncheckedRuns: uncheckedDigest } : {})
          }
        }
      : {}),
    outcomes,
    totals: {
      runs: activeRunIds.size,
      billedInputTokens,
      outputTokens,
      ...(withCost ? { billedCost: billedCostTotal } : {}),
      ...(withEstimate ? { estimatedCost: estimatedCostTotal } : {}),
      ...(withCost || withEstimate ? { pricedRuns: pricedRunIds.size } : {}),
      ...(withCache ? { cachedInputTokens } : {}),
      // Only when the provider reported cache reads: one that reports none
      // would read as a measured 0%, which it is not.
      ...(withCache && !promptUntracked && promptInputTokens > 0
        ? { cacheShare: Math.min(1, cachedInputTokens / promptInputTokens) }
        : {}),
      ...(withReasoning ? { reasoningTokens: reasoningTokensTotal } : {}),
      ...(withPeak ? { peakInputTokens: peakInputTokensTotal } : {}),
      ...(withContextWindow ? { contextWindow: peakContextWindow } : {}),
      ...(previousTokens > 0 ? { previousTokens } : {}),
      ...(previousRunIds.size > 0 ? { previousRuns: previousRunIds.size } : {})
    },
    generatedAt: now.toISOString()
  })
}
