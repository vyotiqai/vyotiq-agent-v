import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tmpRoot = mkdtempSync(join(tmpdir(), 'vyotiq-tasks-'))
const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-tasks-ws-'))

const statusHolder: { value: { status: string; error?: string; updatedAt: string } | null } = {
  value: null
}
const startedInputs: Array<{ runId: string; agentInput: { agentProfileId?: string; messages?: Array<{ content: string }> } }> = []
let runIdSeq = 0

vi.mock('electron', () => ({
  app: { getPath: () => tmpRoot },
  BrowserWindow: class {}
}))
const pushes: Array<{ channel: string; payload: unknown }> = []
vi.mock('@main/app/window', () => ({
  getMainWindow: () => ({
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => {
        pushes.push({ channel, payload })
      }
    }
  })
}))
vi.mock('@main/agent/loop', () => ({
  createRunId: () => {
    runIdSeq += 1
    return `run-${runIdSeq}`
  }
}))
vi.mock('@main/agent/state', () => ({
  loadStatus: vi.fn(() => statusHolder.value)
}))
vi.mock('@main/storage/paths', () => ({
  resolveRunDir: (workspacePath: string, runId: string) => join(workspacePath, runId)
}))
vi.mock('@main/agent/startAgentRun', () => ({
  startAgentRunInBackground: vi.fn((input: {
    runId: string
    agentInput: { agentProfileId?: string; messages?: Array<{ content: string }> }
  }) => {
    startedInputs.push(input)
  })
}))
vi.mock('@main/workspace/workspaces', () => ({
  getWorkspaces: () => ({ openPaths: [workspace] })
}))
vi.mock('@main/settings/agentProfiles', () => ({
  resolveAgentProfile: vi.fn((_ws: string, profileId: string) =>
    profileId === 'scout' ? { id: 'scout', name: 'Scout' } : null
  )
}))

import { clearRunAbort } from '@main/agent/runRegistry'
import {
  cancelTask,
  cancelTasksForProfile,
  enqueueTask,
  listTasks,
  resetTaskSchedulerForTests,
  resumeTasksForWorkspaces,
  retryTask
} from '@main/agent/taskScheduler'

