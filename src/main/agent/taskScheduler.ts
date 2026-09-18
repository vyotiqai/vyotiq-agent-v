import { existsSync, readFileSync, renameSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import {
  DelegatedTaskSchema,
  IPC,
  type DelegatedTask,
  type TaskEnqueueRequest
} from '../../shared/ipc'
import { workspacePathsEqual } from '../../shared/workspacePath'
import { logger } from '../../shared/logger'
import { atomicWriteJson } from '../storage/atomicWrite'
import { getMainWindow } from '../app/window'
import { resolveAgentProfile } from '../settings/agentProfiles'
import { cancelRun, isActive, listActiveRuns, registerProfileRunFinishListener, tryRegisterRunAbort } from './runRegistry'
import { createRunId } from './loop'
import { loadStatus } from './state'
import { resolveRunDir } from '../storage/paths'
import { startAgentRunInBackground } from './startAgentRun'
import { getWorkspaces } from '../workspace/workspaces'

/**
 * Delegated-task scheduler: prompts assigned to teammate profiles, run through
 * the exact same chatStart internals as user sends (steering, approvals,
 * notifications and badges all apply unchanged). Persisted per workspace at
 * `.vyotiq/tasks.json`; one running task per profile across all workspaces;
 * scheduled tasks survive restart via boot re-arm (resumeTasksForWorkspaces).
 */

const COMPLETION_POLL_MS = 5_000
const MAX_TIMEOUT_MS = 2 ** 31 - 1
/** A run whose status never materializes frees the teammate slot after this long. */
const MISSING_STATUS_POLL_LIMIT = 12

const tasksCache = new Map<string, DelegatedTask[]>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const runningByProfile = new Map<string, string>() // profileId → taskId
let taskSeq = 0

function workspaceTasksPath(workspacePath: string): string {
  return join(workspacePath, '.vyotiq', 'tasks.json')
}

function parseTasksFile(raw: unknown): DelegatedTask[] {
  const parsed = raw as { tasks?: unknown } | null
  if (!parsed || !Array.isArray(parsed.tasks)) return []
  const tasks: DelegatedTask[] = []
  for (const candidate of parsed.tasks) {
    const result = DelegatedTaskSchema.safeParse(candidate)
    if (result.success) tasks.push(result.data)
    else {
      logger.warn('Dropping invalid delegated task', {
        scope: 'tasks',
        id: (candidate as { id?: unknown })?.id
      })
    }
  }
  return tasks
}

function loadTasks(workspacePath: string): DelegatedTask[] {
  const cached = tasksCache.get(workspacePath)
  if (cached) return cached
  const path = workspaceTasksPath(workspacePath)
  let tasks: DelegatedTask[] = []
  if (existsSync(path)) {
    try {
      tasks = parseTasksFile(JSON.parse(readFileSync(path, 'utf8')))
    } catch (err) {
      // Preserve the unreadable file before treating it as empty — the next
      // save would otherwise silently wipe every persisted task for this
      // workspace with no recoverable trace.
      const backup = `${path}.corrupt-${Date.now()}`
      try {
        renameSync(path, backup)
        logger.warn('Corrupt tasks.json moved aside', { scope: 'tasks', backup, err })
      } catch (renameErr) {
        logger.warn('Failed to read tasks.json — starting empty', {
          scope: 'tasks',
          workspacePath,
          err,
          renameErr
        })
      }
    }
  }
  tasksCache.set(workspacePath, tasks)
  return tasks
}

function saveTasks(workspacePath: string, tasks: DelegatedTask[]): void {
  tasksCache.set(workspacePath, tasks)
  try {
    atomicWriteJson(workspaceTasksPath(workspacePath), { version: 1, tasks })
  } catch (err) {
    logger.error('Failed to persist tasks.json', { scope: 'tasks', workspacePath, err })
  }
}

function isTerminal(status: DelegatedTask['status']): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

export function listTasks(): DelegatedTask[] {
  const out: DelegatedTask[] = []
  for (const tasks of tasksCache.values()) out.push(...tasks)
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function emitTasksChanged(): void {
  try {
    const main = getMainWindow()
    if (!main || main.isDestroyed()) return
    main.webContents.send(IPC.tasksChanged, { tasks: listTasks() })
  } catch (err) {
    logger.warn('Failed to emit tasks change', { scope: 'tasks', err })
  }
}

function updateTask(workspacePath: string, taskId: string, patch: Partial<DelegatedTask>): void {
  const tasks = loadTasks(workspacePath)
  const next = tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t))
  saveTasks(workspacePath, next)
  emitTasksChanged()
}

