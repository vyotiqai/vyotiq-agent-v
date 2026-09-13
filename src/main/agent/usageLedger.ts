import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { atomicWriteJson } from '../storage/atomicWrite'
import { localDayKeyOf } from '../../shared/utils/localDay'
import type { StepUsageTotals } from '../../shared/utils/runTelemetry'

export const USAGE_LEDGER_FILENAME = 'usage.json'

const USAGE_LEDGER_VERSION = 1 as const

/** One local-day bucket of recorded usage deltas for a run. */
export type UsageLedgerDay = {
  /** Sum of per-step billed input tokens recorded on this day. */
  inputTokens: number
  outputTokens: number
  /** Provider-reported cost deltas (may stay absent when never reported). */
  billedCost?: number
  cachedInputTokens?: number
  /** Billed thinking-token deltas recorded this day (subset of output). */
  reasoningTokens?: number
  /** Peak per-step context input seen this day (max across steps). */
  peakInputTokens?: number
  /** Raw model context window in effect at the last recorded step this day. */
  contextWindow?: number
}

export type UsageLedger = {
  version: typeof USAGE_LEDGER_VERSION
  /** Last recorded cumulative snapshot — deltas are current minus this. */
  lastTotals: {
    steps: number
    billedInputTokens: number
    outputTokens: number
    billedCost: number
    cachedInputTokens: number
    reasoningTokens: number
  }
  /** Local-day buckets keyed YYYY-MM-DD — only days with recorded deltas. */
  days: Record<string, UsageLedgerDay>
}

/** Read a run's usage ledger best-effort — absent/corrupt → null. */
export function readUsageLedger(runDir: string): UsageLedger | null {
  const path = join(runDir, USAGE_LEDGER_FILENAME)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as UsageLedger
    if (raw?.version !== USAGE_LEDGER_VERSION || typeof raw.days !== 'object') return null
    return raw
  } catch {
    return null
  }
}

/**
 * Record cumulative usage deltas for a run into its per-day ledger
 * (`usage.json` next to receipt.json). Called at every agent step and once at
 * terminal teardown; each call adds only what accumulated since the previous
 * one, attributed to the local day at record time — so a multi-day run bills
 * each day for what it actually spent that day instead of lumping its whole
 * history into the day its receipt was last written.
 *
 * `contextWindow` (raw model window at the recorded step) is optional; the
 * latest reported value per day feeds the context-pressure signal. Peak is
 * max-tracked per day from the run's cumulative peak (monotonic within a run).
 *
 * Best-effort and monotonic: a cumulative total that went backwards (fresh
 * re-seed after checkpoint loss) contributes nothing rather than a negative
 * delta. Never throws to callers.
 */
export function recordUsageDeltas(
  runDir: string,
  totals: StepUsageTotals,
  now = new Date(),
  contextWindow?: number
): void {
  try {
    const prev = readUsageLedger(runDir)
    const last = prev?.lastTotals ?? {
      steps: 0,
      billedInputTokens: 0,
      outputTokens: 0,
      billedCost: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0
    }

    const delta = (current: number, before: number): number => (current > before ? current - before : 0)
    const dInput = delta(totals.billedInputTokens, last.billedInputTokens)
    const dOutput = delta(totals.outputTokens, last.outputTokens)
    const dCost = delta(totals.billedCost, last.billedCost)
    const dCached = delta(totals.billedCachedInputTokens, last.cachedInputTokens)
    const dReasoning = delta(totals.reasoningTokens, last.reasoningTokens)
    // Nothing new to record — skip the write entirely (the snapshot only
    // matters when a later cumulative jump bills its actual delta).
    if (totals.steps === last.steps && dCost === 0) return

    const dateKey = localDayKeyOf(now.toISOString())
    if (!dateKey) return
    const days: Record<string, UsageLedgerDay> = { ...(prev?.days ?? {}) }
    const day: UsageLedgerDay = { ...(days[dateKey] ?? { inputTokens: 0, outputTokens: 0 }) }
    day.inputTokens += dInput
    day.outputTokens += dOutput
    if (dCost > 0) day.billedCost = (day.billedCost ?? 0) + dCost
    if (dCached > 0) day.cachedInputTokens = (day.cachedInputTokens ?? 0) + dCached
    if (dReasoning > 0) {
      day.reasoningTokens = (day.reasoningTokens ?? 0) + dReasoning
    }
    if (totals.peakInputTokens > 0) {
      day.peakInputTokens = Math.max(day.peakInputTokens ?? 0, totals.peakInputTokens)
    }
    if (contextWindow != null && contextWindow > 0) {
      day.contextWindow = contextWindow
    }
    days[dateKey] = day

    const ledger: UsageLedger = {
      version: USAGE_LEDGER_VERSION,
      lastTotals: {
        steps: Math.max(totals.steps, last.steps),
        billedInputTokens: Math.max(totals.billedInputTokens, last.billedInputTokens),
        outputTokens: Math.max(totals.outputTokens, last.outputTokens),
        billedCost: Math.max(totals.billedCost, last.billedCost),
        cachedInputTokens: Math.max(totals.billedCachedInputTokens, last.cachedInputTokens),
        reasoningTokens: Math.max(totals.reasoningTokens, last.reasoningTokens)
      },
      days
    }
    atomicWriteJson(join(runDir, USAGE_LEDGER_FILENAME), ledger)
  } catch {
    // Ledger is observational — a failed write must never break the run loop.
  }
}
