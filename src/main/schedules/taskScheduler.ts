import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { powerMonitor, type WebContents } from 'electron'
import {
  ProviderIdSchemaAny,
  SCHEDULES_MAX,
  TaskScheduleSchema,
  type ChatMessage,
  type ProviderIdAny,
  type RunScheduled,
  type TaskSchedule,
  type TaskScheduleCreateRequest,
  type TaskScheduleOutcome,
  type TaskScheduleSource,
  type TaskScheduleUpdateRequest,
  type TaskScheduleWorktreeOpenRequest,
  type TaskScheduleWorktreeOpened
} from '../../shared/ipc'
import { IPC } from '../../shared/channels'
import { logger } from '../../shared/logger'
import { providerLabel } from '../../shared/providers'
import { describeSchedule, nextScheduleTime } from '../../shared/scheduleTime'
import { formatError } from '../../shared/utils/errors'
import { workspacePathsEqual } from '../../shared/workspacePath'
import { launchRunSync, type LaunchRunOutcome } from '../agent/launchRun'
import { resolveRunWebContents } from '../agent/launchRunInvoke'
import { isActive } from '../agent/runRegistry'
import { loadMessages, loadStatus } from '../agent/state'
import { readChecks } from '../agent/doneWhenChecks'
import { providerHasCredentials } from '../agent/agentTypes'
import { isGitRepo } from '../git/git'
import { createTaskWorktree, findTaskWorktree } from '../git/taskWorktrees'
import { getSettings } from '../settings/settings'
import { resolveRunDir } from '../storage/paths'
import { getWorkspaces } from '../workspace/workspaces'
import { readSchedules, writeSchedules } from './scheduleStore'

/**
 * Repeating tasks, while the app is open.
 *
 * One timer, armed for the soonest due schedule (and never longer than an
 * hour, so a changed clock is noticed). Each due schedule starts a new task
 * through the same launcher a typed one uses, so it lands in the navigator,
 * asks for approvals the same way, and counts against the same limits.
 *
 * Times missed while the app was closed or the machine slept are made up once
 * on start or wake — never once per missed slot — and the run says so. A
 * schedule whose last run is still going skips its turn and records the skip
 * rather than stacking a second run on the first.
 *
 * A schedule set to run in a new worktree makes it here, with the same
 * function New task's "in a new worktree" uses (same branch naming, same
 * registry, same no-automatic-cleanup: Merge/Discard on the task's strip).
 * Opening it as a workspace is the window's to do — the window owns which
 * workspaces are open, and main has no way to tell it about one it opened
 * itself — so main asks the window, and starts the run when it answers.
 */

/** A due time this late is a missed one being made up, not a timer firing on time. */
export const CATCH_UP_GRACE_MS = 2 * 60_000
/** The timer re-checks at least this often. */
const MAX_TIMER_MS = 60 * 60_000
/** How long the window gets to open a scheduled run's worktree before the run is given up. */
export const WORKTREE_OPEN_TIMEOUT_MS = 2 * 60_000

let timer: ReturnType<typeof setTimeout> | null = null
let started = false
let now: () => Date = () => new Date()

type PinnedModel = { provider?: ProviderIdAny; model?: string; note?: string }

/** A scheduled run waiting on its worktree: being made, then being opened by the window. */
type PendingWorktree = {
  token: string
  schedule: TaskSchedule
  scheduled: RunScheduled
  manual: boolean
  pinned: PinnedModel
  catchUpNote?: string
  workspacePath?: string
  branch?: string
  timer?: ReturnType<typeof setTimeout>
}

const pendingWorktrees = new Map<string, PendingWorktree>()

function iso(date: Date): string {
  return date.toISOString()
}

function nextAfter(schedule: Pick<TaskSchedule, 'schedule'>, after: Date): string | undefined {
  const next = nextScheduleTime(schedule.schedule, after)
  return next ? iso(next) : undefined
}