beforeEach(() => {
  vi.useFakeTimers()
  statusHolder.value = null
  startedInputs.length = 0
  runIdSeq = 0
  pushes.length = 0
  resetTaskSchedulerForTests()
  rmSync(join(workspace, '.vyotiq'), { recursive: true, force: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('delegated task scheduler', () => {
  it('starts an immediate task through the chatStart path', () => {
    const task = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'Do the thing' })
    expect(task.status).toBe('running')
    expect(task.runId).toBe('run-1')
    expect(startedInputs).toHaveLength(1)
    expect(startedInputs[0]!.agentInput.agentProfileId).toBe('scout')
    expect(startedInputs[0]!.agentInput.messages?.[0]?.content).toBe('Do the thing')
  })

  it('serializes one running task per profile and pumps the queue on completion', async () => {
    const first = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'first' })
    const second = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'second' })
    expect(first.status).toBe('running')
    expect(second.status).toBe('queued')

    // Run 1 finishes → the queued task starts. Clearing the registry entry
    // mirrors the loop's finally (production runs always clear their slot).
    statusHolder.value = { status: 'done', updatedAt: new Date().toISOString() }
    clearRunAbort(first.runId!)
    await vi.advanceTimersByTimeAsync(5_100)

    const tasks = listTasks()
    expect(tasks.find((t) => t.id === first.id)?.status).toBe('done')
    expect(tasks.find((t) => t.id === second.id)?.status).toBe('running')
    expect(startedInputs).toHaveLength(2)
    expect(startedInputs[1]!.agentInput.messages?.[0]?.content).toBe('second')
  })

  it('marks failed runs with the run error', async () => {
    const task = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'boom' })
    statusHolder.value = { status: 'error', error: 'provider exploded', updatedAt: new Date().toISOString() }
    await vi.advanceTimersByTimeAsync(5_100)
    const stored = listTasks().find((t) => t.id === task.id)
    expect(stored?.status).toBe('failed')
    expect(stored?.error).toBe('provider exploded')
  })

  it('honors scheduledAt and fires when due', async () => {
    const at = new Date(Date.now() + 60_000).toISOString()
    const task = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'later', scheduledAt: at })
    expect(task.status).toBe('scheduled')
    expect(startedInputs).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(60_100)
    const stored = listTasks().find((t) => t.id === task.id)
    expect(stored?.status).toBe('running')
    expect(startedInputs).toHaveLength(1)
  })

  it('persists tasks to .vyotiq/tasks.json', () => {
    enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'persisted' })
    const raw = JSON.parse(readFileSync(join(workspace, '.vyotiq', 'tasks.json'), 'utf8')) as {
      tasks: Array<{ prompt: string }>
    }
    expect(raw.tasks).toHaveLength(1)
    expect(raw.tasks[0]!.prompt).toBe('persisted')
  })

  it('cancels a queued task and a running run', () => {
    const running = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'running' })
    const queued = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'queued' })

    expect(cancelTask(queued.id)).toBe(true)
    expect(listTasks().find((t) => t.id === queued.id)?.status).toBe('cancelled')

    expect(cancelTask(running.id)).toBe(true)
    // Running cancellation goes through cancelRun. The task parks in the
    // durable `cancelling` state so a restart mid-cancel resumes as stopping
    // rather than reviving it as running; reconciliation finalizes it.
    expect(listTasks().find((t) => t.id === running.id)?.status).toBe('cancelling')
  })

  it('re-arms scheduled tasks at boot and starts past-due ones', async () => {
    const future = new Date(Date.now() + 120_000).toISOString()
    const dir = join(workspace, '.vyotiq')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'tasks.json'),
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: 'task-past',
            profileId: 'scout',
            workspacePath: workspace,
            prompt: 'past due',
            status: 'scheduled',
            scheduledAt: new Date(Date.now() - 5_000).toISOString(),
            createdAt: new Date().toISOString()
          },
          {
            id: 'task-future',
            profileId: 'scout',
            workspacePath: workspace,
            prompt: 'still scheduled',
            status: 'scheduled',
            scheduledAt: future,
            createdAt: new Date().toISOString()
          }
        ]
      }),
      'utf8'
    )

    await resumeTasksForWorkspaces([workspace])
    const tasks = listTasks()
    expect(tasks.find((t) => t.id === 'task-past')?.status).toBe('running')
    expect(tasks.find((t) => t.id === 'task-future')?.status).toBe('scheduled')
  })

  it('rejects unknown profiles and non-open workspaces', () => {
    expect(() =>
      enqueueTask({ profileId: 'ghost', workspacePath: workspace, prompt: 'x' })
    ).toThrow('Unknown teammate profile')
    expect(() =>
      enqueueTask({ profileId: 'scout', workspacePath: join(tmpRoot, 'closed-ws'), prompt: 'x' })
    ).toThrow('Workspace is not open')
  })

  it('re-arms far-future schedules in chunks instead of firing early', async () => {
    const MAX_TIMEOUT_MS = 2 ** 31 - 1
    const at = new Date(Date.now() + MAX_TIMEOUT_MS + 60_000).toISOString()
    const task = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'far out', scheduledAt: at })
    expect(task.status).toBe('scheduled')

    // The first ~24.9-day chunk must NOT fire the task.
    await vi.advanceTimersByTimeAsync(MAX_TIMEOUT_MS)
    let stored = listTasks().find((t) => t.id === task.id)
    expect(stored?.status).toBe('scheduled')
    expect(stored?.scheduledAt).toBe(at)
    expect(startedInputs).toHaveLength(0)

    // The re-armed remainder fires on time.
    await vi.advanceTimersByTimeAsync(60_500)
    stored = listTasks().find((t) => t.id === task.id)
    expect(stored?.status).toBe('running')
    expect(startedInputs).toHaveLength(1)
  })

  it('finalizes stale running tasks at boot from the durable run status', async () => {
    const dir = join(workspace, '.vyotiq')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'tasks.json'),
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: 'task-stale-cancelled',
            profileId: 'scout',
            workspacePath: workspace,
            prompt: 'orphaned by restart',
            status: 'running',
            runId: 'run-orphan',
            createdAt: new Date().toISOString()
          }
        ]
      }),
      'utf8'
    )
    // Boot orphan-reconciliation flips interrupted runs to cancelled+resumable.
    statusHolder.value = { status: 'cancelled', updatedAt: new Date().toISOString() }
    await resumeTasksForWorkspaces([workspace])
    const stored = listTasks().find((t) => t.id === 'task-stale-cancelled')
    expect(stored?.status).toBe('cancelled')
    expect(stored?.finishedAt).toBeTruthy()
  })

  it('fails stale running tasks whose run dir never produced a status', async () => {
    const dir = join(workspace, '.vyotiq')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'tasks.json'),
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: 'task-stale-nostatus',
            profileId: 'scout',
            workspacePath: workspace,
            prompt: 'never started',
            status: 'running',
            createdAt: new Date().toISOString()
          }
        ]
      }),
      'utf8'
    )
    statusHolder.value = null
    await resumeTasksForWorkspaces([workspace])
    const stored = listTasks().find((t) => t.id === 'task-stale-nostatus')
    expect(stored?.status).toBe('failed')
    expect(stored?.error).toContain('restart')
  })

  it('holds queued tasks for closed workspaces until they reopen', async () => {
    const closedWs = mkdtempSync(join(tmpdir(), 'vyotiq-tasks-closed-'))
    try {
      const dir = join(closedWs, '.vyotiq')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'tasks.json'),
        JSON.stringify({
          version: 1,
          tasks: [
            {
              id: 'task-closed-ws',
              profileId: 'scout',
              workspacePath: closedWs,
              prompt: 'waiting for its workspace',
              status: 'queued',
              createdAt: new Date().toISOString()
            }
          ]
        }),
        'utf8'
      )

      // Only `workspace` is open — the closed workspace's task must not start.
      await resumeTasksForWorkspaces([closedWs])
      expect(startedInputs).toHaveLength(0)
      expect(
        listTasks().find((t) => t.id === 'task-closed-ws')?.status
      ).toBe('queued')
    } finally {
      rmSync(closedWs, { recursive: true, force: true })
    }
  })

  it('frees the teammate slot when a run never writes a status', async () => {
    const first = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'status never appears' })
    const second = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'next in queue' })
    expect(first.status).toBe('running')
    expect(second.status).toBe('queued')
    // The simulated crash unwound before the loop's try — startAgentRun's
    // finally still clears the registry slot (production safety net).
    clearRunAbort(first.runId!)

    // 12 missing-status polls (60s) — the backstop finalizes and re-pumps.
    await vi.advanceTimersByTimeAsync(61_000)
    const storedFirst = listTasks().find((t) => t.id === first.id)
    expect(storedFirst?.status).toBe('failed')
    expect(storedFirst?.error).toContain('status unavailable')
    expect(listTasks().find((t) => t.id === second.id)?.status).toBe('running')
    expect(startedInputs).toHaveLength(2)
  })

  it('does not let a closed workspace queue block an open one for the same teammate', async () => {
    const closedWs = mkdtempSync(join(tmpdir(), 'vyotiq-tasks-blocked-'))
    try {
      // Older task, closed workspace: it cannot start, and it must not stop
      // the newer task in the workspace that IS open from starting either.
      mkdirSync(join(closedWs, '.vyotiq'), { recursive: true })
      writeFileSync(
        join(closedWs, '.vyotiq', 'tasks.json'),
        JSON.stringify({
          version: 1,
          tasks: [
            {
              id: 'task-older-closed',
              profileId: 'scout',
              workspacePath: closedWs,
              prompt: 'older, unreachable',
              status: 'queued',
              createdAt: '2020-01-01T00:00:00.000Z'
            }
          ]
        }),
        'utf8'
      )
      // Load the closed workspace FIRST, so its task is a live pump candidate
      // by the time the reachable one is assigned — that is the ordering that
      // used to deadlock the teammate.
      await resumeTasksForWorkspaces([closedWs])
      expect(startedInputs).toHaveLength(0)

      const open = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'newer, reachable' })

      expect(startedInputs.map((i) => i.agentInput.messages?.[0]?.content)).toContain(
        'newer, reachable'
      )
      expect(listTasks().find((t) => t.id === open.id)?.status).toBe('running')
      expect(listTasks().find((t) => t.id === 'task-older-closed')?.status).toBe('queued')
    } finally {
      rmSync(closedWs, { recursive: true, force: true })
    }
  })

  it('pushes newly loaded workspace tasks even when nothing transitions', async () => {
    const otherWs = mkdtempSync(join(tmpdir(), 'vyotiq-tasks-quiet-'))
    try {
      // Future-scheduled tasks only re-arm a timer. Without a push the row
      // never reaches the renderer, which pulls the list only once on mount.
      mkdirSync(join(otherWs, '.vyotiq'), { recursive: true })
      writeFileSync(
        join(otherWs, '.vyotiq', 'tasks.json'),
        JSON.stringify({
          version: 1,
          tasks: [
            {
              id: 'task-far-future',
              profileId: 'scout',
              workspacePath: otherWs,
              prompt: 'much later',
              status: 'scheduled',
              scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              createdAt: new Date().toISOString()
            }
          ]
        }),
        'utf8'
      )

      await resumeTasksForWorkspaces([otherWs])

      const pushed = pushes.filter((p) => p.channel === 'tasks:changed')
      expect(pushed).toHaveLength(1)
      expect(
        (pushed[0]!.payload as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id)
      ).toContain('task-far-future')
    } finally {
      rmSync(otherWs, { recursive: true, force: true })
    }
  })

  it('cancels a deleted teammate tasks in workspaces that are not open', () => {
    const closedWs = mkdtempSync(join(tmpdir(), 'vyotiq-tasks-cascade-'))
    try {
      mkdirSync(join(closedWs, '.vyotiq'), { recursive: true })
      writeFileSync(
        join(closedWs, '.vyotiq', 'tasks.json'),
        JSON.stringify({
          version: 1,
          tasks: [
            {
              id: 'task-closed-cascade',
              profileId: 'scout',
              workspacePath: closedWs,
              prompt: 'assigned to a teammate about to be deleted',
              status: 'queued',
              createdAt: new Date().toISOString()
            }
          ]
        }),
        'utf8'
      )

      // The cascade passes every path the install knows, not just open ones.
      expect(cancelTasksForProfile('scout', [closedWs])).toBe(1)

      const task = listTasks().find((t) => t.id === 'task-closed-cascade')
      expect(task?.status).toBe('cancelled')
      expect(task?.error).toBe('Teammate deleted')
    } finally {
      rmSync(closedWs, { recursive: true, force: true })
    }
  })

  it('moves a corrupt tasks.json aside instead of wiping it on the next save', () => {
    const dir = join(workspace, '.vyotiq')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'tasks.json'), '{corrupt', 'utf8')

    enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'after corruption' })
    const backups = readdirSync(dir).filter((name) => name.startsWith('tasks.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dir, backups[0]!), 'utf8')).toBe('{corrupt')
    const fresh = JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8')) as { tasks: unknown[] }
    expect(fresh.tasks).toHaveLength(1)
  })

  it('preserves a corrupt tasks.json on the async boot path too', async () => {
    // Boot reads through the async reader, not loadTasks. Without its own
    // rename-aside the first save after boot would silently wipe the file.
    const dir = join(workspace, '.vyotiq')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'tasks.json'), '{corrupt', 'utf8')

    await resumeTasksForWorkspaces([workspace])

    const backups = readdirSync(dir).filter((name) => name.startsWith('tasks.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dir, backups[0]!), 'utf8')).toBe('{corrupt')
    expect(listTasks()).toEqual([])
  })

  it('treats a workspace with no tasks.json as an empty queue, not a fault', async () => {
    // ENOENT is the common case for a fresh workspace; it must not be logged
    // as a read failure or move a non-existent file aside.
    await resumeTasksForWorkspaces([workspace])

    expect(listTasks()).toEqual([])
    const dir = join(workspace, '.vyotiq')
    const backups = existsSync(dir)
      ? readdirSync(dir).filter((name) => name.startsWith('tasks.json.corrupt-'))
      : []
    expect(backups).toEqual([])
  })

  it('keeps reconciling after one resume pass fails', async () => {
    // The resume passes share a promise chain. A rejection left on it would be
    // inherited by every later pass, so one bad workspace would permanently
    // stop reconciliation — and surface as an unhandled rejection.
    const dir = join(workspace, '.vyotiq')
    mkdirSync(dir, { recursive: true })
    const now = new Date().toISOString()
    writeFileSync(
      join(dir, 'tasks.json'),
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: 'task-stale',
            profileId: 'scout',
            workspacePath: workspace,
            prompt: 'left running by a dead process',
            status: 'running',
            runId: 'run-stale',
            createdAt: now,
            startedAt: now
          }
        ]
      }),
      'utf8'
    )
    const loadStatusMock = vi.mocked((await import("@main/agent/state")).loadStatus)
    loadStatusMock.mockImplementationOnce(() => {
      throw new Error('run dir exploded')
    })

    // First pass throws and is absorbed.
    await resumeTasksForWorkspaces([workspace])
    expect(loadStatusMock).toHaveBeenCalled()
    // Proves the pass really aborted rather than passing vacuously: the
    // orphan is still unreconciled.
    expect(listTasks().find((t) => t.id === 'task-stale')?.status).toBe('running')

    // Second pass must still run and finalize the orphan.
    resetTaskSchedulerForTests()
    statusHolder.value = { status: 'done', updatedAt: now }
    await resumeTasksForWorkspaces([workspace])
    expect(listTasks().find((t) => t.id === 'task-stale')?.status).toBe('done')
  })

  it('refuses to acknowledge an enqueue whose write failed', () => {
    // A regular file where the .vyotiq directory belongs makes the atomic
    // write fail with ENOTDIR. The cache-first store logged that and returned
    // a task that only ever existed in memory — the row vanished on restart.
    writeFileSync(join(workspace, '.vyotiq'), 'not a directory', 'utf8')
    expect(() =>
      enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'never persisted' })
    ).toThrow()
    expect(listTasks()).toHaveLength(0)
    expect(startedInputs).toHaveLength(0)
  })

  it('does not start a delegated run while the teammate is busy elsewhere', () => {
    const first = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'first' })
    expect(first.status).toBe('running')
    // A second task for the same teammate must wait: two concurrent runs would
    // interleave writes to one memory namespace. The claim is taken atomically
    // with the run registration, so no window exists where both see it free.
    const second = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'second' })
    expect(second.status).toBe('queued')
    expect(startedInputs).toHaveLength(1)
  })

  it('rebuilds the completion watcher for a run still live after re-arm', async () => {
    const task = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'in flight' })
    expect(task.status).toBe('running')
    // Simulate a re-arm (workspace reopen) while the run is still active: the
    // watcher and teammate claim live only in memory, so they must be rebuilt
    // or the run finishes with nothing listening and the task sticks forever.
    await resumeTasksForWorkspaces([workspace])
    expect(listTasks().find((t) => t.id === task.id)?.status).toBe('running')

    statusHolder.value = { status: 'done', updatedAt: new Date().toISOString() }
    clearRunAbort(task.runId!)
    await vi.advanceTimersByTimeAsync(5_100)
    expect(listTasks().find((t) => t.id === task.id)?.status).toBe('done')
  })

  it('keeps the run id on a finished task so its transcript stays reachable', async () => {
    const task = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'linked' })
    statusHolder.value = { status: 'done', updatedAt: new Date().toISOString() }
    clearRunAbort(task.runId!)
    await vi.advanceTimersByTimeAsync(5_100)
    const done = listTasks().find((t) => t.id === task.id)
    expect(done?.status).toBe('done')
    expect(done?.runId).toBe(task.runId)
  })

  it('keeps the run id when a restart finalizes an orphaned task', async () => {
    const dir = join(workspace, '.vyotiq')
    mkdirSync(dir, { recursive: true })
    const now = new Date().toISOString()
    writeFileSync(
      join(dir, 'tasks.json'),
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: 'task-orphan-link',
            profileId: 'scout',
            workspacePath: workspace,
            prompt: 'orphaned',
            status: 'running',
            runId: 'run-orphan',
            startedAt: now,
            createdAt: now
          }
        ]
      }),
      'utf8'
    )
    statusHolder.value = { status: 'done', updatedAt: now }
    await resumeTasksForWorkspaces([workspace])
    const stored = listTasks().find((t) => t.id === 'task-orphan-link')
    expect(stored?.status).toBe('done')
    expect(stored?.runId).toBe('run-orphan')
  })

  it('answers false when cancelling a task whose run is already gone', () => {
    const task = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'raced' })
    // The run finished naturally between the click and the handler.
    statusHolder.value = { status: 'done', updatedAt: new Date().toISOString() }
    clearRunAbort(task.runId!)
    // cancelRun answers false — reporting true would claim we stopped work
    // that had already completed.
    expect(cancelTask(task.id)).toBe(false)
    expect(listTasks().find((t) => t.id === task.id)?.status).toBe('done')
  })

  it('retries a terminal task as a new record and keeps the original', async () => {
    const task = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'retry me' })
    statusHolder.value = {
      status: 'error',
      error: 'provider exploded',
      updatedAt: new Date().toISOString()
    }
    clearRunAbort(task.runId!)
    await vi.advanceTimersByTimeAsync(5_100)
    expect(listTasks().find((t) => t.id === task.id)?.status).toBe('failed')

    const clone = retryTask(task.id)
    expect(clone.id).not.toBe(task.id)
    expect(clone.prompt).toBe('retry me')
    // Provenance: without this link a retry is indistinguishable from a
    // fresh assignment, and retention can prune the attempt that failed
    // while keeping the retry that replaced it.
    expect(clone.retryOf).toBe(task.id)
    // The failed attempt stays in history — a task is an audited unit of work.
    expect(listTasks().find((t) => t.id === task.id)?.status).toBe('failed')
    expect(() => retryTask(clone.id)).toThrow('finished')
  })

  it('does not let an enqueue request forge a retry link', () => {
    // `retryOf` is an internal second argument, never a request field. If a
    // renderer could set it, the audit chain would be caller-controlled.
    const task = enqueueTask({
      profileId: 'scout',
      workspacePath: workspace,
      prompt: 'not a retry',
      retryOf: 'task-forged'
    } as unknown as Parameters<typeof enqueueTask>[0])
    expect(task.retryOf).toBeUndefined()
  })

  it('repairs legacy rows instead of dropping the work they represent', async () => {
    const dir = join(workspace, '.vyotiq')
    mkdirSync(dir, { recursive: true })
    const now = new Date().toISOString()
    writeFileSync(
      join(dir, 'tasks.json'),
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: 'legacy-running',
            profileId: 'scout',
            workspacePath: workspace,
            prompt: 'legacy running without startedAt',
            status: 'running',
            runId: 'run-legacy',
            createdAt: now
          },
          {
            id: 'legacy-foreign',
            profileId: 'scout',
            workspacePath: join(tmpdir(), 'somewhere-else'),
            prompt: 'row claiming another workspace',
            status: 'queued',
            createdAt: now
          }
        ]
      }),
      'utf8'
    )
    statusHolder.value = { status: 'done', updatedAt: now }
    await resumeTasksForWorkspaces([workspace])
    const ids = listTasks().map((t) => t.id)
    expect(ids).toContain('legacy-running')
    expect(ids).toContain('legacy-foreign')
    // Re-homed, so a later write cannot save it into another workspace's file.
    expect(listTasks().find((t) => t.id === 'legacy-foreign')?.workspacePath).toBe(workspace)
  })

  it('ignores a tasks.json written by a newer version instead of parsing it', async () => {
    const dir = join(workspace, '.vyotiq')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'tasks.json'),
      JSON.stringify({ version: 99, tasks: [{ id: 'from-the-future' }] }),
      'utf8'
    )
    await resumeTasksForWorkspaces([workspace])
    expect(listTasks()).toHaveLength(0)
  })
})
