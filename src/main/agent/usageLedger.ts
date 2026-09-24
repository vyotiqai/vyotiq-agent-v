import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { atomicWriteJson } from '../storage/atomicWrite'
import { localDayKeyOf } from '../../shared/utils/localDay'
import type { StepUsageTotals } from '../../shared/utils/runTelemetry'
import { readJsonDocCached } from './jsonDocCache'

export const USAGE_LEDGER_FILENAME = 'usage.json'

const USAGE_LEDGER_VERSION = 1 as const

/** Non-turn LLM call sites — the "endpoints" spend is attributed to. */
export type UsageLedgerAuxSite =
  | 'compaction_fork'
  | 'compaction_structured'
  | 'compaction_freeform'
  | 'commit_message'

/** One call site's spend within a day bucket. */
export type UsageLedgerAux = {
  /** Billed provider streams, retries included. */
  calls: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  reasoningTokens?: number
  billedCost?: number
  estimatedCost?: number
}

/** One local-day bucket of recorded usage deltas for a run. */
export type UsageLedgerDay = {
  /**
   * Billed input tokens recorded on this day — per-step turn input plus any
   * auxiliary (non-turn) input folded in, so day totals reflect everything
   * actually paid for rather than turns alone.
   */
  inputTokens: number
  outputTokens: number
  /** Provider-reported cost deltas (may stay absent when never reported). */
  billedCost?: number
  /** Estimated cost deltas (tokens × published prices), kept separate. */
  estimatedCost?: number
  cachedInputTokens?: number
  /**
   * Whole-prompt tokens recorded this day (cached reads included, whatever the
   * provider counts as input). Present only on days whose every step was
   * recorded with it, so `cachedInputTokens / promptInputTokens` is exact.
   */
  promptInputTokens?: number
  /** Billed thinking-token deltas recorded this day (subset of output). */
  reasoningTokens?: number
  /** Peak per-step context input seen this day (max across steps). */
  peakInputTokens?: number
  /** Raw model context window in effect at the last recorded step this day. */
  contextWindow?: number
  /**
   * Per-call-site breakdown of auxiliary spend. Additive and optional, so this
   * stays a version-1 ledger: every reader reads named keys, and bumping the
   * version would make `readUsageLedger` reject every existing ledger — which
   * silently falls Home activity back to the receipt path and re-attributes each
   * multi-day run's whole total to its receipt day.
   *
   * These amounts are ALSO folded into the day totals above. They are never
   * routed through `lastTotals`, so they cannot double-count: `recordUsageDeltas`
   * only ever deltas turn accounting.
   */
  aux?: Partial<Record<UsageLedgerAuxSite, UsageLedgerAux>>
}

export type UsageLedger = {
  version: typeof USAGE_LEDGER_VERSION
  /** Last recorded cumulative snapshot — deltas are current minus this. */
  lastTotals: {
    steps: number
    billedInputTokens: number
    outputTokens: number
    billedCost: number
    estimatedCost: number
    cachedInputTokens: number
    reasoningTokens: number
    /** Absent on ledgers written before prompt sizes were tracked. */
    promptInputTokens?: number
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
    // Ledgers written before estimate tracking lack `lastTotals.estimatedCost`
    // — normalize so monotonic max() below never produces NaN.
    return {
      ...raw,
      lastTotals: { ...raw.lastTotals, estimatedCost: raw.lastTotals.estimatedCost ?? 0 }
    }
  } catch {
    return null
  }
}

/**
 * Same contract as `readUsageLedger` for aggregation callers (Home activity):
 * the raw parse goes through the shared doc cache, so unchanged ledgers are
 * never re-read across fetches. The write path keeps the sync read above.
 */
export async function readUsageLedgerAsync(runDir: string): Promise<UsageLedger | null> {
  const path = join(runDir, USAGE_LEDGER_FILENAME)
  const doc = await readJsonDocCached(path)
  if (!doc.ok) return null
  const raw = doc.doc as UsageLedger
  if (raw?.version !== USAGE_LEDGER_VERSION || typeof raw.days !== 'object') return null
  return {
    ...raw,
    lastTotals: { ...raw.lastTotals, estimatedCost: raw.lastTotals.estimatedCost ?? 0 }
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
      estimatedCost: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0
    }

    const delta = (current: number, before: number): number => (current > before ? current - before : 0)
    const dInput = delta(totals.billedInputTokens, last.billedInputTokens)
    const dOutput = delta(totals.outputTokens, last.outputTokens)
    const dCost = delta(totals.billedCost, last.billedCost)
    const dEstimate = delta(totals.estimatedCost, last.estimatedCost)
    const dCached = delta(totals.billedCachedInputTokens, last.cachedInputTokens)
    const dReasoning = delta(totals.reasoningTokens, last.reasoningTokens)
    const promptTracked = totals.billedPromptTokens !== undefined
    const dPrompt = promptTracked ? delta(totals.billedPromptTokens!, last.promptInputTokens ?? 0) : 0
    // Nothing new to record — skip the write entirely (the snapshot only
    // matters when a later cumulative jump bills its actual delta).
    if (totals.steps === last.steps && dCost === 0) return

    const dateKey = localDayKeyOf(now.toISOString())
    if (!dateKey) return
    const days: Record<string, UsageLedgerDay> = { ...(prev?.days ?? {}) }
    // A day starts tracking prompt sizes only when its first step does: a day
    // begun before, or by totals without them, stays without, never half-counted.
    const day: UsageLedgerDay = {
      ...(days[dateKey] ?? { inputTokens: 0, outputTokens: 0, ...(promptTracked ? { promptInputTokens: 0 } : {}) })
    }
    if (day.promptInputTokens !== undefined) {
      if (promptTracked) day.promptInputTokens += dPrompt
      else delete day.promptInputTokens
    }
    day.inputTokens += dInput
    day.outputTokens += dOutput
    if (dCost > 0) day.billedCost = (day.billedCost ?? 0) + dCost
    if (dEstimate > 0) day.estimatedCost = (day.estimatedCost ?? 0) + dEstimate
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
        estimatedCost: Math.max(totals.estimatedCost, last.estimatedCost),
        cachedInputTokens: Math.max(totals.billedCachedInputTokens, last.cachedInputTokens),
        reasoningTokens: Math.max(totals.reasoningTokens, last.reasoningTokens),
        ...(promptTracked
          ? { promptInputTokens: Math.max(totals.billedPromptTokens!, last.promptInputTokens ?? 0) }
          : {})
      },
      days
    }
    atomicWriteJson(join(runDir, USAGE_LEDGER_FILENAME), ledger)
  } catch {
    // Ledger is observational — a failed write must never break the run loop.
  }
}

