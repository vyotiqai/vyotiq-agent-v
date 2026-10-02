import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  userData,
  power,
  launchRunSync,
  isActive,
  resolveRunWebContents,
  loadMessages,
  loadStatus,
  readChecks,
  createTaskWorktree,
  findTaskWorktree,
  isGitRepo,
  providerHasCredentials,
  openPaths,
  send
} = vi.hoisted(() => {
  const { EventEmitter: Emitter } = require('events') as typeof import('events')
  const os = require('os') as typeof import('os')
  const path = require('path') as typeof import('path')
  return {
    userData: path.join(os.tmpdir(), `vyotiq-schedules-${process.pid}-${Date.now()}`),
    power: new Emitter(),
    launchRunSync: vi.fn(),
    isActive: vi.fn((_runId: string) => false),
    resolveRunWebContents: vi.fn((): unknown => ({ id: 1 })),
    loadMessages: vi.fn((): unknown[] => []),
    loadStatus: vi.fn((): unknown => null),
    readChecks: vi.fn((): unknown[] => []),
    createTaskWorktree: vi.fn(async (_parent: string, _brief: string): Promise<unknown> => null),
    findTaskWorktree: vi.fn(async (_path: string): Promise<unknown> => null),
    isGitRepo: vi.fn((_path: string) => true),
    providerHasCredentials: vi.fn((_provider: string) => true),
    openPaths: [] as string[],
    send: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? userData : tmpdir()) },
  powerMonitor: power
}))

vi.mock('@main/agent/launchRun', () => ({ launchRunSync: (req: unknown) => launchRunSync(req) }))
vi.mock('@main/agent/launchRunInvoke', () => ({ resolveRunWebContents: () => resolveRunWebContents() }))
vi.mock('@main/agent/runRegistry', () => ({ isActive: (id: string) => isActive(id) }))
vi.mock('@main/agent/state', () => ({ loadMessages: () => loadMessages(), loadStatus: () => loadStatus() }))
vi.mock('@main/agent/doneWhenChecks', () => ({ readChecks: () => readChecks() }))
vi.mock('@main/git/taskWorktrees', () => ({
  createTaskWorktree: (parent: string, brief: string) => createTaskWorktree(parent, brief),
  findTaskWorktree: (path: string) => findTaskWorktree(path)
}))
vi.mock('@main/git/git', () => ({ isGitRepo: (path: string) => isGitRepo(path) }))
vi.mock('@main/agent/agentTypes', () => ({
  providerHasCredentials: (provider: string) => providerHasCredentials(provider)
}))
vi.mock('@main/settings/settings', () => ({ getSettings: () => ({ customProviders: [] }) }))
vi.mock('@main/workspace/workspaces', () => ({ getWorkspaces: () => ({ openPaths }) }))

import {
  TaskScheduleCreateRequestSchema,
  TaskScheduleSpecSchema,
  TaskScheduleToggleRequestSchema,
  TaskScheduleUpdateRequestSchema,
  type TaskSchedule
} from '@shared/ipc'
import {
  CATCH_UP_GRACE_MS,
  WORKTREE_OPEN_TIMEOUT_MS,
  createSchedule,
  createScheduleFromRequest,
  deleteSchedule,
  isSchedulerArmedForTests,
  listSchedules,
  readScheduleSource,
  runScheduleNow,
  scheduledWorktreeOpened,
  startTaskScheduler,
  stopTaskScheduler,
  toggleSchedule,
  updateSchedule
} from '@main/schedules/taskScheduler'
import { resolveRunDir } from '@main/storage/paths'
import { IPC } from '@shared/channels'
import { parseSchedulesFile, readSchedules, resetScheduleStoreCache, schedulesPath, writeSchedules } from '@main/schedules/scheduleStore'

const ws = join(userData, 'repo')
const HOUR = 3_600_000