function isWorkspaceOpen(path: string): boolean {
  return getWorkspaces().openPaths.some((open) => workspacePathsEqual(open, path))
}

function armTimer(task: DelegatedTask): void {
  if (!task.scheduledAt || task.status !== 'scheduled') return
  const key = `${task.workspacePath}\u0000${task.id}`
  const existing = timers.get(key)
  if (existing) clearTimeout(existing)
  const delay = Math.max(0, Date.parse(task.scheduledAt) - Date.now())
  const fire = (): void => {
    timers.delete(key)
    // Re-read the LIVE record: the captured task object can go stale if any
    // other path moved the task (e.g. boot reconcile) while this timer sat armed.
    const live = loadTasks(task.workspacePath).find((t) => t.id === task.id)
    if (!live || live.status !== 'scheduled') return
    // Scheduled time reached: queue the task, then give it a free-profile slot.
    updateTask(task.workspacePath, task.id, { status: 'queued', scheduledAt: undefined })
    pumpProfile(task.profileId)
  }
  if (delay <= MAX_TIMEOUT_MS) {
    timers.set(key, setTimeout(fire, delay))
  } else {
    // Node timers cap at ~24.9 days — re-arm in chunks: each chunk recomputes
    // the remaining delay instead of firing, so far-future schedules start on
    // time. (Firing the chunk directly started the task ~25 days early.)
    timers.set(key, setTimeout(() => armTimer(task), MAX_TIMEOUT_MS))
  }
}

/** Start the oldest queued task for a profile when it has no running task. */
function pumpProfile(profileId: string): void {
  if (runningByProfile.has(profileId)) return
  // A user chat or boot-resumed run bound to this teammate occupies the
  // identity — a delegated task must not start a second concurrent run.
  if (listActiveRuns().some((run) => run.agentProfileId === profileId)) return
  let next: DelegatedTask | null = null
  for (const tasks of tasksCache.values()) {
    for (const task of tasks) {
      if (task.profileId !== profileId || task.status !== 'queued') continue
      if (!next || task.createdAt < next.createdAt) next = task
    }
  }
  if (next) startTask(next)
}

function startTask(task: DelegatedTask): void {
  if (!isWorkspaceOpen(task.workspacePath)) {
    // Closed workspace: the task stays queued and starts when the workspace is
    // opened again (resumeTasksForWorkspaces re-pumps on open).
    return
  }
  const profile = resolveAgentProfile(task.workspacePath, task.profileId)
  if (!profile) {
    updateTask(task.workspacePath, task.id, {
      status: 'failed',
      error: 'Teammate profile no longer exists',
      finishedAt: new Date().toISOString()
    })
    return
  }
  const main = getMainWindow()
  if (!main || main.isDestroyed() || main.webContents.isDestroyed()) {
    // No renderer to stream events to — hold in the queue until one exists.
    return
  }
  const runId = createRunId()
  // Register WITH the profile so listActiveRuns reflects the teammate for the
  // whole run lifetime (the one-run-per-teammate gate reads it).
  const registered = tryRegisterRunAbort(runId, task.workspacePath, task.profileId)
  if (!registered.ok) {
    // Vanishingly rare (fresh UUID collision) — leave queued; the next pump retries.
    logger.warn('Task run registration failed', { scope: 'tasks', task: task.id })
    return
  }
  runningByProfile.set(task.profileId, task.id)
  updateTask(task.workspacePath, task.id, {
    status: 'running',
    runId,
    startedAt: new Date().toISOString()
  })
  startAgentRunInBackground({
    runId,
    workspacePath: task.workspacePath,
    invokeId: registered.invokeId,
    controller: registered.controller,
    wc: main.webContents,
    agentInput: {
      runId,
      messages: [{ role: 'user', content: task.prompt }],
      workspacePath: task.workspacePath,
      mode: 'agent',
      agentProfileId: task.profileId
    }
  })
  watchCompletion(task.workspacePath, task.id, task.profileId, runId)
}