function formatLocal(isoTime: string): string {
  const d = new Date(isoTime)
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function textOf(message: ChatMessage | undefined): string {
  if (!message) return ''
  const content = message.content as unknown
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) =>
        part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
          ? String((part as { text?: unknown }).text ?? '')
          : ''
      )
      .join('')
  }
  return ''
}

function isOpenWorkspacePath(path: string): boolean {
  return getWorkspaces().openPaths.some((open) => workspacePathsEqual(open, path))
}

/**
 * The model a task ran on: the provider and model its receipt (`receipt.json`,
 * runReceipt.ts) was last written with. Absent when it never reached a step.
 */
function modelFromRun(runDir: string): { provider: ProviderIdAny; model: string } | null {
  try {
    const raw = JSON.parse(readFileSync(join(runDir, 'receipt.json'), 'utf8')) as {
      provider?: unknown
      model?: unknown
    }
    const provider = ProviderIdSchemaAny.safeParse(raw?.provider)
    const model = typeof raw?.model === 'string' ? raw.model.trim() : ''
    return provider.success && model ? { provider: provider.data, model } : null
  } catch {
    return null
  }
}

type RunBrief = {
  instruction: string
  mode?: TaskSchedule['mode']
  doneWhen?: string[]
  provider?: ProviderIdAny
  model?: string
}

/** A finished or past task's first instruction, mode, brief checks and model — what Repeat… repeats. */
function briefFromRun(workspacePath: string, runId: string): RunBrief {
  const first = loadMessages(workspacePath, runId).find((m) => m.role === 'user')
  const instruction = textOf(first).trim()
  if (!instruction) throw new Error('That task has no instruction to repeat')
  const runDir = resolveRunDir(workspacePath, runId)
  const status = loadStatus(runDir)
  const doneWhen = readChecks(runDir)
    .filter((c) => c.source === 'brief')
    .map((c) => c.text)
  const ranOn = modelFromRun(runDir)
  return {
    instruction,
    ...(status?.mode ? { mode: status.mode } : {}),
    ...(doneWhen.length ? { doneWhen } : {}),
    ...(ranOn ? { provider: ranOn.provider, model: ranOn.model } : {})
  }
}

/** What Repeat… on a task would repeat, for the dialog to show before it asks when. */
export async function readScheduleSource(workspacePath: string, runId: string): Promise<TaskScheduleSource> {
  const brief = briefFromRun(workspacePath, runId)
  const worktree = await findTaskWorktree(workspacePath)
  return {
    instruction: brief.instruction,
    ...(brief.mode ? { mode: brief.mode } : {}),
    ...(brief.provider && brief.model ? { provider: brief.provider, model: brief.model } : {}),
    ...(worktree ? { worktreeBranch: worktree.branch } : {}),
    canWorktree: isGitRepo(worktree?.parentPath ?? workspacePath)
  }
}

/**
 * The pinned model, or none (the default at run time) when its provider can no
 * longer run a request — the key was cleared, the custom provider removed.
 */
function pinnedModelFor(schedule: TaskSchedule): PinnedModel {
  if (!schedule.provider || !schedule.model) return {}
  let usable = false
  let label: string = schedule.provider
  try {
    const settings = getSettings()
    label = providerLabel(schedule.provider, settings.customProviders)
    usable = providerHasCredentials(schedule.provider, settings)
  } catch (err) {
    logger.warn('Could not check the scheduled model’s provider', { scope: 'schedules', err })
  }
  if (usable) return { provider: schedule.provider, model: schedule.model }
  return { note: `Ran on the default model: ${label} has no key set for ${schedule.model}` }
}

function notes(...parts: Array<string | undefined>): string | undefined {
  const text = parts.filter(Boolean).join(' · ')
  return text ? text.slice(0, 500) : undefined
}

function save(schedules: TaskSchedule[]): void {
  writeSchedules(schedules)
}

function patch(id: string, update: (s: TaskSchedule) => TaskSchedule): TaskSchedule {
  const schedules = readSchedules()
  const index = schedules.findIndex((s) => s.id === id)
  if (index < 0) throw new Error('Schedule not found')
  const next = TaskScheduleSchema.parse(update(schedules[index]!))
  schedules[index] = next
  save(schedules)
  return next
}