let runSeq = 0
beforeEach(() => {
  mkdirSync(ws, { recursive: true })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  // Thursday 2026-03-05, 08:00 local.
  vi.setSystemTime(new Date(2026, 2, 5, 8, 0, 0))
  runSeq = 0
  launchRunSync.mockReset()
  launchRunSync.mockImplementation(() => ({ ok: true, runId: `run-${++runSeq}`, invokeId: 1, resume: false }))
  isActive.mockReset()
  isActive.mockReturnValue(false)
  resolveRunWebContents.mockReset()
  send.mockReset()
  resolveRunWebContents.mockReturnValue({ id: 1, send })
  createTaskWorktree.mockReset()
  findTaskWorktree.mockReset()
  findTaskWorktree.mockResolvedValue(null)
  isGitRepo.mockReset()
  isGitRepo.mockReturnValue(true)
  providerHasCredentials.mockReset()
  providerHasCredentials.mockReturnValue(true)
  loadMessages.mockReset()
  loadMessages.mockReturnValue([])
  loadStatus.mockReset()
  loadStatus.mockReturnValue(null)
  readChecks.mockReset()
  readChecks.mockReturnValue([])
  openPaths.splice(0, openPaths.length, ws)
  resetScheduleStoreCache()
})

afterEach(() => {
  stopTaskScheduler()
  vi.useRealTimers()
  resetScheduleStoreCache()
  rmSync(userData, { recursive: true, force: true })
})

function daily(time = '09:00'): TaskSchedule {
  return createSchedule({ workspacePath: ws, instruction: 'Summarize open PRs', schedule: { kind: 'daily', time } })
}

function only(): TaskSchedule {
  const [schedule] = readSchedules()
  return schedule!
}

