import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  budgetDedupeKey,
  type HomeActivityResult,
  type NotificationPublishInput,
  type UsageBudgetStatus
} from '../../shared/ipc'
import { localDayKeyOf } from '../../shared/utils/localDay'
import { formatUsdCost } from '../../shared/utils/costDisplay'
import { logger } from '../../shared/logger'
import { atomicWriteJson } from '../storage/atomicWrite'
import { userDataRoot, workspaceMetaDir, workspacesRoot } from '../storage/paths'
import { getSettings } from '../settings/settings'
import { getWorkspaces } from '../workspace/workspaces'
import { collectHomeActivity } from './activityStats'
import { publishLifecycleNotification } from '../notifications/bus'

/**
 * Daily and monthly budgets across every task (Settings › Agent › Cost).
 * Reaching one posts a notice once for that day or month; nothing is
 * stopped — the per-task limit is what stops a task. The spend is Usage's:
 * billed where the provider reported it, estimated where a price is known,
 * side calls included.
 */

/** A check reads every workspace's ledgers, so a busy run asks at most this often. */
const CHECK_INTERVAL_MS = 2 * 60_000
const STATE_FILENAME = 'spend-budget.json'

/**
 * The day and month each notice was last posted for; `…Near` is the 80%
 * heads-up, and `…Limit` the budget that day or month was reached at.
 */
type BudgetState = {
  day?: string
  month?: string
  dayNear?: string
  monthNear?: string
  dayLimit?: number
  monthLimit?: number
}

/** A heads-up before the limit, so the notice is not only "already past it". */
export const BUDGET_NEAR_SHARE = 0.8

function statePath(): string {
  return join(userDataRoot(), STATE_FILENAME)
}

function readState(): BudgetState {
  try {
    const p = statePath()
    if (!existsSync(p)) return {}
    const raw = JSON.parse(readFileSync(p, 'utf8')) as BudgetState
    return {
      ...(typeof raw.day === 'string' ? { day: raw.day } : {}),
      ...(typeof raw.month === 'string' ? { month: raw.month } : {}),
      ...(typeof raw.dayNear === 'string' ? { dayNear: raw.dayNear } : {}),
      ...(typeof raw.monthNear === 'string' ? { monthNear: raw.monthNear } : {}),
      ...(typeof raw.dayLimit === 'number' ? { dayLimit: raw.dayLimit } : {}),
      ...(typeof raw.monthLimit === 'number' ? { monthLimit: raw.monthLimit } : {})
    }
  } catch {
    return {}
  }
}

function writeState(state: BudgetState): void {
  try {
    atomicWriteJson(statePath(), state)
  } catch (err) {
    logger.warn('Could not save the budget notice state', { scope: 'agent', err })
  }
}

function spendOf(result: HomeActivityResult): number {
  return (result.totals.billedCost ?? 0) + (result.totals.estimatedCost ?? 0)
}

export type SpendBudgetDeps = {
  collect: (paths: readonly string[], now: Date, windowDays: number) => Promise<HomeActivityResult>
  publish: (input: NotificationPublishInput) => void
  readState: () => BudgetState
  writeState: (state: BudgetState) => void
  workspacePaths: () => readonly string[]
  budget: () => { dailyUsd: number; monthlyUsd: number; holdAtBudget?: boolean }
}

/**
 * Every workspace that has stored anything, open or not: a budget is "across
 * tasks", and closing a workspace you spent in today used to take its spend
 * out of the sum. Each workspace's store names its folder in `meta.json`.
 */
export function workspacePathsWithStorage(openPaths: readonly string[] = []): string[] {
  const out = new Map<string, string>()
  for (const path of openPaths) out.set(path.toLowerCase(), path)
  let ids: string[] = []
  try {
    ids = readdirSync(workspacesRoot())
  } catch {
    return [...out.values()]
  }
  for (const id of ids) {
    try {
      const meta = JSON.parse(readFileSync(join(workspaceMetaDir(id), 'meta.json'), 'utf8')) as { canonicalPath?: unknown }
      if (typeof meta.canonicalPath === 'string' && meta.canonicalPath && !out.has(meta.canonicalPath.toLowerCase())) {
        out.set(meta.canonicalPath.toLowerCase(), meta.canonicalPath)
      }
    } catch {
      // Not a workspace store, or one without a readable meta.json.
    }
  }
  return [...out.values()]
}

const defaultDeps: SpendBudgetDeps = {
  collect: (paths, now, windowDays) => collectHomeActivity(paths, now, windowDays),
  publish: publishLifecycleNotification,
  readState,
  writeState,
  workspacePaths: () => workspacePathsWithStorage(getWorkspaces().openPaths),
  budget: () => getSettings().spendBudget ?? { dailyUsd: 0, monthlyUsd: 0 }
}

type Period = {
  period: 'day' | 'month'
  key: string
  limit: number
  windowDays: number
  /** "today", "this month" */
  when: string
  name: 'Daily' | 'Monthly'
  reached: 'day' | 'month'
  near: 'dayNear' | 'monthNear'
  limitKey: 'dayLimit' | 'monthLimit'
}

/**
 * Compare today's and this month's spend with the budgets and post what was
 * newly reached: at 80% a heads-up, at 100% the notice. Each is posted once
 * for its day or month. Returns which notices went out, for tests.
 */
