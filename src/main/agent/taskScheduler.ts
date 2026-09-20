import { existsSync, readFileSync, renameSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { randomBytes } from 'crypto'
import {
  DELEGATED_TASKS_FILE_VERSION,
  DelegatedTaskSchema,
  IPC,
  isTerminalDelegatedTaskStatus,
  type DelegatedTask,
  type TaskEnqueueRequest
} from '../../shared/ipc'
import { workspacePathsEqual } from '../../shared/workspacePath'
import { logger } from '../../shared/logger'
import { atomicWriteJson } from '../storage/atomicWrite'
import { getMainWindow } from '../app/window'
import { resolveAgentProfile } from '../settings/agentProfiles'
import { cancelRun, isActive, registerProfileRunFinishListener } from './runRegistry'
import { launchRunSync } from './launchRun'
import { loadStatus } from './state'
import { resolveRunDir } from '../storage/paths'
import { getWorkspaces } from '../workspace/workspaces'

/**
 * Delegated-task scheduler: prompts assigned to teammate profiles, run through
 * the exact same chatStart internals as user sends (steering, approvals,
 * notifications and badges all apply unchanged). Persisted per workspace at
 * `.vyotiq/tasks.json`; one running task per profile across all workspaces;
 * scheduled tasks survive restart via boot re-arm (resumeTasksForWorkspaces).
 *
 * Persistence is write-first: a mutation is only visible in the cache and only
 * pushed to the renderer after it is durably on disk. A cache-first write that
 * logs its failure would leave the UI, the scheduler, and the file disagreeing
 * about what work exists — and the IPC caller would be told it succeeded.
 */

const MAX_TIMEOUT_MS = 2 ** 31 - 1
/** Backstop sweep for runs whose finish notification never arrived. */
const RECONCILE_INTERVAL_MS = 5_000
/** A run whose status never materializes frees the teammate slot after this long. */
const MISSING_STATUS_SWEEP_LIMIT = 12

/**
 * Terminal records kept per workspace for audit. Measured against the real
 * store: the fixture rosters seen in practice hold single-digit terminal rows
 * at a few hundred bytes each, so a 200-row cap keeps the full-list push far
 * below any payload concern while retaining months of history. Active records
 * are never trimmed.
 */
const TERMINAL_HISTORY_LIMIT = 200

const tasksCache = new Map<string, DelegatedTask[]>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
/** profileId → taskId for tasks this process is actively running. */
const runningByProfile = new Map<string, string>()
/** runId → { workspaceKey, taskId, profileId } for live delegated runs. */
type WatchedRun = { workspaceKey: string; taskId: string; profileId: string; missingSweeps: number }
const watchedRuns = new Map<string, WatchedRun>()
let reconcileTimer: ReturnType<typeof setInterval> | null = null
let taskSeq = 0
/** Serializes overlapping resume passes (boot vs. workspace-open). */
let resumeChain: Promise<void> = Promise.resolve()

function workspaceTasksPath(workspacePath: string): string {
  return join(workspacePath, '.vyotiq', 'tasks.json')
}

/**
 * Tasks are cached under the first spelling of a workspace path we see. A
 * later call with an equal-but-differently-spelled path (Windows drive
 * casing, separators) must reuse that entry: two entries for one workspace
 * would double-count in listTasks and let two save races write the same
 * file from different arrays.
 */
function cacheKeyFor(workspacePath: string): string {
  if (tasksCache.has(workspacePath)) return workspacePath
  for (const key of tasksCache.keys()) {
    if (workspacePathsEqual(key, workspacePath)) return key
  }
  return workspacePath
}

/**
 * Bring a persisted row up to the current invariants before validating it.
 * Rows written by older builds predate the cross-field rules, and dropping a
 * non-terminal one would silently discard delegated work — so a record is
 * repaired where its intent is unambiguous and only rejected when it is not.
 */
function repairTaskRecord(candidate: unknown, workspaceKey: string): unknown {
  if (!candidate || typeof candidate !== 'object') return candidate
  const row = { ...(candidate as Record<string, unknown>) }
  let repaired = false
  const note = (reason: string): void => {
    repaired = true
    logger.warn('Repairing delegated task record', {
      scope: 'tasks',
      workspacePath: workspaceKey,
      id: row.id,
      reason
    })
  }
  // A record must live in the file it was read from, or a later write would
  // save it to the wrong workspace and cancel/pump it against another.
  if (typeof row.workspacePath === 'string' && !workspacePathsEqual(row.workspacePath, workspaceKey)) {
    row.workspacePath = workspaceKey
    note('foreign workspacePath')
  }
  const createdAt = typeof row.createdAt === 'string' ? row.createdAt : undefined
  if (row.status === 'running' || row.status === 'cancelling') {
    if (typeof row.runId !== 'string' || row.runId.length === 0) {
      // Unreconcilable: there is no run to read a terminal status from.
      row.status = 'failed'
      row.error = row.error ?? 'Interrupted by app restart — retry to run it again'
      row.finishedAt = row.finishedAt ?? createdAt ?? new Date().toISOString()
      note('running without a runId')
    } else if (typeof row.startedAt !== 'string') {
      row.startedAt = createdAt ?? new Date().toISOString()
      note('running without startedAt')
    }
  }
  if (row.status === 'scheduled' && typeof row.scheduledAt !== 'string') {
    // No due time left: run it as soon as the teammate frees up.
    row.status = 'queued'
    note('scheduled without scheduledAt')
  }
  if (
    (row.status === 'done' || row.status === 'failed' || row.status === 'cancelled') &&
    typeof row.finishedAt !== 'string'
  ) {
    row.finishedAt = createdAt ?? new Date().toISOString()
    note('terminal without finishedAt')
  }
  return repaired ? row : candidate
}

/**
 * Parse one workspace's task file. Records are repaired then validated one by
 * one, so a single bad row cannot take the workspace's whole queue with it.
 */
function parseTasksFile(raw: unknown, workspaceKey: string): DelegatedTask[] {
  const parsed = raw as { version?: unknown; tasks?: unknown } | null
  if (!parsed || !Array.isArray(parsed.tasks)) return []
  if (parsed.version !== DELEGATED_TASKS_FILE_VERSION) {
    logger.warn('Ignoring tasks.json with an unsupported version', {
      scope: 'tasks',
      workspacePath: workspaceKey,
      version: parsed.version
    })
    return []
  }
  const tasks: DelegatedTask[] = []
  for (const candidate of parsed.tasks) {
    const repaired = repairTaskRecord(candidate, workspaceKey)
    const result = DelegatedTaskSchema.safeParse(repaired)
    if (result.success) tasks.push(result.data)
    else {
      logger.warn('Dropping invalid delegated task', {
        scope: 'tasks',
        id: (candidate as { id?: unknown } | null)?.id,
        issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      })
    }
  }
  return tasks
}

function loadTasks(workspacePath: string): DelegatedTask[] {
  const key = cacheKeyFor(workspacePath)
  const cached = tasksCache.get(key)
  if (cached) return cached
  const path = workspaceTasksPath(key)
  let tasks: DelegatedTask[] = []
  if (existsSync(path)) {
    try {
      tasks = parseTasksFile(JSON.parse(readFileSync(path, 'utf8')), key)
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
  tasksCache.set(key, tasks)
  return tasks
}

/**
 * Populate the cache for every path, so surfaces that sweep `tasksCache`
 * (listTasks, cancelTasksForProfile, pumpProfile) can see workspaces that are
 * closed or not yet opened. Returns true when at least one path was read for
 * the first time — the caller pushes so those rows reach the renderer, which
 * pulls `tasksList` only once on mount.
 */
function loadTasksForWorkspaces(workspacePaths: readonly string[]): boolean {
  let loadedAny = false
  for (const workspacePath of workspacePaths) {
    if (tasksCache.has(cacheKeyFor(workspacePath))) continue
    loadTasks(workspacePath)
    loadedAny = true
  }
  return loadedAny
}

/**
 * Read one workspace’s task file off the main thread.
 * Mirrors `loadTasks`, including moving an unreadable file aside before
 * treating the queue as empty. That rename stays synchronous: it is the rare
 * corrupt branch, and two readers racing an async rename could each move the
 * other’s backup.
 */
async function readTasksFileAsync(key: string): Promise<DelegatedTask[]> {
  const path = workspaceTasksPath(key)
  try {
    return parseTasksFile(JSON.parse(await readFile(path, 'utf8')), key)
  } catch (err) {
    // No file yet is an empty queue, not a fault. Catching ENOENT also
    // removes the existsSync/readFile race the sync path has to live with.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    const backup = `${path}.corrupt-${Date.now()}`
    try {
      renameSync(path, backup)
      logger.warn('Corrupt tasks.json moved aside', { scope: 'tasks', backup, err })
    } catch (renameErr) {
      logger.warn('Failed to read tasks.json — starting empty', {
        scope: 'tasks',
        workspacePath: key,
        err,
        renameErr
      })
    }
    return []
  }
}

/**
 * Warm the cache for every path in parallel, off the main thread.
 *
 * This is what keeps the synchronous mutation paths free of disk I/O: they
 * must stay synchronous (the durable `running` write runs inside
 * `launchRunSync`'s no-await claim window), so the fix is not to make them
 * async but to ensure the cache is already warm before they run. Boot reads
 * N workspaces at once instead of blocking on each in turn — which is the
 * difference between a hitch and a stall when a workspace lives on a network
 * share.
 */
async function preloadTasksForWorkspaces(workspacePaths: readonly string[]): Promise<boolean> {
  // Resolve cache keys up front, synchronously: cacheKeyFor scans existing
  // keys, so two parallel readers for equal-but-differently-spelled paths
  // would both miss and create two entries for one workspace.
  const pending = new Set<string>()
  for (const workspacePath of workspacePaths) {
    const key = cacheKeyFor(workspacePath)
    if (tasksCache.has(key)) continue
    pending.add(key)
  }
  if (pending.size === 0) return false
  const loaded = await Promise.all(
    [...pending].map(async (key) => ({ key, tasks: await readTasksFileAsync(key) }))
  )
  let loadedAny = false
  for (const { key, tasks } of loaded) {
    // A synchronous loadTasks may have raced us while we awaited; it read the
    // same file, so leave its entry rather than replacing a list that later
    // mutations may already have been applied to.
    if (tasksCache.has(key)) continue
    tasksCache.set(key, tasks)
    loadedAny = true
  }
  return loadedAny
}

/**
 * Drop the oldest terminal records past the retention cap. Active work
 * (queued/scheduled/running/cancelling) is never trimmed — only finished
 * history, newest first.
 */
function applyRetention(tasks: DelegatedTask[]): DelegatedTask[] {
  const terminal = tasks.filter((t) => isTerminalDelegatedTaskStatus(t.status))
  if (terminal.length <= TERMINAL_HISTORY_LIMIT) return tasks
  const keep = new Set(
    [...terminal]
      .sort((a, b) => (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt))
      .slice(0, TERMINAL_HISTORY_LIMIT)
      .map((t) => t.id)
  )
  return tasks.filter((t) => !isTerminalDelegatedTaskStatus(t.status) || keep.has(t.id))
}

/**
 * Validate, persist, then publish. Throws when the write fails so the caller
 * (and the IPC handler above it) reports the failure instead of acknowledging
 * a mutation that only ever existed in memory.
 */
function persistTasks(workspacePath: string, next: DelegatedTask[]): DelegatedTask[] {
  const key = cacheKeyFor(workspacePath)
  const retained = applyRetention(next)
  const validated = retained.map((task) => DelegatedTaskSchema.parse(task))
  atomicWriteJson(workspaceTasksPath(key), {
    version: DELEGATED_TASKS_FILE_VERSION,
    tasks: validated
  })
  tasksCache.set(key, validated)
  return validated
}

/**
 * Apply a batch of patches to one workspace in a single write and a single
 * push. Per-task writes would fan out one atomic write and one full-list
 * broadcast per row, and a mid-batch failure would leave the file holding a
 * partially applied reconciliation.
 */
function updateTasks(
  workspacePath: string,
  patches: ReadonlyMap<string, Partial<DelegatedTask>>,
  options: { emit?: boolean } = {}
): void {
  if (patches.size === 0) return
  const tasks = loadTasks(workspacePath)
  const next = tasks.map((t) => {
    const patch = patches.get(t.id)
    if (!patch) return t
    const merged: DelegatedTask = { ...t, ...patch }
    // `undefined` in a patch means "clear this field", which spread preserves
    // as an own key; strip them so the record matches its schema shape.
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) delete (merged as Record<string, unknown>)[field]
    }
    return merged
  })
  persistTasks(workspacePath, next)
  if (options.emit !== false) emitTasksChanged()
}

function updateTask(
  workspacePath: string,
  taskId: string,
  patch: Partial<DelegatedTask>,
  options: { emit?: boolean } = {}
): void {
  updateTasks(workspacePath, new Map([[taskId, patch]]), options)
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

function isWorkspaceOpen(path: string): boolean {
  return getWorkspaces().openPaths.some((open) => workspacePathsEqual(open, path))
}

/** Timers are keyed by the cache key so arm and cancel always agree. */
function timerKey(workspacePath: string, taskId: string): string {
  return `${cacheKeyFor(workspacePath)}\u0000${taskId}`
}

function clearTimerFor(workspacePath: string, taskId: string): void {
  const key = timerKey(workspacePath, taskId)
  const timer = timers.get(key)
  if (!timer) return
  clearTimeout(timer)
  timers.delete(key)
}

function armTimer(task: DelegatedTask): void {
  if (!task.scheduledAt || task.status !== 'scheduled') return
  const key = timerKey(task.workspacePath, task.id)
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
    try {
      updateTask(task.workspacePath, task.id, { status: 'queued', scheduledAt: undefined })
    } catch (err) {
      logger.error('Failed to queue a scheduled task', { scope: 'tasks', task: task.id, err })
      return
    }
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
  let next: DelegatedTask | null = null
  for (const tasks of tasksCache.values()) {
    for (const task of tasks) {
      if (task.profileId !== profileId || task.status !== 'queued') continue
      // A queued task whose workspace is closed cannot start. Skipping it
      // here — rather than picking it and letting startTask bail — stops it
      // head-of-line blocking a newer task for the same teammate in a
      // workspace that IS open.
      if (!isWorkspaceOpen(task.workspacePath)) continue
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
  // The shared launcher owns workspace validation, run-id allocation, the
  // atomic teammate claim, binding checks and the background start, so a
  // delegated run gets exactly the checks a user's chat send gets.
  const outcome = launchRunSync({
    workspacePath: task.workspacePath,
    messages: [{ role: 'user', content: task.prompt }],
    mode: 'agent',
    agentProfileId: task.profileId,
    delegatedTaskId: task.id,
    explicit: { agentProfileId: true },
    // Two runs on one teammate would interleave writes to a single memory
    // namespace; the claim is taken with the registration, not before it.
    requireProfileSlot: true,
    // The task must be durably `running` before any work starts — otherwise a
    // failed write leaves a live run that nothing is tracking.
    onClaimed: ({ runId }) => {
      updateTask(task.workspacePath, task.id, {
        status: 'running',
        runId,
        startedAt: new Date().toISOString()
      })
      runningByProfile.set(task.profileId, task.id)
      watchRun(runId, {
        workspaceKey: cacheKeyFor(task.workspacePath),
        taskId: task.id,
        profileId: task.profileId,
        missingSweeps: 0
      })
    },
    wc: main.webContents,
    source: 'delegatedTask'
  })
  if (!outcome.ok) {
    // The teammate is busy (user chat, resumed run, another task) or the
    // durable write failed. Leave the task queued; the run-finish listener
    // re-pumps when the identity frees up.
    logger.info('Task start deferred', {
      scope: 'tasks',
      task: task.id,
      reason: outcome.error
    })
    runningByProfile.delete(task.profileId)
  }
}

function watchRun(runId: string, watched: WatchedRun): void {
  watchedRuns.set(runId, watched)
  ensureReconcileLoop()
}

/**
 * One bounded sweep for every watched run, instead of an interval per task.
 * The run-finish listener is the primary signal; this is the backstop for a
 * run that dies without notifying (crash inside the terminal path).
 */
function ensureReconcileLoop(): void {
  if (reconcileTimer || watchedRuns.size === 0) return
  reconcileTimer = setInterval(() => {
    for (const runId of [...watchedRuns.keys()]) {
      finalizeWatchedRun(runId)
    }
    if (watchedRuns.size === 0 && reconcileTimer) {
      clearInterval(reconcileTimer)
      reconcileTimer = null
    }
  }, RECONCILE_INTERVAL_MS)
  reconcileTimer.unref?.()
}

/**
 * Move a task to its terminal state from the durable run status. Safe to call
 * more than once for a run (finish notification racing the backstop sweep):
 * the first call removes the watch entry.
 */
function finalizeWatchedRun(runId: string): void {
  const watched = watchedRuns.get(runId)
  if (!watched) return
  const { workspaceKey, taskId, profileId } = watched
  let status: ReturnType<typeof loadStatus> = null
  try {
    status = loadStatus(resolveRunDir(workspaceKey, runId))
  } catch (err) {
    logger.warn('Task completion status read failed', { scope: 'tasks', runId, err })
  }
  // The durable status is authoritative for terminal state: a run can persist
  // `done`/`error` while its registry slot is still unwinding, and waiting for
  // the slot would hold the teammate past the work actually finishing.
  if (status?.status === 'running') return
  if (!status) {
    // No status yet AND the slot is still live — the run is simply starting.
    if (isActive(runId)) return
    // Status never materialized (or the run dir vanished). Bound the wait —
    // otherwise the watch lives forever and the teammate's slot never frees.
    watched.missingSweeps += 1
    if (watched.missingSweeps < MISSING_STATUS_SWEEP_LIMIT) return
  }
  watchedRuns.delete(runId)
  runningByProfile.delete(profileId)
  const finishedAt = new Date().toISOString()
  // The run id is preserved on the terminal record so the transcript stays
  // openable from the task row — clearing it stranded the run's history.
  const patch: Partial<DelegatedTask> =
    status?.status === 'done'
      ? { status: 'done', runId, finishedAt }
      : status?.status === 'error'
        ? { status: 'failed', runId, error: status.error ?? 'Run failed', finishedAt }
        : status?.status === 'cancelled'
          ? { status: 'cancelled', runId, finishedAt }
          : {
              status: 'failed',
              runId,
              error: 'Run status unavailable — the run never started or its directory is gone',
              finishedAt
            }
  try {
    updateTask(workspaceKey, taskId, patch)
  } catch (err) {
    logger.error('Failed to persist a finished task', { scope: 'tasks', task: taskId, err })
  }
  pumpProfile(profileId)
}

/**
 * Enqueue a delegated task. Validates the profile and the open workspace.
 *
 * `internal` is deliberately a second parameter rather than a field on
 * `TaskEnqueueRequest`: the IPC handler parses and forwards only the request,
 * so a renderer cannot forge provenance it did not earn.
 */
export function enqueueTask(
  request: TaskEnqueueRequest,
  internal: { retryOf?: string } = {}
): DelegatedTask {
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
    workspacePath: cacheKeyFor(request.workspacePath),
    prompt: request.prompt,
    status,
    ...(status === 'scheduled' ? { scheduledAt: request.scheduledAt } : {}),
    ...(internal.retryOf ? { retryOf: internal.retryOf } : {}),
    createdAt: now.toISOString()
  }
  const tasks = loadTasks(request.workspacePath)
  // Write first: an enqueue that only reached the cache would be acknowledged
  // to the caller and then vanish on restart.
  persistTasks(request.workspacePath, [...tasks, task])
  emitTasksChanged()
  armTimer(task)
  if (status === 'queued') pumpProfile(request.profileId)
  // pumpProfile may have already transitioned the task to running — return the
  // stored record, not the pre-start snapshot.
  return loadTasks(request.workspacePath).find((t) => t.id === task.id) ?? task
}

/**
 * Re-run a terminal task as a NEW record. The original stays in history: a
 * task is an audited unit of delegated work, and retrying in place would erase
 * the attempt that failed.
 */
export function retryTask(taskId: string): DelegatedTask {
  for (const [workspacePath, tasks] of tasksCache) {
    const task = tasks.find((t) => t.id === taskId)
    if (!task) continue
    if (!isTerminalDelegatedTaskStatus(task.status)) {
      throw new Error('Only a finished task can be retried')
    }
    // Record the provenance link. Without it a retry is indistinguishable
    // from a fresh assignment, and retention can prune the attempt that
    // failed while keeping the retry that replaced it.
    return enqueueTask(
      {
        profileId: task.profileId,
        workspacePath,
        prompt: task.prompt
      },
      { retryOf: task.id }
    )
  }
  throw new Error(`Unknown task: ${taskId}`)
}

/** Cancel a queued/scheduled task immediately; a running task stops its run. */
export function cancelTask(taskId: string): boolean {
  for (const [workspacePath, tasks] of tasksCache) {
    const task = tasks.find((t) => t.id === taskId)
    if (!task) continue
    if (isTerminalDelegatedTaskStatus(task.status) || task.status === 'cancelling') return false
    clearTimerFor(workspacePath, task.id)
    if (task.status === 'running' && task.runId) {
      // Honour the registry's answer. A run that is already gone cannot be
      // stopped, and reporting success would leave the row stuck at
      // "cancelling" forever — finalize it from its durable status instead.
      if (!cancelRun(task.runId)) {
        finalizeWatchedRun(task.runId)
        return false
      }
      // Durable intermediate state: a restart mid-cancel must resume as
      // "stopping", not revive the task as running.
      updateTask(workspacePath, task.id, { status: 'cancelling' })
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
 * queued), rebuild ownership for runs still live in this process, and pump
 * free profiles.
 */
export function resumeTasksForWorkspaces(workspacePaths: readonly string[]): Promise<void> {
  // Serialized: boot and workspace-open can both call this, and two
  // interleaved reconciliations could each read the same rows and write back
  // a state computed before the other landed.
  resumeChain = resumeChain
    .then(() => resumeTasksForWorkspacesInner(workspacePaths))
    // Absorbed here on purpose: a rejection left on the chain would be
    // inherited by every later resume, so one bad workspace would stop all
    // future reconciliation — and surface as an unhandled rejection.
    .catch((err) => {
      logger.error('Task resume failed', { scope: 'tasks', err })
    })
  return resumeChain
}

async function resumeTasksForWorkspacesInner(workspacePaths: readonly string[]): Promise<void> {
  // Reading a workspace for the first time is itself renderer-visible news:
  // the renderer pulls `tasksList` once on mount, and at boot this runs after
  // first paint, so a workspace whose tasks need no transition (all terminal,
  // or scheduled far enough out that we only re-arm a timer) would otherwise
  // never reach the UI.
  //
  // The only await is here, BEFORE any mutation: everything below reads and
  // writes the warm cache synchronously, so no reconciliation can interleave
  // with another and lose an update.
  const loadedAnywhere = await preloadTasksForWorkspaces(workspacePaths)
  let mutatedAnywhere = false
  for (const workspacePath of workspacePaths) {
    const tasks = loadTasks(workspacePath)
    const key = cacheKeyFor(workspacePath)
    const patches = new Map<string, Partial<DelegatedTask>>()
    for (const task of tasks) {
      if (task.status === 'running' || task.status === 'cancelling') {
        // A run still live in THIS process keeps its ownership — rebuild the
        // watcher and the teammate claim, which live only in memory. Without
        // this the run finishes with nothing listening and the task is stuck
        // at running forever while its teammate stays blocked.
        if (task.runId && isActive(task.runId)) {
          runningByProfile.set(task.profileId, task.id)
          watchRun(task.runId, {
            workspaceKey: key,
            taskId: task.id,
            profileId: task.profileId,
            missingSweeps: 0
          })
          continue
        }
        // A task left running by a previous process can never see its watcher
        // again — finalize it from the durable run status. (Boot already
        // flipped orphan run statuses to cancelled; a missing run dir means
        // the run never started.) Re-queuing would duplicate delegated work.
        const status = task.runId ? loadStatus(resolveRunDir(key, task.runId)) : null
        const finishedAt = new Date().toISOString()
        // `runId` is deliberately retained on every branch: it is the only
        // link from a finished task row back to its transcript.
        if (status?.status === 'done') {
          patches.set(task.id, { status: 'done', finishedAt })
        } else if (status?.status === 'error') {
          patches.set(task.id, {
            status: 'failed',
            error: status.error ?? 'Run failed',
            finishedAt
          })
        } else if (status?.status === 'cancelled' || task.status === 'cancelling') {
          patches.set(task.id, { status: 'cancelled', finishedAt })
        } else {
          patches.set(task.id, {
            status: 'failed',
            error: 'Interrupted by app restart — retry to run it again',
            finishedAt
          })
        }
      } else if (task.status === 'scheduled') {
        if (task.scheduledAt && Date.parse(task.scheduledAt) <= Date.now()) {
          // Past due: disarm any timer still armed for it (wake-from-sleep edge)
          // before flipping to queued.
          clearTimerFor(workspacePath, task.id)
          patches.set(task.id, { status: 'queued', scheduledAt: undefined })
        } else {
          armTimer(task)
        }
      }
    }
    if (patches.size > 0) {
      try {
        // One write and no push per workspace; the single authoritative push
        // happens once every workspace has been reconciled.
        updateTasks(workspacePath, patches, { emit: false })
        mutatedAnywhere = true
      } catch (err) {
        logger.error('Failed to persist boot task reconciliation', {
          scope: 'tasks',
          workspacePath: key,
          err
        })
      }
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
  // A first read with no transitions is still news for the same reason.
  if (mutatedAnywhere || loadedAnywhere) emitTasksChanged()
}

/**
 * Cancel every non-terminal delegated task assigned to a profile (teammate
 * deleted). `workspacePaths` are loaded into the cache first: tasks only get
 * cached for workspaces this process has opened, so without it a queued task
 * in a closed workspace survives the delete and later fails as "profile no
 * longer exists" instead of being cancelled with the teammate.
 */
export function cancelTasksForProfile(
  profileId: string,
  workspacePaths: readonly string[] = []
): number {
  loadTasksForWorkspaces(workspacePaths)
  let cancelled = 0
  for (const [workspacePath, tasks] of tasksCache) {
    const patches = new Map<string, Partial<DelegatedTask>>()
    for (const task of tasks) {
      if (task.profileId !== profileId) continue
      if (isTerminalDelegatedTaskStatus(task.status)) continue
      clearTimerFor(workspacePath, task.id)
      if (task.status === 'running' && task.runId) {
        // The run's own terminal path finalizes the record.
        if (cancelRun(task.runId)) {
          patches.set(task.id, { status: 'cancelling' })
          cancelled += 1
          continue
        }
      }
      patches.set(task.id, {
        status: 'cancelled',
        error: 'Teammate deleted',
        finishedAt: new Date().toISOString()
      })
      cancelled += 1
    }
    if (patches.size === 0) continue
    try {
      // One write per workspace — a per-task write would fan out one atomic
      // write and one full-list broadcast per cancelled row.
      updateTasks(workspacePath, patches, { emit: false })
    } catch (err) {
      logger.error('Failed to persist profile task cancellation', {
        scope: 'tasks',
        workspacePath,
        profileId,
        err
      })
    }
  }
  if (cancelled > 0) emitTasksChanged()
  return cancelled
}

// Any run bound to a teammate ending (user chat, boot-resumed run, task) frees
// the identity. A delegated run is finalized directly from its own terminal
// status — no polling — and any other teammate run just re-pumps the queue.
registerProfileRunFinishListener((profileId, runId) => {
  if (watchedRuns.has(runId)) {
    finalizeWatchedRun(runId)
    return
  }
  if (tasksCache.size > 0) pumpProfile(profileId)
})

/** Test hook — reset in-memory scheduler state without touching disk files. */
export function resetTaskSchedulerForTests(): void {
  tasksCache.clear()
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  runningByProfile.clear()
  watchedRuns.clear()
  resumeChain = Promise.resolve()
  if (reconcileTimer) {
    clearInterval(reconcileTimer)
    reconcileTimer = null
  }
}