function launch(
  schedule: TaskSchedule,
  workspacePath: string,
  pinned: PinnedModel,
  scheduled: RunScheduled,
  wc: WebContents,
  manual: boolean
): LaunchRunOutcome {
  const message: ChatMessage = { role: 'user', content: schedule.instruction, at: iso(now()) }
  return launchRunSync({
    workspacePath,
    messages: [message],
    mode: schedule.mode,
    ...(pinned.provider && pinned.model ? { provider: pinned.provider, model: pinned.model } : {}),
    ...(schedule.doneWhen?.length ? { doneWhen: schedule.doneWhen } : {}),
    scheduled,
    wc,
    source: manual ? 'schedule:run-now' : 'schedule'
  })
}

function hasPendingWorktree(scheduleId: string): boolean {
  for (const pending of pendingWorktrees.values()) if (pending.schedule.id === scheduleId) return true
  return false
}

/**
 * Start one run for `schedule`, or record why not. Returns the schedule as
 * written. `catchUpFrom` marks a made-up missed time; `manual` is Run now,
 * which leaves the next due time where it was.
 */
function fire(
  schedule: TaskSchedule,
  at: Date,
  options: { catchUpFrom?: string; manual?: boolean } = {}
): TaskSchedule {
  const advance = options.manual ? {} : { nextRunAt: nextAfter(schedule, at) }
  const record = (outcome: TaskScheduleOutcome, extra: Partial<TaskSchedule> = {}): TaskSchedule => {
    const written = patch(schedule.id, (s) => {
      const next: TaskSchedule = { ...s, ...advance, ...extra, lastOutcome: outcome }
      if (!next.nextRunAt) delete next.nextRunAt
      return next
    })
    return written
  }

  if (hasPendingWorktree(schedule.id)) {
    return record({ kind: 'skipped', at: iso(at), detail: 'The last run was still starting' })
  }
  if (schedule.lastRunId && isActive(schedule.lastRunId)) {
    logger.info('Scheduled run skipped: the last one is still going', {
      scope: 'schedules',
      correlationId: schedule.lastRunId
    })
    return record({
      kind: 'skipped',
      at: iso(at),
      runId: schedule.lastRunId,
      detail: 'The last run was still going'
    })
  }

  const catchUpNote = options.catchUpFrom
    ? `Catching up a missed run from ${formatLocal(options.catchUpFrom)}`
    : undefined
  const wc = resolveRunWebContents()
  if (!wc) {
    return record({
      kind: 'failed',
      at: iso(at),
      detail: schedule.worktree ? 'Needs the window open' : 'No Agent V window was open'
    })
  }
  const scheduled: RunScheduled = {
    scheduleId: schedule.id,
    label: describeSchedule(schedule.schedule),
    ...(options.catchUpFrom ? { catchUpFrom: options.catchUpFrom } : {})
  }
  const pinned = pinnedModelFor(schedule)

  if (schedule.worktree) {
    // The same refusal New task's worktree path meets (the create IPC's check).
    if (!isOpenWorkspacePath(schedule.workspacePath)) {
      return record({ kind: 'failed', at: iso(at), detail: 'Workspace is not open' })
    }
    const pending: PendingWorktree = {
      token: randomUUID(),
      schedule,
      scheduled,
      manual: Boolean(options.manual),
      pinned,
      ...(catchUpNote ? { catchUpNote } : {})
    }
    pendingWorktrees.set(pending.token, pending)
    const written = record({ kind: 'starting', at: iso(at), detail: 'Making a new worktree' })
    void makeWorktree(pending)
    return written
  }

  const outcome = launch(schedule, schedule.workspacePath, pinned, scheduled, wc, Boolean(options.manual))
  if (!outcome.ok) {
    logger.warn(`Scheduled run did not start: ${outcome.error}`, { scope: 'schedules', code: outcome.code })
    return record({ kind: 'failed', at: iso(at), detail: outcome.error })
  }
  const detail = notes(catchUpNote, pinned.note)
  return record(
    {
      kind: 'started',
      at: iso(at),
      runId: outcome.runId,
      ...(detail ? { detail } : {})
    },
    { lastRunAt: iso(at), lastRunId: outcome.runId }
  )
}

