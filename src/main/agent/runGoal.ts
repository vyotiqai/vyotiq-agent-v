import { existsSync, readFileSync, rmSync } from 'fs'
import { basename, join } from 'path'
import {
  RunGoalSchema,
  type RunGoal,
  type RunGoalOrigin,
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

/** Absent origin = written before proposals existed; treat as user-set. */
export function goalOrigin(goal: RunGoal): RunGoalOrigin {
  return goal.origin ?? 'user'
}

/**
 * User-set goal (the `/goal` path): active immediately, because the user asking
 * for a goal *is* the grant of the unattended powers an active goal unlocks.
 */
export function createGoal(runDir: string, objective: string): RunGoal {
  const text = objective.trim()
  if (!text) throw new Error('create_goal requires objective')
  const at = nowIso()
  const goal: RunGoal = {
    objective: text,
    status: 'active',
    origin: 'user',
    createdAt: at,
    updatedAt: at
  }
  atomicWriteJson(goalPath(runDir), goal)
  seedRunTitleIfGeneric(runDir, text)
  invalidateListRunsCache()
  return goal
}

/**
 * Agent-created goal: lands `proposed` and stays inert until the user starts it.
 * Never overwrites a live user-set goal — silently replacing the user's own
 * objective would be the same authority grab by another route.
 */
export function proposeGoal(runDir: string, objective: string): RunGoal {
  const text = objective.trim()
  if (!text) throw new Error('create_goal requires objective')
  const current = readGoal(runDir)
  if (current && current.status !== 'complete' && goalOrigin(current) === 'user') {
    throw new Error(
      `This chat already has a user-set goal: "${current.objective}". Ask the user to change it instead of replacing it.`
    )
  }
  const at = nowIso()
  const goal: RunGoal = {
    objective: text,
    status: 'proposed',
    origin: 'agent',
    createdAt: at,
    updatedAt: at
  }
  atomicWriteJson(goalPath(runDir), goal)
  invalidateListRunsCache()
  return goal
}

/**
 * The only promotion into `active` — reachable from the IPC channel the banner
 * and slash commands use, never from a tool. Covers both starting a proposal
 * and resuming a user pause.
 */
export function activateGoalByUser(runDir: string): RunGoal {
  const current = readGoal(runDir)
  if (!current) throw new Error('No goal on this run.')
  if (current.status === 'complete') {
    throw new Error('Cannot resume a completed goal. Set a new goal instead.')
  }
  if (current.status === 'active') return current
  // A fresh grant starts a fresh stretch: both the auto-continue budget and the
  // auto-resume ceiling reset. Without the continueCount reset, resuming a goal
  // that paused on its budget would re-pause on the very next turn end.
  return writeGoal(runDir, {
    ...current,
    status: 'active',
    continueCount: 0,
    autoResumeCount: 0
  })
}

/** Discard an agent proposal outright — a declined suggestion leaves no trace. */
export function dismissGoalProposal(runDir: string): boolean {
  const current = readGoal(runDir)
  if (!current || current.status !== 'proposed') return false
  try {
    rmSync(goalPath(runDir), { force: true })
  } catch {
    return false
  }
  invalidateListRunsCache()
  return true
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
    // The proposal gate: without this, create_goal + update_goal("active")
    // would promote an agent's own proposal and route around the user entirely.
    if (current.status === 'proposed') {
      throw new Error(
        'This goal is awaiting user confirmation. Only the user can start it — keep working on the current turn.'
      )
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

/** App-start relaunch bookkeeping — the ceiling lives in resumeActiveGoals. */
export function bumpGoalAutoResume(runDir: string): RunGoal | null {
  const current = readGoal(runDir)
  if (!current || current.status !== 'active') return current
  return writeGoal(runDir, { ...current, autoResumeCount: (current.autoResumeCount ?? 0) + 1 })
}

/** A real user turn proves someone is watching — spend the ceiling again. */
export function clearGoalAutoResume(runDir: string): void {
  const current = readGoal(runDir)
  if (!current || !current.autoResumeCount) return
  writeGoal(runDir, { ...current, autoResumeCount: 0 })
}

export function formatActiveGoalSection(goal: RunGoal | null): string {
  // A proposal carries no standing instruction: it must not inject the
  // "do not stop" overlay before the user has agreed to it.
  if (!goal || goal.status === 'complete' || goal.status === 'proposed') return ''
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
