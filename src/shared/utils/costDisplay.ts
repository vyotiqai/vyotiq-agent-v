/**
 * Display-cost helpers for run-shaped data (RunStat / RunSummary).
 *
 * Honesty rules mirror `messageFooterStats.turnCost`: a number is only shown
 * when it is a provider bill or a priced estimate, and estimates are labeled
 * `est.` — never presented as a provider bill.
 */

/** Mirrors the footer caption's `$` formatting — single source for all surfaces. */
export function formatUsdCost(n: number): string {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs === 0) return '$0'
  if (abs < 0.01) {
    return `${sign}$${abs.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`
  }
  if (abs < 1) {
    return `${sign}$${abs.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`
  }
  return `${sign}$${abs.toFixed(2)}`
}

export type RunCostDisplay = {
  /** Measurable spend — provider-reported bill plus priced estimates. */
  cost: number
  /** Formatted `$` value, `est.`-labeled when any contributing part is estimated. */
  text: string
  /** True when any contributing portion is an estimate (or the total may undercount). */
  estimated: boolean
  /** Tooltip explaining what the number is. */
  title: string
}

function presentCost(cost: number, estimated: boolean, title: string): RunCostDisplay {
  return {
    cost,
    text: estimated ? `${formatUsdCost(cost)} est.` : formatUsdCost(cost),
    estimated,
    title
  }
}

/**
 * Cost to show for one run. A provider-reported bill shows as-is; once any
 * step was priced from published model rates the total is labeled `est.`
 * (the billed share is real but the estimate is not a bill). Runs with no
 * measurable cost stay tokens-only — null here.
 */
export function runCostDisplay(
  input: { billedCost?: number; estimatedCost?: number } | undefined | null
): RunCostDisplay | null {
  const billed = input?.billedCost ?? 0
  const estimated = input?.estimatedCost ?? 0
  if (!(billed > 0) && !(estimated > 0)) return null
  if (estimated > 0) {
    return presentCost(
      billed + estimated,
      true,
      'Estimated from published model rates — not a provider bill'
    )
  }
  return presentCost(billed, false, 'Provider-reported cost for this run')
}

/**
 * A window's spend over many tasks (Usage): the bills and estimates summed
 * by main, and how many of the tasks carried any cost at all. `est.` when
 * any part is an estimate or any task had no measurable cost — then the true
 * total is higher than shown. The per-task figure divides by the priced tasks
 * only; dividing by all would read low.
 */
export function windowCostDisplay(totals: {
  billedCost?: number
  estimatedCost?: number
  runs: number
  pricedRuns?: number
}): (RunCostDisplay & { perTask: number | null }) | null {
  const billed = totals.billedCost ?? 0
  const estimated = totals.estimatedCost ?? 0
  if (!(billed > 0) && !(estimated > 0)) return null
  const priced = Math.min(totals.pricedRuns ?? totals.runs, totals.runs)
  const unpriced = Math.max(0, totals.runs - priced)
  const anyEstimated = estimated > 0 || unpriced > 0
  const title =
    unpriced > 0
      ? `Estimated total — ${unpriced} of ${totals.runs} ${totals.runs === 1 ? 'task has' : 'tasks have'} no measurable cost`
      : estimated > 0
        ? 'Estimated from published model rates — not a provider bill'
        : 'Provider-reported cost across tasks'
  return { ...presentCost(billed + estimated, anyEstimated, title), perTask: priced > 0 ? (billed + estimated) / priced : null }
}

/**
 * Workspace/session total over run costs. Runs without measurable cost
 * contribute nothing and are counted as unpriced — their true spend is
 * unknown, so the aggregate stays `est.`-labeled whenever any portion is
 * estimated or any run is unpriced (never presented as an exact bill).
 */
export function aggregateRunCost(
  runs: ReadonlyArray<{ billedCost?: number; estimatedCost?: number } | undefined | null>
): RunCostDisplay | null {
  let billed = 0
  let estimated = 0
  let unpriced = 0
  for (const run of runs) {
    const b = run?.billedCost ?? 0
    const e = run?.estimatedCost ?? 0
    if (b > 0 || e > 0) {
      billed += b
      estimated += e
    } else {
      unpriced += 1
    }
  }
  if (billed <= 0 && estimated <= 0) return null
  const anyEstimated = estimated > 0 || unpriced > 0
  const title = anyEstimated
    ? unpriced > 0
      ? `Estimated total — ${unpriced} ${unpriced === 1 ? 'session has' : 'sessions have'} no measurable cost`
      : 'Estimated from published model rates — not a provider bill'
    : 'Provider-reported cost across sessions'
  return presentCost(billed + estimated, anyEstimated, title)
}