function watchCompletion(
  workspacePath: string,
  taskId: string,
  profileId: string,
  runId: string
): void {
  let missingPolls = 0
  const poll = setInterval(() => {
    try {
      const status = loadStatus(resolveRunDir(workspacePath, runId))
      if (!status) {
        // Status never materialized (or the run dir vanished). Bound the wait —
        // otherwise the poll runs forever and the teammate's slot never frees.
        missingPolls += 1
        if (missingPolls < MISSING_STATUS_POLL_LIMIT) return
        clearInterval(poll)
        runningByProfile.delete(profileId)
        updateTask(workspacePath, taskId, {
          status: 'failed',
          error: 'Run status unavailable — the run never started or its directory is gone',
          finishedAt: new Date().toISOString()
        })
        pumpProfile(profileId)
        return
      }
      if (status.status === 'running') return
      clearInterval(poll)
      runningByProfile.delete(profileId)
      const finishedAt = new Date().toISOString()
      if (status.status === 'done') {
        updateTask(workspacePath, taskId, { status: 'done', finishedAt })
      } else if (status.status === 'error') {
        updateTask(workspacePath, taskId, {
          status: 'failed',
          error: status.error ?? 'Run failed',
          finishedAt
        })
      } else {
        // Cancelled by the user (Stop) — the task ends with the run.
        updateTask(workspacePath, taskId, { status: 'cancelled', finishedAt })
      }
      pumpProfile(profileId)
    } catch (err) {
      logger.warn('Task completion poll failed', { scope: 'tasks', runId, err })
    }
  }, COMPLETION_POLL_MS)
}

/** Enqueue a delegated task. Validates the profile and the open workspace. */
export function enqueueTask(request: TaskEnqueueRequest): DelegatedTask {
  if (!isWorkspaceOpen(request.workspacePath)) {
    throw new Error('Workspace is not open')
  }
  if (!resolveAgentProfile(request.workspacePath, request.profileId)) {
    throw new Error(`Unknown teammate profile: ${request.profileId}`)
  }
  taskSeq += 1
  const now = new Date()
  const scheduled = request.scheduledAt ? Date.parse(request.scheduledAt) : NaN
  const status = !Number.isNaN(scheduled) && scheduled > now.getTime() ? 'scheduled' : 'queued'
  // Random suffix: the sequence resets each launch, so millisecond-equal ids
  // could collide across restarts and make cancel/update patch both records.
  const task: DelegatedTask = {
    id: `task-${now.getTime()}-${taskSeq}-${randomBytes(4).toString('hex')}`,
    profileId: request.profileId,
    workspacePath: request.workspacePath,
    prompt: request.prompt,
    status,
    ...(status === 'scheduled' ? { scheduledAt: request.scheduledAt } : {}),
    createdAt: now.toISOString()
  }
  const tasks = loadTasks(request.workspacePath)
  saveTasks(request.workspacePath, [...tasks, task])
  emitTasksChanged()
  armTimer(task)
  if (status === 'queued') pumpProfile(request.profileId)
  // pumpProfile may have already transitioned the task to running — return the
  // stored record, not the pre-start snapshot.
  return loadTasks(request.workspacePath).find((t) => t.id === task.id) ?? task
}

/** Cancel a queued/scheduled task immediately; a running task stops its run. */
export function cancelTask(taskId: string): boolean {
  for (const [workspacePath, tasks] of tasksCache) {
    const task = tasks.find((t) => t.id === taskId)
    if (!task) continue
    if (isTerminal(task.status)) return false
    const key = `${workspacePath}\u0000${task.id}`
    const timer = timers.get(key)
    if (timer) {
      clearTimeout(timer)
      timers.delete(key)
    }
    if (task.status === 'running' && task.runId) {
      cancelRun(task.runId)
      // The completion poll finalizes the task when the run unwinds.
      return true
    }
    updateTask(workspacePath, task.id, {
      status: 'cancelled',
      finishedAt: new Date().toISOString()
    })
    return true
  }
  return false
}