/** Write how a worktree run ended up, and stop waiting on it. Null when the schedule is gone. */
function settle(
  pending: PendingWorktree,
  outcome: Omit<TaskScheduleOutcome, 'at'>,
  extra: Partial<TaskSchedule> = {}
): TaskSchedule | null {
  pendingWorktrees.delete(pending.token)
  if (pending.timer) clearTimeout(pending.timer)
  if (outcome.kind === 'failed') {
    logger.warn(`Scheduled worktree run did not start: ${outcome.detail ?? ''}`, { scope: 'schedules' })
  }
  try {
    return patch(pending.schedule.id, (s) => ({ ...s, ...extra, lastOutcome: { ...outcome, at: iso(now()) } }))
  } catch (err) {
    // Deleted while its worktree was being made: nothing left to record on.
    logger.info('Scheduled worktree run settled after its schedule was deleted', { scope: 'schedules', err })
    return null
  }
}

async function makeWorktree(pending: PendingWorktree): Promise<void> {
  let made: Awaited<ReturnType<typeof createTaskWorktree>>
  try {
    made = await createTaskWorktree(pending.schedule.workspacePath, pending.schedule.instruction)
  } catch (err) {
    if (pendingWorktrees.has(pending.token)) settle(pending, { kind: 'failed', detail: formatError(err).slice(0, 500) })
    return
  }
  // Stopped (app quitting) while git ran: the worktree stays, like any other.
  if (!pendingWorktrees.has(pending.token)) return
  pending.workspacePath = made.workspacePath
  pending.branch = made.branch
  const wc = resolveRunWebContents()
  if (!wc) {
    settle(pending, { kind: 'failed', detail: `Made the worktree ${made.branch}, but needs the window open to start in it` })
    return
  }
  pending.timer = setTimeout(() => {
    if (!pendingWorktrees.has(pending.token)) return
    settle(pending, { kind: 'failed', detail: `Made the worktree ${made.branch}, but the window didn’t open it` })
  }, WORKTREE_OPEN_TIMEOUT_MS)
  const request: TaskScheduleWorktreeOpenRequest = {
    token: pending.token,
    scheduleId: pending.schedule.id,
    workspacePath: made.workspacePath,
    branch: made.branch
  }
  try {
    wc.send(IPC.schedulesWorktreeOpen, request)
  } catch (err) {
    settle(pending, { kind: 'failed', detail: `Made the worktree ${made.branch}, but couldn’t reach the window` })
    logger.warn('Could not ask the window to open a scheduled worktree', { scope: 'schedules', err })
  }
}

/**
 * The window opened (or could not open) a scheduled run's worktree: start the
 * run there, and record it. Returns the schedule as written; null when it was
 * deleted meanwhile.
 */
export function scheduledWorktreeOpened(reply: TaskScheduleWorktreeOpened): TaskSchedule | null {
  const pending = pendingWorktrees.get(reply.token)
  if (!pending?.workspacePath || !pending.branch) throw new Error('No scheduled run is waiting on that worktree')
  const branch = pending.branch
  if (reply.error) {
    return settle(pending, { kind: 'failed', detail: `Made the worktree ${branch}, but couldn’t open it: ${reply.error}` })
  }
  if (!readSchedules().some((s) => s.id === pending.schedule.id)) return settle(pending, { kind: 'failed' })
  const wc = resolveRunWebContents()
  if (!wc) return settle(pending, { kind: 'failed', detail: 'Needs the window open' })
  const outcome = launch(pending.schedule, pending.workspacePath, pending.pinned, pending.scheduled, wc, pending.manual)
  if (!outcome.ok) {
    return settle(pending, { kind: 'failed', detail: `Made the worktree ${branch}, but ${outcome.error}` })
  }
  const detail = notes(pending.catchUpNote, pending.pinned.note, `In ${branch}`)
  const startedAt = iso(now())
  return settle(
    pending,
    { kind: 'started', runId: outcome.runId, ...(detail ? { detail } : {}) },
    { lastRunAt: startedAt, lastRunId: outcome.runId }
  )
}