/**
 * Record one billed non-turn LLM call (compaction, commit-message generation)
 * into its run's per-day ledger.
 *
 * Unlike `recordUsageDeltas` this takes ABSOLUTE amounts for a single call, not
 * a cumulative snapshot, so it deliberately never reads or writes `lastTotals`.
 * That separation is what makes double-counting structurally impossible: turn
 * spend flows through `lastTotals` deltas and auxiliary spend never touches it.
 *
 * Synchronous, matching `recordUsageDeltas` — both read-modify-write the same
 * file from the main process, and interleaving them would lose a bucket.
 *
 * Best-effort: never throws to callers.
 */
export function recordAuxUsage(
  runDir: string,
  entry: {
    site: UsageLedgerAuxSite
    inputTokens?: number
    outputTokens?: number
    cachedInputTokens?: number
    reasoningTokens?: number
    billedCost?: number
    estimatedCost?: number
  },
  now = new Date()
): void {
  try {
    const add = (n: number | undefined): number => (typeof n === 'number' && n > 0 ? n : 0)
    const dInput = add(entry.inputTokens)
    const dOutput = add(entry.outputTokens)
    const dCached = add(entry.cachedInputTokens)
    const dReasoning = add(entry.reasoningTokens)
    const dCost = add(entry.billedCost)
    const dEstimate = add(entry.estimatedCost)
    if (
      dInput === 0 &&
      dOutput === 0 &&
      dCached === 0 &&
      dReasoning === 0 &&
      dCost === 0 &&
      dEstimate === 0
    ) {
      return
    }

    const dateKey = localDayKeyOf(now.toISOString())
    if (!dateKey) return

    const prev = readUsageLedger(runDir)
    const days: Record<string, UsageLedgerDay> = { ...(prev?.days ?? {}) }
    const day: UsageLedgerDay = { ...(days[dateKey] ?? { inputTokens: 0, outputTokens: 0 }) }

    // Fold into the day totals so Home activity picks auxiliary spend up with no
    // changes to its aggregation.
    day.inputTokens += dInput
    day.outputTokens += dOutput
    if (dCached > 0) day.cachedInputTokens = (day.cachedInputTokens ?? 0) + dCached
    if (dReasoning > 0) day.reasoningTokens = (day.reasoningTokens ?? 0) + dReasoning
    if (dCost > 0) day.billedCost = (day.billedCost ?? 0) + dCost
    if (dEstimate > 0) day.estimatedCost = (day.estimatedCost ?? 0) + dEstimate

    const aux: Partial<Record<UsageLedgerAuxSite, UsageLedgerAux>> = { ...(day.aux ?? {}) }
    const site: UsageLedgerAux = {
      ...(aux[entry.site] ?? { calls: 0, inputTokens: 0, outputTokens: 0 })
    }
    site.calls += 1
    site.inputTokens += dInput
    site.outputTokens += dOutput
    if (dCached > 0) site.cachedInputTokens = (site.cachedInputTokens ?? 0) + dCached
    if (dReasoning > 0) site.reasoningTokens = (site.reasoningTokens ?? 0) + dReasoning
    if (dCost > 0) site.billedCost = (site.billedCost ?? 0) + dCost
    if (dEstimate > 0) site.estimatedCost = (site.estimatedCost ?? 0) + dEstimate
    aux[entry.site] = site
    day.aux = aux
    days[dateKey] = day

    const ledger: UsageLedger = {
      version: USAGE_LEDGER_VERSION,
      lastTotals: prev?.lastTotals ?? {
        steps: 0,
        billedInputTokens: 0,
        outputTokens: 0,
        billedCost: 0,
        estimatedCost: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0
      },
      days
    }
    atomicWriteJson(join(runDir, USAGE_LEDGER_FILENAME), ledger)
  } catch {
    // Ledger is observational — a failed write must never break compaction.
  }
}
