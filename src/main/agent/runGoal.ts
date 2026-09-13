import { existsSync, readFileSync } from 'fs'
import { basename, join } from 'path'
import {
  RunGoalSchema,
  type RunGoal,
  type RunGoalStatus
} from '../../shared/ipc'
import { isGenericRunTitle, serializeGoalContent } from '../../shared/goalRuntime'
import { wrapPromptSection } from './promptSections'
import { atomicWriteJson } from '@main/storage/atomicWrite'
import { enqueueStatusPatch } from './statusWriteQueue'
import { invalidateListRunsCache } from './runListCache'
import { logger } from '../../shared/logger'

function goalPath(runDir: string): string {
  return join(runDir, 'goal.json')
}

function nowIso(): string {
  return new Date().toISOString()
}

export function readGoal(runDir: string): RunGoal | null {
  const path = goalPath(runDir)
  if (!existsSync(path)) return null
  try {
    const parsed = RunGoalSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (!parsed.success) throw parsed.error
    return parsed.data
  } catch (err) {
    logger.warn('Corrupt goal.json; treating as absent', {
      scope: 'state',
      correlationId: basename(runDir),
      err
    })
    return null
  }
}

export function writeGoal(runDir: string, goal: RunGoal): RunGoal {
  const next: RunGoal = { ...goal, updatedAt: nowIso() }
  atomicWriteJson(goalPath(runDir), next)
  invalidateListRunsCache()
  return next
}

export function createGoal(runDir: string, objective: string): RunGoal {
  const text = objective.trim()
  if (!text) throw new Error('create_goal requires objective')
  const at = nowIso()
  const goal: RunGoal = {
    objective: text,
    status: 'active',
    createdAt: at,
    updatedAt: at
  }
  atomicWriteJson(goalPath(runDir), goal)
  seedRunTitleIfGeneric(runDir, text)
  invalidateListRunsCache()
  return goal
}

export function updateGoalStatus(
  runDir: string,
  status: Extract<RunGoalStatus, 'active' | 'complete'>
): RunGoal {
  const current = readGoal(runDir)
  if (!current) throw new Error('No goal on this run. Call create_goal first.')
  if (status === 'active') {
    if (current.status === 'complete') {
      throw new Error('Cannot resume a completed goal. Call create_goal to start a new one.')
    }
    if (current.status === 'active') return current
  }
  // Already-complete is idempotent: no rewrite, no loop disarm re-emit.
  if (status === 'complete' && current.status === 'complete') return current
  const next = writeGoal(runDir, { ...current, status })
  if (status === 'complete') disarmLoopForGoal(runDir)
  return next
}

export function pauseGoalIfActive(runDir: string): RunGoal | null {
  const current = readGoal(runDir)
  if (!current || current.status !== 'active') return current
  const next = writeGoal(runDir, { ...current, status: 'paused' })
  // Intentionally do NOT disarm the loop here: pausing the goal must hold the
  // loop (the scheduler skips launches while the goal is paused) rather than
  // destroying it. Stop-loop is the explicit, separate "kill the loop" action,
  // and Resume can then naturally continue a held loop.
  return next
}

export function bumpGoalContinueCount(runDir: string): RunGoal | null {
  const current = readGoal(runDir)
  if (!current || current.status !== 'active') return current
  return writeGoal(runDir, {
    ...current,
    continueCount: (current.continueCount ?? 0) + 1
  })
}

export function formatActiveGoalSection(goal: RunGoal | null): string {
  if (!goal || goal.status === 'complete') return ''
  const lines =
    goal.status === 'paused'
      ? [
          `Objective: ${goal.objective}`,
          'Status: paused',
          'Wait for the user to resume. Do not pause yourself; only the user can pause.'
        ]
      : [
          `Objective: ${goal.objective}`,
          'Status: active',
          'Do not stop until `update_goal` with status complete, or the user pauses. Never pause yourself.'
        ]
  return wrapPromptSection('active_goal', lines.join('\n'))
}

function readStatusGoal(runDir: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(runDir, 'status.json'), 'utf8')) as {
      goal?: unknown
    }
    return typeof raw.goal === 'string' ? raw.goal : undefined
  } catch {
    return undefined
  }
}

export function seedRunTitleIfGeneric(runDir: string, objective: string): void {
  const current = readStatusGoal(runDir)
  if (!isGenericRunTitle(current) && !current?.trimStart().startsWith('[Goal]')) return
  const goalText = objective.trim().slice(0, 200)
  if (!goalText) return
  enqueueStatusPatch(runDir, { goal: goalText })
  invalidateListRunsCache()
}

export function goalToolContent(goal: RunGoal): string {
  return serializeGoalContent(goal)
}

type LoopDisarm = (runDir: string) => void
let loopDisarm: LoopDisarm | null = null

/** Wired by the loop scheduler so completing/pausing a goal can disarm timers. */
export function registerGoalLoopDisarm(fn: LoopDisarm | null): void {
  loopDisarm = fn
}

export function disarmLoopForGoal(runDir: string): void {
  loopDisarm?.(runDir)
}
