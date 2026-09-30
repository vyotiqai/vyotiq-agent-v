import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { atomicWriteJsonAsync } from '../storage/atomicWrite'
import { logger } from '../../shared/logger'

/**
 * What a task has spent on models, against Settings → Agent → "Spend limit
 * per task".
 *
 * A task's spend is its own steps plus every helper instance it started. The
 * task's own figure lives in its loop (cumulative across follow-ups, restored
 * from the loop checkpoint), and each loop publishes it here every step; a
 * helper's figure arrives live while it runs and is written to the task's
 * `spend.json` when it finishes, so it survives a restart. Only priced models
 * count: a step the provider billed counts what it billed, a step on a model
 * with published prices counts the estimate, and a step with neither counts
 * nothing — the same figures the usage panel shows, never an invented dollar.
 *
 * When the limit is reached the task asks, and "Allow another $N" raises this
 * task's allowance in the same file; the limit in Settings is not touched.
 */

export const TASK_SPEND_FILENAME = 'spend.json'

const TASK_SPEND_VERSION = 1 as const

export type TaskSpendFile = {
  version: typeof TASK_SPEND_VERSION
  /** Dollars allowed on top of the Settings limit, from "Allow another $N". */
  allowanceUsd: number
  /** Final spend of each finished helper instance, by its run id. */
  instances: Record<string, number>
}

const EMPTY: TaskSpendFile = { version: TASK_SPEND_VERSION, allowanceUsd: 0, instances: {} }

/** Dollars a usage total stands for: billed where the provider said, estimated where prices are published. */
export function spendOf(totals: { billedCost: number; estimatedCost: number }): number {
  const billed = Number.isFinite(totals.billedCost) ? totals.billedCost : 0
  const estimated = Number.isFinite(totals.estimatedCost) ? totals.estimatedCost : 0
  return Math.max(0, billed) + Math.max(0, estimated)
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** The task's spend file; empty when there is none or it is unreadable. */
export function readTaskSpend(runDir: string): TaskSpendFile {
  const file = join(runDir, TASK_SPEND_FILENAME)
  if (!existsSync(file)) return EMPTY
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<TaskSpendFile> | null
    if (!data || data.version !== TASK_SPEND_VERSION) return EMPTY
    const instances: Record<string, number> = {}
    if (data.instances && typeof data.instances === 'object') {
      for (const [id, usd] of Object.entries(data.instances)) {
        if (id) instances[id] = finiteNonNegative(usd)
      }
    }
    return { version: TASK_SPEND_VERSION, allowanceUsd: finiteNonNegative(data.allowanceUsd), instances }
  } catch (err) {
    // Unreadable: the task asks again sooner than it would have, never later.
    logger.warn('Unreadable task spend file', { scope: 'agent', code: 'PERSIST', err })
    return EMPTY
  }
}

/** Serialises writes per task so a helper finishing and an allowance cannot drop each other. */
const chains = new Map<string, Promise<void>>()

function updateTaskSpend(runDir: string, change: (current: TaskSpendFile) => TaskSpendFile): Promise<void> {
  const previous = chains.get(runDir) ?? Promise.resolve()
  const next = previous.then(async () => {
    try {
      await atomicWriteJsonAsync(join(runDir, TASK_SPEND_FILENAME), change(readTaskSpend(runDir)))
    } catch (err) {
      logger.warn('Failed to persist task spend', { scope: 'agent', code: 'PERSIST', err })
    }
  })
  chains.set(runDir, next)
  void next.finally(() => {
    if (chains.get(runDir) === next) chains.delete(runDir)
  })
  return next
}

/** A helper instance finished: its final spend counts toward its task from now on. */
export function recordInstanceSpend(taskRunDir: string, instanceRunId: string, usd: number): Promise<void> {
  return updateTaskSpend(taskRunDir, (current) => ({
    ...current,
    instances: { ...current.instances, [instanceRunId]: finiteNonNegative(usd) }
  }))
}

/** "Allow another $N": this task may spend N more before it asks again. */
export function addSpendAllowance(taskRunDir: string, usd: number): Promise<void> {
  return updateTaskSpend(taskRunDir, (current) => ({
    ...current,
    allowanceUsd: current.allowanceUsd + finiteNonNegative(usd)
  }))
}

/**
 * Each task's own spend so far, published by its loop every step. Kept after
 * the task's turn ends: a helper it started can still be running, and it
 * reads its task's total from here. One number per task in this session.
 */
const ownSpend = new Map<string, number>()

export function publishTaskOwnSpend(runId: string, usd: number): void {
  ownSpend.set(runId, finiteNonNegative(usd))
}

/*
 * Helper instances, fed by agentInstances.ts (which this module must not
 * import: agentInstances imports the loop, and the loop imports this).
 */
type InstanceTask = { runId: string; runDir: string }
const instanceTask = new Map<string, InstanceTask>()
/** Running helpers' spend so far, by task, then by helper run id. */
const liveInstances = new Map<string, Map<string, number>>()

/** A helper instance started for this task. */
export function registerInstanceTask(instanceRunId: string, task: InstanceTask): void {
  instanceTask.set(instanceRunId, task)
}

export function unregisterInstanceTask(instanceRunId: string): void {
  const task = instanceTask.get(instanceRunId)
  instanceTask.delete(instanceRunId)
  if (!task) return
  const live = liveInstances.get(task.runId)
  live?.delete(instanceRunId)
  if (live && live.size === 0) liveInstances.delete(task.runId)
}

/** The task a helper instance works for, or undefined for any other run. */
export function taskOfInstance(instanceRunId: string): InstanceTask | undefined {
  return instanceTask.get(instanceRunId)
}

/** A running helper's spend so far. */
export function noteLiveInstanceSpend(instanceRunId: string, usd: number): void {
  const task = instanceTask.get(instanceRunId)
  if (!task) return
  let live = liveInstances.get(task.runId)
  if (!live) {
    live = new Map()
    liveInstances.set(task.runId, live)
  }
  live.set(instanceRunId, finiteNonNegative(usd))
}

/**
 * A helper finished: write its final spend to the task's file. It stays in
 * the live map until the write lands, and the state below counts a helper in
 * the file from there only, so it is never missed and never counted twice.
 */
export function finishInstanceSpend(instanceRunId: string, usd: number): Promise<void> {
  const task = instanceTask.get(instanceRunId)
  if (!task) return Promise.resolve()
  noteLiveInstanceSpend(instanceRunId, usd)
  return recordInstanceSpend(task.runDir, instanceRunId, usd).then(() => {
    const live = liveInstances.get(task.runId)
    live?.delete(instanceRunId)
    if (live && live.size === 0) liveInstances.delete(task.runId)
  })
}

export type TaskSpendState = {
  /** Dollars spent: the task's own steps plus its helper instances. */
  spentUsd: number
  /** The Settings limit plus this task's allowance. */
  allowedUsd: number
}

/** Where a task stands against the limit, helper instances included. */
export function taskSpendState(input: { runId: string; runDir: string; limitUsd: number }): TaskSpendState {
  const file = readTaskSpend(input.runDir)
  let spent = ownSpend.get(input.runId) ?? 0
  for (const usd of Object.values(file.instances)) spent += usd
  for (const [id, usd] of liveInstances.get(input.runId) ?? []) {
    if (!(id in file.instances)) spent += usd
  }
  return { spentUsd: spent, allowedUsd: input.limitUsd + file.allowanceUsd }
}

/** "$4.20": the words the question and the notice use. */
export function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`
}

export function resetTaskSpendForTests(): void {
  ownSpend.clear()
  chains.clear()
  instanceTask.clear()
  liveInstances.clear()
}