describe('task scheduler', () => {
  it('launches a due schedule once, through the shared launcher, marked as scheduled', () => {
    const created = daily()
    expect(created.nextRunAt).toBe(new Date(2026, 2, 5, 9, 0).toISOString())
    startTaskScheduler()
    expect(launchRunSync).not.toHaveBeenCalled()
    expect(isSchedulerArmedForTests()).toBe(true)

    vi.advanceTimersByTime(HOUR)
    expect(launchRunSync).toHaveBeenCalledTimes(1)
    const req = launchRunSync.mock.calls[0]![0] as Record<string, unknown>
    expect(req).toMatchObject({
      workspacePath: ws,
      mode: 'agent',
      source: 'schedule',
      scheduled: { scheduleId: created.id, label: 'Daily at 09:00' }
    })
    expect((req.scheduled as Record<string, unknown>).catchUpFrom).toBeUndefined()
    expect((req.messages as Array<{ role: string; content: string }>)[0]).toMatchObject({
      role: 'user',
      content: 'Summarize open PRs'
    })
    const after = only()
    expect(after.lastRunId).toBe('run-1')
    expect(after.lastOutcome).toMatchObject({ kind: 'started', runId: 'run-1' })
    expect(after.nextRunAt).toBe(new Date(2026, 2, 6, 9, 0).toISOString())

    // Nothing more until tomorrow's 09:00.
    vi.advanceTimersByTime(23 * HOUR)
    expect(launchRunSync).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(HOUR)
    expect(launchRunSync).toHaveBeenCalledTimes(2)
  })

  it('skips a turn while the last run is still going, and records the skip', () => {
    daily()
    startTaskScheduler()
    vi.advanceTimersByTime(HOUR)
    expect(launchRunSync).toHaveBeenCalledTimes(1)
    isActive.mockImplementation((id) => id === 'run-1')

    vi.advanceTimersByTime(24 * HOUR)
    expect(launchRunSync).toHaveBeenCalledTimes(1)
    const after = only()
    expect(after.lastOutcome).toMatchObject({ kind: 'skipped', runId: 'run-1' })
    expect(after.lastOutcome?.detail).toMatch(/still going/)
    expect(after.lastRunId).toBe('run-1')
    expect(after.nextRunAt).toBe(new Date(2026, 2, 7, 9, 0).toISOString())
  })

  it('makes up times missed while closed once, not once per missed slot', () => {
    const created = daily()
    const missedFrom = new Date(2026, 2, 2, 9, 0).toISOString()
    writeSchedules([{ ...created, nextRunAt: missedFrom }])
    resetScheduleStoreCache()

    startTaskScheduler()
    expect(launchRunSync).toHaveBeenCalledTimes(1)
    const req = launchRunSync.mock.calls[0]![0] as { scheduled: { catchUpFrom?: string } }
    expect(req.scheduled.catchUpFrom).toBe(missedFrom)
    const after = only()
    expect(after.lastOutcome?.kind).toBe('started')
    expect(after.lastOutcome?.detail).toMatch(/^Catching up a missed run from /)
    // Today's 09:00 is still ahead: due next then, not again for each missed day.
    expect(after.nextRunAt).toBe(new Date(2026, 2, 5, 9, 0).toISOString())
  })

  it('a timer firing a little late is on time, not a catch-up', () => {
    daily('08:00')
    // Due tomorrow 08:00; wake just inside the grace after it.
    vi.setSystemTime(new Date(new Date(2026, 2, 6, 8, 0).getTime() + CATCH_UP_GRACE_MS - 1000))
    startTaskScheduler()
    const req = launchRunSync.mock.calls[0]![0] as { scheduled: { catchUpFrom?: string } }
    expect(req.scheduled.catchUpFrom).toBeUndefined()
  })

  it('a disabled schedule never fires; turning it back on is due from now', () => {
    const created = daily()
    startTaskScheduler()
    toggleSchedule(created.id, false)
    expect(isSchedulerArmedForTests()).toBe(false)
    vi.advanceTimersByTime(3 * 24 * HOUR)
    expect(launchRunSync).not.toHaveBeenCalled()

    const back = toggleSchedule(created.id, true)
    expect(Date.parse(back.nextRunAt!)).toBeGreaterThan(Date.now())
    expect(launchRunSync).not.toHaveBeenCalled()
    expect(isSchedulerArmedForTests()).toBe(true)
  })

  it('deleting the last schedule clears the timer', () => {
    const created = daily()
    startTaskScheduler()
    expect(isSchedulerArmedForTests()).toBe(true)
    expect(deleteSchedule(created.id)).toBe(true)
    expect(deleteSchedule(created.id)).toBe(false)
    expect(isSchedulerArmedForTests()).toBe(false)
    vi.advanceTimersByTime(2 * 24 * HOUR)
    expect(launchRunSync).not.toHaveBeenCalled()
    expect(listSchedules()).toEqual([])
  })

  it('waking from sleep checks again: a slept-through time runs once', () => {
    daily()
    startTaskScheduler()
    // The machine sleeps through 09:00: the clock jumps, no timer has run.
    vi.setSystemTime(new Date(2026, 2, 5, 13, 0))
    power.emit('resume')
    expect(launchRunSync).toHaveBeenCalledTimes(1)
    const req = launchRunSync.mock.calls[0]![0] as { scheduled: { catchUpFrom?: string } }
    expect(req.scheduled.catchUpFrom).toBe(new Date(2026, 2, 5, 9, 0).toISOString())
    power.emit('resume')
    expect(launchRunSync).toHaveBeenCalledTimes(1)
  })

  it('stops listening for wake once stopped', () => {
    daily()
    startTaskScheduler()
    stopTaskScheduler()
    vi.setSystemTime(new Date(2026, 2, 5, 13, 0))
    power.emit('resume')
    expect(launchRunSync).not.toHaveBeenCalled()
    expect(isSchedulerArmedForTests()).toBe(false)
  })

  it('a refused launch is recorded and the schedule moves on', () => {
    launchRunSync.mockImplementation(() => ({ ok: false, error: 'Workspace is not open', code: 'workspace_not_open' }))
    daily()
    startTaskScheduler()
    vi.advanceTimersByTime(HOUR)
    const after = only()
    expect(after.lastOutcome).toMatchObject({ kind: 'failed', detail: 'Workspace is not open' })
    expect(after.lastRunId).toBeUndefined()
    expect(after.nextRunAt).toBe(new Date(2026, 2, 6, 9, 0).toISOString())
  })

  it('no window: recorded as failed, nothing launched', () => {
    resolveRunWebContents.mockReturnValue(null)
    daily()
    startTaskScheduler()
    vi.advanceTimersByTime(HOUR)
    expect(launchRunSync).not.toHaveBeenCalled()
    expect(only().lastOutcome?.kind).toBe('failed')
  })

  it('Run now starts one run and leaves the timetable alone', () => {
    const created = daily()
    const written = runScheduleNow(created.id)
    expect(launchRunSync).toHaveBeenCalledTimes(1)
    expect((launchRunSync.mock.calls[0]![0] as { source: string }).source).toBe('schedule:run-now')
    expect(written.lastOutcome?.kind).toBe('started')
    expect(written.nextRunAt).toBe(created.nextRunAt)
    // And it is refused (as a skip) while that run is going.
    isActive.mockReturnValue(true)
    expect(runScheduleNow(created.id).lastOutcome?.kind).toBe('skipped')
    expect(launchRunSync).toHaveBeenCalledTimes(1)
  })

  it('an interval counts from the run, and a new time re-arms from now', () => {
    const created = createSchedule({ workspacePath: ws, instruction: 'Poll', schedule: { kind: 'interval', minutes: 30 } })
    expect(Date.parse(created.nextRunAt!) - Date.now()).toBe(30 * 60_000)
    startTaskScheduler()
    vi.advanceTimersByTime(30 * 60_000)
    expect(launchRunSync).toHaveBeenCalledTimes(1)
    expect(Date.parse(only().nextRunAt!) - Date.now()).toBe(30 * 60_000)
    const moved = updateSchedule({ id: created.id, schedule: { kind: 'daily', time: '20:00' } })
    expect(moved.nextRunAt).toBe(new Date(2026, 2, 5, 20, 0).toISOString())
  })

  it('Repeat… on a task reads its first instruction, mode and brief checks', () => {
    loadMessages.mockReturnValue([
      { role: 'user', content: [{ type: 'text', text: 'Update the ' }, { type: 'text', text: 'changelog' }] },
      { role: 'assistant', content: 'ok' }
    ])
    loadStatus.mockReturnValue({ status: 'done', mode: 'ask' })
    readChecks.mockReturnValue([
      { id: 'c1', text: 'CHANGELOG.md updated', source: 'brief' },
      { id: 'c2', text: 'from the plan', source: 'plan' }
    ])
    const created = createSchedule({ workspacePath: ws, fromRunId: 'old-run', schedule: { kind: 'daily', time: '09:00' } })
    expect(created).toMatchObject({ instruction: 'Update the changelog', mode: 'ask', doneWhen: ['CHANGELOG.md updated'] })

    loadMessages.mockReturnValue([])
    expect(() =>
      createSchedule({ workspacePath: ws, fromRunId: 'empty', schedule: { kind: 'daily', time: '09:00' } })
    ).toThrow(/no instruction/)
  })
})