export async function checkSpendBudget(
  now = new Date(),
  deps: SpendBudgetDeps = defaultDeps
): Promise<Array<'day' | 'month' | 'dayNear' | 'monthNear'>> {
  const { dailyUsd, monthlyUsd } = deps.budget()
  if (dailyUsd <= 0 && monthlyUsd <= 0) return []
  const paths = deps.workspacePaths()
  if (paths.length === 0) return []
  const dayKey = localDayKeyOf(now.toISOString())
  const monthKey = dayKey.slice(0, 7)
  const state = deps.readState()
  const noticed: Array<'day' | 'month' | 'dayNear' | 'monthNear'> = []

  const periods: Period[] = [
    { period: 'day', key: dayKey, limit: dailyUsd, windowDays: 1, when: 'today', name: 'Daily', reached: 'day', near: 'dayNear', limitKey: 'dayLimit' },
    // Month to date: the window ends today and starts on the 1st.
    { period: 'month', key: monthKey, limit: monthlyUsd, windowDays: now.getDate(), when: 'this month', name: 'Monthly', reached: 'month', near: 'monthNear', limitKey: 'monthLimit' }
  ]
  const holding = deps.budget().holdAtBudget === true
  for (const p of periods) {
    // Reached at this budget already; a raised budget is checked again.
    if (p.limit <= 0 || (state[p.reached] === p.key && (state[p.limitKey] ?? p.limit) >= p.limit)) continue
    const spent = spendOf(await deps.collect(paths, now, p.windowDays))
    if (spent >= p.limit) {
      deps.publish({
        source: 'system',
        kind: 'budget',
        title: `${p.name} budget reached`,
        body: holding
          ? `${formatUsdCost(spent)} spent ${p.when} across tasks, past your ${formatUsdCost(p.limit)} budget. Running tasks finish; new work waits.`
          : `${formatUsdCost(spent)} spent ${p.when} across tasks, past your ${formatUsdCost(p.limit)} budget. Nothing was stopped.`,
        dedupeKey: budgetDedupeKey(p.period, p.key),
        action: { type: 'open_usage' }
      })
      state[p.reached] = p.key
      state[p.near] = p.key
      state[p.limitKey] = p.limit
      noticed.push(p.reached)
    } else if (spent >= p.limit * BUDGET_NEAR_SHARE && state[p.near] !== p.key) {
      deps.publish({
        source: 'system',
        kind: 'budget',
        title: `${p.name} budget at ${Math.floor((spent / p.limit) * 100)}%`,
        body: `${formatUsdCost(spent)} spent ${p.when} across tasks, of your ${formatUsdCost(p.limit)} budget. Nothing was stopped.`,
        dedupeKey: budgetDedupeKey(p.period, `${p.key}:near`),
        action: { type: 'open_usage' }
      })
      state[p.near] = p.key
      noticed.push(p.near)
    }
  }
  if (noticed.length > 0) deps.writeState(state)
  return noticed
}

/**
 * Why new work may not start, or null. With "Hold new work at the budget"
 * on, a day or month whose budget was reached (as the last check recorded it)
 * holds new tasks, follow-ups, schedules and loops; a budget raised past the
 * one it was reached at lets them through. Synchronous: it reads the saved
 * check, not the ledgers.
 */
export function budgetHoldReason(
  now = new Date(),
  deps: Pick<SpendBudgetDeps, 'readState' | 'budget'> = defaultDeps
): string | null {
  let budget: { dailyUsd: number; monthlyUsd: number; holdAtBudget?: boolean }
  try {
    budget = deps.budget()
  } catch {
    return null
  }
  if (!budget.holdAtBudget) return null
  const state = deps.readState()
  const dayKey = localDayKeyOf(now.toISOString())
  const held = (limit: number, key: string | undefined, at: string, reachedAt: number | undefined): boolean =>
    limit > 0 && key === at && (reachedAt === undefined || limit <= reachedAt)
  const where = 'Raise it, or turn off “Hold new work at the budget”, in Settings › Agent.'
  if (held(budget.dailyUsd, state.day, dayKey, state.dayLimit)) {
    return `Your daily budget of ${formatUsdCost(budget.dailyUsd)} is spent, so new work waits until tomorrow. ${where}`
  }
  if (held(budget.monthlyUsd, state.month, dayKey.slice(0, 7), state.monthLimit)) {
    return `Your monthly budget of ${formatUsdCost(budget.monthlyUsd)} is spent, so new work waits until next month. ${where}`
  }
  return null
}

/**
 * Usage's budget line: today's and this month's spend across every workspace
 * with storage — the sum the notices compare — against each budget that is set.
 */
export async function readBudgetStatus(
  now = new Date(),
  deps: Pick<SpendBudgetDeps, 'collect' | 'workspacePaths' | 'budget' | 'readState'> = defaultDeps
): Promise<UsageBudgetStatus> {
  const budget = deps.budget()
  const paths = deps.workspacePaths()
  const period = async (limit: number, windowDays: number): Promise<UsageBudgetStatus['day']> =>
    limit > 0 ? { spentUsd: paths.length ? spendOf(await deps.collect(paths, now, windowDays)) : 0, limitUsd: limit } : null
  return {
    day: await period(budget.dailyUsd, 1),
    month: await period(budget.monthlyUsd, now.getDate()),
    held: budgetHoldReason(now, deps)
  }
}

let lastCheckAt = 0
let checking = false

/**
 * A step just recorded spend: check the budgets, at most every couple of
 * minutes and never twice at once. Best-effort; never throws.
 */
export function noteSpendForBudget(): void {
  try {
    const budget = getSettings().spendBudget
    if (!budget || (budget.dailyUsd <= 0 && budget.monthlyUsd <= 0)) return
  } catch {
    return
  }
  const now = Date.now()
  if (checking || now - lastCheckAt < CHECK_INTERVAL_MS) return
  lastCheckAt = now
  checking = true
  void checkSpendBudget()
    .catch((err) => logger.warn('Budget check failed', { scope: 'agent', err }))
    .finally(() => {
      checking = false
    })
}

/** Test hook: forget the throttle. */
export function resetSpendBudgetThrottleForTests(): void {
  lastCheckAt = 0
  checking = false
}