/**
 * Boot/workspace-open re-arm: load every workspace's tasks.json, finalize
 * tasks orphaned by a restart, re-arm scheduled timers (past-due become
 * queued), and pump free profiles.
 */
export function resumeTasksForWorkspaces(workspacePaths: readonly string[]): void {
  let mutatedAnywhere = false
  for (const workspacePath of workspacePaths) {
    const tasks = loadTasks(workspacePath)
    let mutated = false
    for (const task of tasks) {
      if (task.status === 'running') {
        // A task left running by a previous process can never see its poll
        // again — finalize it from the durable run status. (Boot already
        // flipped orphan run statuses to cancelled; a missing run dir means
        // the run never started.) Re-queuing would duplicate delegated work.
        // A run still live in THIS process keeps its own completion poll.
        if (task.runId && isActive(task.runId)) continue
        const status = task.runId ? loadStatus(resolveRunDir(workspacePath, task.runId)) : null
        const finishedAt = new Date().toISOString()
        if (status?.status === 'done') {
          task.status = 'done'
          task.finishedAt = finishedAt
        } else if (status?.status === 'error') {
          task.status = 'failed'
          task.error = status.error ?? 'Run failed'
          task.finishedAt = finishedAt
        } else if (status?.status === 'cancelled') {
          task.status = 'cancelled'
          task.finishedAt = finishedAt
        } else {
          task.status = 'failed'
          task.error = 'Interrupted by app restart — reassign to retry'
          task.finishedAt = finishedAt
        }
        task.runId = undefined
        mutated = true
      } else if (task.status === 'scheduled') {
        if (task.scheduledAt && Date.parse(task.scheduledAt) <= Date.now()) {
          // Past due: disarm any timer still armed for it (wake-from-sleep edge)
          // before flipping to queued.
          const key = `${workspacePath}\u0000${task.id}`
          const timer = timers.get(key)
          if (timer) {
            clearTimeout(timer)
            timers.delete(key)
          }
          task.status = 'queued'
          task.scheduledAt = undefined
          mutated = true
        } else {
          armTimer(task)
        }
      }
    }
    if (mutated) {
      saveTasks(workspacePath, tasks)
      mutatedAnywhere = true
    }
  }
  // Pump after all rosters load so queued tasks can start immediately.
  const profileIds = new Set<string>()
  for (const tasks of tasksCache.values()) {
    for (const task of tasks) {
      if (task.status === 'queued') profileIds.add(task.profileId)
    }
  }
  for (const profileId of profileIds) pumpProfile(profileId)
  // Boot-time transitions (past-due → queued, orphan finalization) happen after
  // the renderer's initial pull — push the corrected list so rows don't lag.
  if (mutatedAnywhere) emitTasksChanged()
}

/** Cancel every non-terminal delegated task assigned to a profile (teammate deleted). */
export function cancelTasksForProfile(profileId: string): number {
  let cancelled = 0
  for (const [workspacePath, tasks] of tasksCache) {
    for (const task of tasks) {
      if (task.profileId !== profileId || isTerminal(task.status)) continue
      const key = `${workspacePath}\u0000${task.id}`
      const timer = timers.get(key)
      if (timer) {
        clearTimeout(timer)
        timers.delete(key)
      }
      if (task.status === 'running' && task.runId) {
        cancelRun(task.runId)
        cancelled += 1
        continue
      }
      updateTask(workspacePath, task.id, {
        status: 'cancelled',
        error: 'Teammate deleted',
        finishedAt: new Date().toISOString()
      })
      cancelled += 1
    }
  }
  return cancelled
}

// Any run bound to a teammate ending (user chat, boot-resumed run, task) frees
// the identity — re-pump that profile's queued tasks. Registered at module load
// so every entry point is covered without wiring at each call site.
registerProfileRunFinishListener((profileId) => {
  if (tasksCache.size > 0) pumpProfile(profileId)
})

/** Test hook — reset in-memory scheduler state without touching disk files. */
export function resetTaskSchedulerForTests(): void {
  tasksCache.clear()
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  runningByProfile.clear()
}