/** Let a scheduled worktree's awaited git step settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

function writeReceipt(runId: string, receipt: Record<string, unknown>): void {
  const dir = resolveRunDir(ws, runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipt))
}

describe('editing a schedule', () => {
  it('changes the brief, mode and model, and keeps the next run when the time is unchanged', () => {
    const created = daily()
    vi.setSystemTime(new Date(2026, 2, 5, 8, 30))
    const edited = updateSchedule({
      id: created.id,
      instruction: 'Summarize open PRs and issues',
      mode: 'ask',
      provider: 'anthropic',
      model: 'claude-test',
      schedule: { kind: 'daily', time: '09:00' }
    })
    expect(edited).toMatchObject({
      instruction: 'Summarize open PRs and issues',
      mode: 'ask',
      provider: 'anthropic',
      model: 'claude-test',
      nextRunAt: created.nextRunAt
    })
    // Null clears the pin: it runs on the default model again.
    const unpinned = updateSchedule({ id: created.id, provider: null, model: null })
    expect(unpinned.provider).toBeUndefined()
    expect(unpinned.model).toBeUndefined()
    // A new time is due from now.
    const moved = updateSchedule({ id: created.id, schedule: { kind: 'daily', time: '08:45' } })
    expect(moved.nextRunAt).toBe(new Date(2026, 2, 5, 8, 45).toISOString())
    resetScheduleStoreCache()
    expect(only()).toMatchObject({ instruction: 'Summarize open PRs and issues', mode: 'ask' })
  })

  it('turns a new worktree each run on and off, only for a git repository', () => {
    const created = daily()
    expect(updateSchedule({ id: created.id, worktree: true }).worktree).toBe(true)
    expect(updateSchedule({ id: created.id, worktree: false }).worktree).toBeUndefined()
    isGitRepo.mockReturnValue(false)
    expect(() => updateSchedule({ id: created.id, worktree: true })).toThrow(/git repository/)
    expect(only().worktree).toBeUndefined()
  })

  it('validates the edit: a provider needs a model, and null clears both', () => {
    const id = 'a0000000-0000-4000-8000-000000000001'
    expect(TaskScheduleUpdateRequestSchema.safeParse({ id, provider: 'anthropic' }).success).toBe(false)
    expect(TaskScheduleUpdateRequestSchema.safeParse({ id, provider: null, model: 'x' }).success).toBe(false)
    expect(TaskScheduleUpdateRequestSchema.safeParse({ id, provider: null, model: null }).success).toBe(true)
    expect(TaskScheduleUpdateRequestSchema.safeParse({ id, provider: 'anthropic', model: 'm', worktree: true }).success).toBe(
      true
    )
    expect(TaskScheduleUpdateRequestSchema.safeParse({ id, instruction: '   ' }).success).toBe(false)
  })
})

describe('the pinned model', () => {
  const fromRun = { workspacePath: ws, fromRunId: 'old-run', schedule: { kind: 'daily', time: '09:00' } as const }

  beforeEach(() => {
    loadMessages.mockReturnValue([{ role: 'user', content: 'Update the changelog' }])
    writeReceipt('old-run', { provider: 'anthropic', model: 'claude-test' })
  })

  it('Repeat… pins the model the task ran on, unless told otherwise', async () => {
    expect(createSchedule(fromRun)).toMatchObject({ provider: 'anthropic', model: 'claude-test' })
    const unpinned = createSchedule({ ...fromRun, provider: null, model: null })
    expect(unpinned.provider).toBeUndefined()
    expect(unpinned.model).toBeUndefined()
    expect(createSchedule({ ...fromRun, provider: 'openai', model: 'gpt-test' })).toMatchObject({
      provider: 'openai',
      model: 'gpt-test'
    })
    await expect(readScheduleSource(ws, 'old-run')).resolves.toMatchObject({
      instruction: 'Update the changelog',
      provider: 'anthropic',
      model: 'claude-test',
      canWorktree: true
    })
  })

  it('runs on the pin, and on the default model (said on the last run) once its provider has no key', () => {
    const created = createSchedule(fromRun)
    startTaskScheduler()
    vi.advanceTimersByTime(HOUR)
    expect(launchRunSync.mock.calls[0]![0]).toMatchObject({ provider: 'anthropic', model: 'claude-test' })
    expect(only().lastOutcome?.detail).toBeUndefined()

    providerHasCredentials.mockReturnValue(false)
    runScheduleNow(created.id)
    const req = launchRunSync.mock.calls[1]![0] as Record<string, unknown>
    expect(req.provider).toBeUndefined()
    expect(req.model).toBeUndefined()
    expect(only().lastOutcome).toMatchObject({ kind: 'started' })
    expect(only().lastOutcome?.detail).toMatch(/^Ran on the default model: Anthropic has no key set for claude-test/)
    // The pin itself is kept: a key added back runs on it again.
    expect(only()).toMatchObject({ provider: 'anthropic', model: 'claude-test' })
  })
})

describe('a new worktree each run', () => {
  const parent = ws
  const wt = join(userData, 'task-worktrees', 'summarize-open-prs')

  function worktreeSchedule(): TaskSchedule {
    return createSchedule({
      workspacePath: parent,
      instruction: 'Summarize open PRs',
      worktree: true,
      schedule: { kind: 'daily', time: '09:00' }
    })
  }

  beforeEach(() => {
    createTaskWorktree.mockResolvedValue({
      workspacePath: wt,
      worktreeRoot: wt,
      parentPath: parent,
      branch: 'vyotiq/summarize-open-prs',
      baseBranch: 'main',
      createdAt: new Date().toISOString()
    })
  })

  it('makes the worktree in main, has the window open it, then starts the run there', async () => {
    const created = worktreeSchedule()
    startTaskScheduler()
    vi.advanceTimersByTime(HOUR)
    // Due: the worktree is being made; nothing launched yet.
    expect(createTaskWorktree).toHaveBeenCalledWith(parent, 'Summarize open PRs')
    expect(only().lastOutcome).toMatchObject({ kind: 'starting' })
    expect(only().nextRunAt).toBe(new Date(2026, 2, 6, 9, 0).toISOString())
    expect(launchRunSync).not.toHaveBeenCalled()

    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    const [channel, request] = send.mock.calls[0] as [string, { token: string; workspacePath: string; branch: string }]
    expect(channel).toBe(IPC.schedulesWorktreeOpen)
    expect(request).toMatchObject({ scheduleId: created.id, workspacePath: wt, branch: 'vyotiq/summarize-open-prs' })

    const written = scheduledWorktreeOpened({ token: request.token })
    expect(launchRunSync).toHaveBeenCalledTimes(1)
    expect(launchRunSync.mock.calls[0]![0]).toMatchObject({
      workspacePath: wt,
      source: 'schedule',
      scheduled: { scheduleId: created.id, label: 'Daily at 09:00' }
    })
    expect(written).toMatchObject({ lastRunId: 'run-1', lastOutcome: { kind: 'started', runId: 'run-1' } })
    expect(written?.lastOutcome?.detail).toBe('In vyotiq/summarize-open-prs')
    // The schedule stays on the parent: the next run branches a new worktree from it.
    expect(written?.workspacePath).toBe(parent)
    // A token is answered once.
    expect(() => scheduledWorktreeOpened({ token: request.token })).toThrow(/waiting/)
  })

  it('skips a due time while the last run is still starting', async () => {
    const created = worktreeSchedule()
    runScheduleNow(created.id)
    expect(runScheduleNow(created.id).lastOutcome).toMatchObject({ kind: 'skipped', detail: 'The last run was still starting' })
    expect(createTaskWorktree).toHaveBeenCalledTimes(1)
    await flush()
  })

  it('records why it did not start: no window, git refused, the window could not open it, or never answered', async () => {
    const created = worktreeSchedule()

    resolveRunWebContents.mockReturnValue(null)
    expect(runScheduleNow(created.id).lastOutcome).toMatchObject({ kind: 'failed', detail: 'Needs the window open' })
    expect(createTaskWorktree).not.toHaveBeenCalled()
    resolveRunWebContents.mockReturnValue({ id: 1, send })

    createTaskWorktree.mockRejectedValueOnce(new Error('This folder is not a git repository'))
    runScheduleNow(created.id)
    await flush()
    expect(only().lastOutcome).toMatchObject({ kind: 'failed', detail: 'This folder is not a git repository' })

    runScheduleNow(created.id)
    await flush()
    const token = (send.mock.calls.at(-1)![1] as { token: string }).token
    scheduledWorktreeOpened({ token, error: 'Workspace not found' })
    expect(only().lastOutcome?.kind).toBe('failed')
    expect(only().lastOutcome?.detail).toMatch(/^Made the worktree vyotiq\/summarize-open-prs, but couldn’t open it: Workspace not found/)

    runScheduleNow(created.id)
    await flush()
    vi.advanceTimersByTime(WORKTREE_OPEN_TIMEOUT_MS)
    expect(only().lastOutcome?.detail).toMatch(/the window didn’t open it/)
    expect(launchRunSync).not.toHaveBeenCalled()
  })

  it('a start cut off by quitting reads as not started next time', () => {
    const created = worktreeSchedule()
    writeSchedules([{ ...created, lastOutcome: { kind: 'starting', at: new Date().toISOString(), detail: 'Making a new worktree' } }])
    resetScheduleStoreCache()
    startTaskScheduler()
    expect(only().lastOutcome).toMatchObject({ kind: 'failed', detail: 'Agent V closed before it started' })
  })

  it('Repeat… on a task that ran in its own worktree branches from that worktree’s parent', async () => {
    const taskWorktree = join(userData, 'task-worktrees', 'old')
    openPaths.push(taskWorktree)
    findTaskWorktree.mockResolvedValue({
      workspacePath: taskWorktree,
      worktreeRoot: taskWorktree,
      parentPath: parent,
      branch: 'vyotiq/old',
      baseBranch: 'main',
      createdAt: new Date().toISOString()
    })
    loadMessages.mockReturnValue([{ role: 'user', content: 'Fix the flaky test' }])
    await expect(readScheduleSource(taskWorktree, 'r-old')).resolves.toMatchObject({
      worktreeBranch: 'vyotiq/old',
      canWorktree: true
    })
    const inNew = await createScheduleFromRequest({
      workspacePath: taskWorktree,
      fromRunId: 'r-old',
      worktree: true,
      schedule: { kind: 'daily', time: '09:00' }
    })
    expect(inNew).toMatchObject({ workspacePath: parent, worktree: true, instruction: 'Fix the flaky test' })
    // Unticked: it repeats where the task ran, as before.
    const inPlace = await createScheduleFromRequest({
      workspacePath: taskWorktree,
      fromRunId: 'r-old',
      schedule: { kind: 'daily', time: '09:00' }
    })
    expect(inPlace.workspacePath).toBe(taskWorktree)
    expect(inPlace.worktree).toBeUndefined()

    isGitRepo.mockReturnValue(false)
    await expect(
      createScheduleFromRequest({ workspacePath: ws, instruction: 'x', worktree: true, schedule: { kind: 'daily', time: '09:00' } })
    ).rejects.toThrow(/git repository/)
  })
})

describe('schedule store', () => {
  it('round-trips through disk, newest first', () => {
    const a = daily('09:00')
    vi.setSystemTime(new Date(2026, 2, 5, 8, 5))
    const b = daily('10:00')
    resetScheduleStoreCache()
    expect(listSchedules().map((s) => s.id)).toEqual([b.id, a.id])
    const onDisk = JSON.parse(readFileSync(schedulesPath(), 'utf8')) as { version: number; schedules: unknown[] }
    expect(onDisk.version).toBe(1)
    expect(onDisk.schedules).toHaveLength(2)
  })

  it('fills defaults for an older entry and drops a damaged one', () => {
    const parsed = parseSchedulesFile({
      version: 1,
      schedules: [
        {
          id: 'a0000000-0000-4000-8000-000000000001',
          workspacePath: ws,
          instruction: 'Old entry',
          schedule: { kind: 'daily', time: '09:00' },
          createdAt: '2026-03-01T00:00:00.000Z'
        },
        { id: 'bad', workspacePath: ws },
        { ...{ id: 'a0000000-0000-4000-8000-000000000002', workspacePath: ws, instruction: 'x', createdAt: 'x' }, schedule: { kind: 'interval', minutes: 1 } }
      ]
    })
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ mode: 'agent', enabled: true })
    expect(parseSchedulesFile(null)).toEqual([])
  })

  it('sets an unreadable file aside instead of failing', () => {
    mkdirSync(userData, { recursive: true })
    writeFileSync(schedulesPath(), '{ not json')
    resetScheduleStoreCache()
    expect(readSchedules()).toEqual([])
    expect(existsSync(schedulesPath())).toBe(false)
    expect(readdirSync(userData).some((name) => name.startsWith('schedules.json.corrupt-'))).toBe(true)
  })
})

describe('schedule IPC validation', () => {
  const schedule = { kind: 'daily', time: '09:00' }

  it('takes a brief or a task, never both or neither', () => {
    expect(TaskScheduleCreateRequestSchema.safeParse({ workspacePath: ws, instruction: 'x', schedule }).success).toBe(true)
    expect(TaskScheduleCreateRequestSchema.safeParse({ workspacePath: ws, fromRunId: 'r1', schedule }).success).toBe(true)
    expect(
      TaskScheduleCreateRequestSchema.safeParse({ workspacePath: ws, instruction: 'x', fromRunId: 'r1', schedule }).success
    ).toBe(false)
    expect(TaskScheduleCreateRequestSchema.safeParse({ workspacePath: ws, schedule }).success).toBe(false)
    expect(TaskScheduleCreateRequestSchema.safeParse({ workspacePath: '', instruction: 'x', schedule }).success).toBe(false)
  })

  it('refuses bad times, empty weeks, short intervals and bad cron', () => {
    const bad = [
      { kind: 'daily', time: '9:00' },
      { kind: 'daily', time: '24:00' },
      { kind: 'weekly', days: [], time: '09:00' },
      { kind: 'weekly', days: [7], time: '09:00' },
      { kind: 'interval', minutes: 14 },
      { kind: 'interval', minutes: 15.5 },
      { kind: 'cron', expr: '* * *' },
      { kind: 'cron', expr: '0 0 30 2 *' },
      { kind: 'hourly' }
    ]
    for (const spec of bad) expect(TaskScheduleSpecSchema.safeParse(spec).success, JSON.stringify(spec)).toBe(false)
    const weekly = TaskScheduleSpecSchema.parse({ kind: 'weekly', days: [5, 1, 5], time: '09:00' })
    expect(weekly).toEqual({ kind: 'weekly', days: [1, 5], time: '09:00' })
    expect(TaskScheduleSpecSchema.safeParse({ kind: 'interval', minutes: 15 }).success).toBe(true)
    expect(TaskScheduleSpecSchema.safeParse({ kind: 'cron', expr: '@daily' }).success).toBe(true)
  })

  it('ids must look like ids', () => {
    expect(TaskScheduleToggleRequestSchema.safeParse({ id: '../x', enabled: true }).success).toBe(false)
    expect(TaskScheduleToggleRequestSchema.safeParse({ id: 'a0000000-0000-4000-8000-000000000001', enabled: 'yes' }).success).toBe(
      false
    )
    expect(TaskScheduleUpdateRequestSchema.safeParse({ id: 'a0000000-0000-4000-8000-000000000001', mode: 'plan' }).data?.mode).toBe(
      'agent'
    )
  })
})
