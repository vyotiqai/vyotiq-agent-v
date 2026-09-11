import { existsSync, readdirSync, readFileSync } from 'fs'
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
import { readUsageLedger } from './usageLedger'
import { workspaceSessionsRoot } from '../storage/paths'
import { migrateLegacyReceipt } from './harnessReview'
import { RUN_RECEIPT_FILENAME } from './runReceipt'

/** Activity window (local days) — the Home panel renders exactly this axis. */
export const ACTIVITY_WINDOW_DAYS = 7

/** Read one receipt best-effort — corrupt or foreign files are skipped. */
function readReceipt(runDir: string): RunReceipt | null {
  const path = join(runDir, RUN_RECEIPT_FILENAME)
  if (!existsSync(path)) return null
  try {
    const parsed = RunReceiptSchema.safeParse(
      migrateLegacyReceipt(JSON.parse(readFileSync(path, 'utf8')))
    )
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
function readRunStatus(runDir: string) {
  const statusPath = join(runDir, 'status.json')
  if (!existsSync(statusPath)) return null
  try {
    const parsed = RunStatusSchema.safeParse(JSON.parse(readFileSync(statusPath, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function isInlineInstance(runDir: string): boolean {
  return readRunStatus(runDir)?.inlineInstance === true
}

/**
 * Cost fallback for interrupted legacy runs: a run whose loop never unwound
 * normally keeps its durable checkpoint (completed runs clear it) and may
 * predate the receipt cost field. Only a positive reported cost counts.
 */
function readInterruptedCost(runDir: string): number | undefined {
  const path = join(runDir, 'loopCheckpoint.json')
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { usageTotals?: unknown }
    const t = raw?.usageTotals
    if (!t || typeof t !== 'object') return undefined
    const cost = (t as { billedCost?: unknown }).billedCost
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
export function collectHomeActivity(
  workspacePaths: readonly string[],
  now = new Date(),
  windowDays: number = ACTIVITY_WINDOW_DAYS
): HomeActivityResult {
  const todayKey = localDayKeyOf(now.toISOString())
  const windowKeys = new Set(lastDayKeys(todayKey, windowDays))
  const days = new Map<string, HomeActivityDay>()
  /** Distinct parent runs with in-window activity — the honest session count. */
  const activeRunIds = new Set<string>()
  const outcomes = { done: 0, error: 0, cancelled: 0, running: 0 }
  let billedInputTokens = 0
  let outputTokens = 0
  let billedCostTotal = 0
  let withCost = false
  let cachedInputTokens = 0
  let withCache = false
  let reasoningTokensTotal = 0
  let withReasoning = false
  let peakInputTokensTotal = 0
  let peakContextWindow = 0
  let withPeak = false
  let withContextWindow = false
  /** Per-workspace usage slices (rendered only for multi-workspace requests). */
  const workspaceSlices = new Map<
    string,
    { path: string; runs: Set<string>; billedInputTokens: number; outputTokens: number; billedCost: number; withCost: boolean }
  >()
  /** Previous equal-length window totals — the trend signal (tokens). */
  const previousKeys = new Set(lastDayKeys(localDayKeyOf(new Date(now.getTime() - windowDays * 86_400_000).toISOString()), windowDays))
  let previousTokens = 0
  /** Attention signals: unverified runs (receipt-scoped) + window tool usage. */
  let unverifiedRuns = 0
  const toolTotals = new Map<string, { ok: number; failed: number }>()
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
        withCost: false
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
      cachedInputTokens?: number
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
    }
  ): void => {
    activeRunIds.add(runId)
    // Per-day distinct-run count: one usage attribution per run per day.
    day.runs += 1
    day.billedInputTokens += usage.inputTokens
    day.outputTokens += usage.outputTokens
    billedInputTokens += usage.inputTokens
    outputTokens += usage.outputTokens
    if (usage.billedCost != null && usage.billedCost > 0) {
      day.billedCost = (day.billedCost ?? 0) + usage.billedCost
      billedCostTotal += usage.billedCost
      withCost = true
      if (slice) {
        slice.billedCost += usage.billedCost
        slice.withCost = true
      }
    }
    if (usage.cachedInputTokens != null && usage.cachedInputTokens > 0) {
      cachedInputTokens += usage.cachedInputTokens
      withCache = true
    }
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

  for (const workspacePath of workspacePaths) {
    const root = workspaceSessionsRoot(workspacePath)
    if (!existsSync(root)) continue
    let dirs: string[]
    try {
      dirs = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      continue
    }
    for (const runId of dirs) {
      const runDir = join(root, runId)
      if (isInlineInstance(runDir)) continue
      const receipt = readReceipt(runDir)
      const slice = workspacePaths.length > 1 ? sliceFor(workspacePath) : undefined

      // Ledger-first attribution: per-day deltas recorded while the run
      // executed (live runs update this every step — the panel stays live).
      const ledger = readUsageLedger(runDir)
      if (ledger) {
        for (const [date, entry] of Object.entries(ledger.days)) {
          if (previousKeys.has(date)) {
            previousTokens += entry.inputTokens + entry.outputTokens
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
              cachedInputTokens: entry.cachedInputTokens,
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
        if (readRunStatus(runDir)?.status === 'running') outcomes.running += 1
        continue
      }
      const receiptDate = localDayKeyOf(receipt.writtenAt)
      const receiptInWindow = windowKeys.has(receiptDate)
      if (receiptInWindow) {
        outcomes[receipt.status] += 1
        if (receipt.verification?.verifiedAfterLastMutation === false) {
          unverifiedRuns += 1
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
          for (const [name, stat] of Object.entries(receipt.toolStats.byName)) {
            const entry = toolTotals.get(name) ?? { ok: 0, failed: 0 }
            entry.ok += stat.ok
            entry.failed += stat.failed
            toolTotals.set(name, entry)
          }
        }
      }

      if (ledger) continue // fully attributed by the ledger
      // Legacy run without a ledger: fall back to the receipt's cumulative
      // totals, attributed to the day the receipt was written. Cost falls back
      // to the receipt field, then the interrupted-run checkpoint.
      const day = receiptDate ? bucketFor(receiptDate) : null
      const usage = receipt.tokenUsage
      const billedCost = receipt.billedCost ?? readInterruptedCost(runDir)
      if (day) {
        addUsage(
          day,
          runId,
          {
            inputTokens: usage?.billedInputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            billedCost,
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
    ...(slice.withCost ? { billedCost: slice.billedCost } : {})
  }))
  // Top tools across window receipts — only when receipts recorded tool calls.
  const topTools = [...toolTotals.entries()]
    .map(([name, totals]) => ({ name, ...totals }))
    .sort((a, b) => b.ok + b.failed - (a.ok + a.failed))
    .slice(0, 5)
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
            ...(topTools.length > 0 ? { topTools } : {})
          }
        }
      : {}),
    outcomes,
    totals: {
      runs: activeRunIds.size,
      billedInputTokens,
      outputTokens,
      ...(withCost ? { billedCost: billedCostTotal } : {}),
      ...(withCache ? { cachedInputTokens } : {}),
      ...(withReasoning ? { reasoningTokens: reasoningTokensTotal } : {}),
      ...(withPeak ? { peakInputTokens: peakInputTokensTotal } : {}),
      ...(withContextWindow ? { contextWindow: peakContextWindow } : {}),
      ...(previousTokens > 0 ? { previousTokens } : {})
    },
    generatedAt: now.toISOString()
  })
}