/** Fire every enabled schedule that is due, once each, then re-arm. */
export function runDueSchedules(): void {
  const at = now()
  for (const schedule of readSchedules()) {
    if (!schedule.enabled || !schedule.nextRunAt) continue
    const due = Date.parse(schedule.nextRunAt)
    if (!Number.isFinite(due) || due > at.getTime()) continue
    const late = at.getTime() - due > CATCH_UP_GRACE_MS
    try {
      fire(schedule, at, late ? { catchUpFrom: schedule.nextRunAt } : {})
    } catch (err) {
      logger.warn('Scheduled run failed to fire', { scope: 'schedules', err })
    }
  }
  arm()
}

function arm(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (!started) return
  const soonest = readSchedules()
    .filter((s) => s.enabled && s.nextRunAt)
    .map((s) => Date.parse(s.nextRunAt!))
    .filter((t) => Number.isFinite(t))
    .reduce((min, t) => Math.min(min, t), Number.POSITIVE_INFINITY)
  if (soonest === Number.POSITIVE_INFINITY) return
  const delay = Math.max(0, Math.min(MAX_TIMER_MS, soonest - now().getTime()))
  timer = setTimeout(() => {
    timer = null
    runDueSchedules()
  }, delay)
}

const onResume = (): void => {
  logger.info('Woke from sleep; checking schedules', { scope: 'schedules' })
  runDueSchedules()
}

/** A "starting" left on disk by a quit mid-worktree never finishes now; say so. */
function settleAbandonedStarts(): void {
  const schedules = readSchedules()
  let changed = false
  const next = schedules.map((s) => {
    if (s.lastOutcome?.kind !== 'starting') return s
    changed = true
    return {
      ...s,
      lastOutcome: { kind: 'failed' as const, at: s.lastOutcome.at, detail: 'Agent V closed before it started' }
    }
  })
  if (changed) save(next)
}

/** Start watching schedules: make up missed times once, then arm the timer. Idempotent. */
export function startTaskScheduler(): void {
  if (started) return
  started = true
  try {
    settleAbandonedStarts()
  } catch (err) {
    logger.warn('Could not tidy unfinished scheduled starts', { scope: 'schedules', err })
  }
  try {
    powerMonitor.on('resume', onResume)
  } catch (err) {
    logger.warn('Could not watch for wake from sleep', { scope: 'schedules', err })
  }
  runDueSchedules()
}

export function stopTaskScheduler(): void {
  // A worktree still being made or opened is let go: its run never starts.
  for (const pending of pendingWorktrees.values()) if (pending.timer) clearTimeout(pending.timer)
  pendingWorktrees.clear()
  if (!started) return
  started = false
  if (timer) clearTimeout(timer)
  timer = null
  try {
    powerMonitor.removeListener('resume', onResume)
  } catch {
    /* already gone */
  }
}

export function listSchedules(): TaskSchedule[] {
  return readSchedules().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function requireGitForWorktree(workspacePath: string): void {
  if (!isGitRepo(workspacePath)) throw new Error('A new worktree each run needs a git repository')
}

/**
 * New schedule. From a task (`fromRunId`), its brief, mode, checks and model
 * come from its record unless the request says otherwise; `worktreeParent` is
 * where a task that ran in a worktree of its own branches from next time.
 */
export function createSchedule(
  req: TaskScheduleCreateRequest,
  opts: { worktreeParent?: string } = {}
): TaskSchedule {
  const schedules = readSchedules()
  if (schedules.length >= SCHEDULES_MAX) throw new Error(`At most ${SCHEDULES_MAX} schedules`)
  const fromRun = req.fromRunId ? briefFromRun(req.workspacePath, req.fromRunId) : null
  const workspacePath = req.worktree && opts.worktreeParent ? opts.worktreeParent : req.workspacePath
  if (req.worktree) requireGitForWorktree(workspacePath)
  // Absent: the task's own model. Null: none (the default when it runs).
  const provider = req.provider === undefined ? fromRun?.provider : (req.provider ?? undefined)
  const model = req.model === undefined ? fromRun?.model : (req.model ?? undefined)
  const doneWhen = req.doneWhen ?? fromRun?.doneWhen
  const at = now()
  const schedule = TaskScheduleSchema.parse({
    id: randomUUID(),
    workspacePath,
    instruction: fromRun?.instruction ?? req.instruction,
    mode: req.mode ?? fromRun?.mode ?? 'agent',
    ...(provider && model ? { provider, model } : {}),
    ...(doneWhen?.length ? { doneWhen } : {}),
    ...(req.worktree ? { worktree: true } : {}),
    schedule: req.schedule,
    enabled: req.enabled ?? true,
    nextRunAt: nextAfter({ schedule: req.schedule }, at),
    createdAt: iso(at)
  })
  save([...schedules, schedule])
  arm()
  return schedule
}

/**
 * Create, finding a source task's worktree parent first: Repeat… on a task
 * that ran in its own worktree, set to a new worktree each run, branches from
 * the folder that worktree came from — not from the old worktree.
 */
export async function createScheduleFromRequest(req: TaskScheduleCreateRequest): Promise<TaskSchedule> {
  const worktree = req.fromRunId && req.worktree ? await findTaskWorktree(req.workspacePath) : null
  return createSchedule(req, worktree ? { worktreeParent: worktree.parentPath } : {})
}

function sameSpec(a: TaskSchedule['schedule'], b: TaskSchedule['schedule']): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function updateSchedule(req: TaskScheduleUpdateRequest): TaskSchedule {
  const at = now()
  const next = patch(req.id, (s) => {
    const updated: TaskSchedule = {
      ...s,
      ...(req.instruction ? { instruction: req.instruction } : {}),
      ...(req.mode ? { mode: req.mode } : {}),
      ...(req.schedule ? { schedule: req.schedule } : {}),
      ...(req.enabled !== undefined ? { enabled: req.enabled } : {})
    }
    if (req.provider !== undefined) {
      if (req.provider && req.model) {
        updated.provider = req.provider
        updated.model = req.model
      } else {
        delete updated.provider
        delete updated.model
      }
    }
    if (req.worktree !== undefined) {
      if (req.worktree) {
        if (!s.worktree) requireGitForWorktree(s.workspacePath)
        updated.worktree = true
      } else {
        delete updated.worktree
      }
    }
    // A new time, or turning it back on: due next from now, not from whenever it was last due.
    // Saving the same time (Edit changing only the brief) leaves the next run where it was.
    const newTime = req.schedule !== undefined && !sameSpec(req.schedule, s.schedule)
    if (newTime || (req.enabled === true && !s.enabled)) {
      const due = nextAfter(updated, at)
      if (due) updated.nextRunAt = due
      else delete updated.nextRunAt
    }
    return updated
  })
  arm()
  return next
}

export function toggleSchedule(id: string, enabled: boolean): TaskSchedule {
  return updateSchedule({ id, enabled })
}

export function deleteSchedule(id: string): boolean {
  const schedules = readSchedules()
  const kept = schedules.filter((s) => s.id !== id)
  if (kept.length === schedules.length) return false
  save(kept)
  arm()
  return true
}

/** Run now: one run at once, outside the timetable (the next due time stays). */
export function runScheduleNow(id: string): TaskSchedule {
  const schedule = readSchedules().find((s) => s.id === id)
  if (!schedule) throw new Error('Schedule not found')
  const written = fire(schedule, now(), { manual: true })
  arm()
  return written
}

/** Tests: a fake clock, and the timer state cleared. */
export function setSchedulerClockForTests(clock: (() => Date) | null): void {
  now = clock ?? (() => new Date())
}

export function isSchedulerArmedForTests(): boolean {
  return timer !== null
}
